// Routine schedule persistence: the store behind routine_configure / routine_status /
// routine_cancel and the scheduler's tick loop. When a session (or the user, via the settings
// panel) registers a recurring task, the schedule lands in a JSON file next to the session
// (same pattern as context-summary chunks). The main process is the single writer, and every
// mutation goes through atomic write (temp file + rename) so a crash mid-write can never leave
// a torn file.

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import type {
  RoutineConfigureRequest,
  RoutinePauseReason,
  RoutineSchedule,
  RoutineTickResult
} from '../../shared/routine'
import {
  ROUTINE_MAX_EVERY_MINUTES,
  ROUTINE_MIN_EVERY_MINUTES
} from '../../shared/routine'

const ROUTINES_DIR = '.routines'
const ROUTINES_FILE = 'routines.json'
const MAX_RESULTS_PER_SCHEDULE = 8

export class RoutineValidationError extends Error {
  readonly code: 'invalid_interval' | 'empty_instruction' | 'not_found'

  constructor(code: RoutineValidationError['code'], message: string) {
    super(message)
    this.name = 'RoutineValidationError'
    this.code = code
  }
}

const resolveRoutinesRoot = (root: string, sessionId: string): string => {
  const candidate = resolve(root, 'artifacts', encodeURIComponent(sessionId), ROUTINES_DIR)
  const fromRoot = relative(resolve(root), candidate)
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error('Invalid routine storage key.')
  }
  return candidate
}

const parseRoutines = (raw: string): RoutineSchedule[] => {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.filter(isRoutineSchedule)
    return []
  } catch {
    return []
  }
}

const isRoutineSchedule = (value: unknown): value is RoutineSchedule => {
  if (typeof value !== 'object' || value === null) return false
  const schedule = value as Record<string, unknown>
  return (
    typeof schedule.id === 'string' &&
    typeof schedule.sessionId === 'string' &&
    typeof schedule.instruction === 'string' &&
    typeof schedule.everyMinutes === 'number' &&
    typeof schedule.enabled === 'boolean' &&
    typeof schedule.createdAt === 'number'
  )
}

const normalizeInterval = (everyMinutes: number): number => {
  if (!Number.isInteger(everyMinutes) || everyMinutes < ROUTINE_MIN_EVERY_MINUTES) {
    throw new RoutineValidationError(
      'invalid_interval',
      `every_minutes must be an integer >= ${ROUTINE_MIN_EVERY_MINUTES}`
    )
  }
  if (everyMinutes > ROUTINE_MAX_EVERY_MINUTES) {
    throw new RoutineValidationError(
      'invalid_interval',
      `every_minutes must be <= ${ROUTINE_MAX_EVERY_MINUTES}`
    )
  }
  return everyMinutes
}

const normalizeInstruction = (instruction: string): string => {
  const trimmed = instruction.trim()
  if (!trimmed) {
    throw new RoutineValidationError('empty_instruction', 'instruction must not be empty')
  }
  return trimmed
}

export type RoutineRepositoryOptions = {
  storageRoot: string
  createId?: () => string
  now?: () => number
}

export class RoutineRepository {
  private readonly createId: () => string
  private readonly now: () => number

  constructor(private readonly options: RoutineRepositoryOptions) {
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.now = options.now ?? (() => Date.now())
  }

  private routinesPath(sessionId: string): string {
    return join(resolveRoutinesRoot(this.options.storageRoot, sessionId), ROUTINES_FILE)
  }

  private async readRoutines(sessionId: string): Promise<RoutineSchedule[]> {
    try {
      const raw = await readFile(this.routinesPath(sessionId), 'utf8')
      return parseRoutines(raw)
    } catch {
      return []
    }
  }

  private async writeRoutines(sessionId: string, schedules: RoutineSchedule[]): Promise<void> {
    const target = this.routinesPath(sessionId)
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.${this.createId()}.tmp`
    await writeFile(temp, JSON.stringify(schedules, null, 2), { encoding: 'utf8', flag: 'wx' })
    await rename(temp, target)
  }

  // Creates or updates a schedule. Passing a routineId that exists updates it in place (label,
  // instruction, interval, and re-enable); an unknown routineId is an error.
  async upsert(
    sessionId: string,
    request: RoutineConfigureRequest
  ): Promise<RoutineSchedule> {
    const everyMinutes = normalizeInterval(request.everyMinutes)
    const instruction = normalizeInstruction(request.instruction)
    const now = this.now()
    const label = request.label?.trim() || undefined

    const schedules = await this.readRoutines(sessionId)

    if (request.routineId) {
      const index = schedules.findIndex((schedule) => schedule.id === request.routineId)
      if (index === -1) {
        throw new RoutineValidationError(
          'not_found',
          `No routine with id ${request.routineId} exists for this session.`
        )
      }
      const previous = schedules[index]
      const updated: RoutineSchedule = {
        ...previous,
        label: label ?? previous.label,
        instruction,
        everyMinutes,
        enabled: true,
        pausedReason: null,
        nextDue: now + everyMinutes * 60_000,
        idleStreak: 0,
        updatedAt: now
      }
      schedules[index] = updated
      await this.writeRoutines(sessionId, schedules)
      return updated
    }

    const created: RoutineSchedule = {
      id: this.createId(),
      sessionId,
      label,
      instruction,
      everyMinutes,
      enabled: true,
      nextDue: now + everyMinutes * 60_000,
      lastFireAt: null,
      lastOkAt: null,
      tickCount: 0,
      missedTicks: 0,
      idleStreak: 0,
      pausedReason: null,
      lastResults: [],
      createdAt: now,
      updatedAt: now
    }
    schedules.push(created)
    await this.writeRoutines(sessionId, schedules)
    return created
  }

  async list(sessionId: string): Promise<RoutineSchedule[]> {
    return this.readRoutines(sessionId)
  }

  // Scheduler-facing scan across every session's routine store (artifacts/*/.routines/).
  // Loads each session file defensively: a corrupt or missing file yields [] for that session.
  async listAllSchedules(): Promise<RoutineSchedule[]> {
    const artifactsRoot = resolve(this.options.storageRoot, 'artifacts')
    let entries
    try {
      entries = await readdir(artifactsRoot, { withFileTypes: true })
    } catch {
      return []
    }
    const schedules: RoutineSchedule[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        // readRoutines resolves the per-session dir via encodeURIComponent, so passing the raw
        // directory name here matches the write path exactly.
        schedules.push(...(await this.readRoutines(entry.name)))
      } catch {
        // A corrupt per-session file must not take down the whole scheduler scan.
      }
    }
    return schedules
  }

  async remove(sessionId: string, routineId: string): Promise<boolean> {
    const schedules = await this.readRoutines(sessionId)
    const next = schedules.filter((schedule) => schedule.id !== routineId)
    if (next.length === schedules.length) return false
    await this.writeRoutines(sessionId, next)
    return true
  }

  // Scheduler-facing mutations (not exposed to the agent directly).

  async setEnabled(
    sessionId: string,
    routineId: string,
    enabled: boolean,
    pausedReason?: RoutinePauseReason
  ): Promise<RoutineSchedule | null> {
    const schedules = await this.readRoutines(sessionId)
    const index = schedules.findIndex((schedule) => schedule.id === routineId)
    if (index === -1) return null
    const now = this.now()
    const previous = schedules[index]
    const updated: RoutineSchedule = {
      ...previous,
      enabled,
      pausedReason: enabled ? null : (pausedReason ?? 'user'),
      nextDue: enabled
        ? now + previous.everyMinutes * 60_000
        : null,
      idleStreak: enabled ? 0 : previous.idleStreak,
      updatedAt: now
    }
    schedules[index] = updated
    await this.writeRoutines(sessionId, schedules)
    return updated
  }

  // Records the outcome of one scheduler tick. Advances next_due by the interval, bumps
  // tick/missed/idle counters, auto-pauses at ROUTINE_STUCK_STREAK_THRESHOLD consecutive
  // failures, and keeps a bounded ring of recent results.
  async recordTick(
    sessionId: string,
    routineId: string,
    result: RoutineTickResult
  ): Promise<RoutineSchedule | null> {
    const schedules = await this.readRoutines(sessionId)
    const index = schedules.findIndex((schedule) => schedule.id === routineId)
    if (index === -1) return null
    const now = this.now()
    const previous = schedules[index]
    const results = [...previous.lastResults, result].slice(-MAX_RESULTS_PER_SCHEDULE)
    const idleStreak = result.ok ? 0 : previous.idleStreak + 1
    const autoPaused = !result.ok && idleStreak >= 3
    const updated: RoutineSchedule = {
      ...previous,
      lastFireAt: result.tickedAt,
      ...(result.ok ? { lastOkAt: result.tickedAt } : {}),
      tickCount: previous.tickCount + 1,
      missedTicks: previous.missedTicks + (result.ok ? 0 : 1),
      idleStreak,
      enabled: autoPaused ? false : previous.enabled,
      pausedReason: autoPaused ? 'stuck' : previous.pausedReason,
      nextDue: now + previous.everyMinutes * 60_000,
      lastResults: results,
      updatedAt: now
    }
    schedules[index] = updated
    await this.writeRoutines(sessionId, schedules)
    return updated
  }
}
