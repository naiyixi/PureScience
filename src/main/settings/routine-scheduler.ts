// Routine scheduler: the main-process tick loop that turns registered schedules into task runs.
// Every TICK_INTERVAL_MS it scans all enabled schedules, fires every one whose nextDue has
// passed, and records the outcome through the repository. A tick dispatches a fresh task run
// with the schedule's instruction as its prompt (reusing the existing task runner — the routine
// capability adds the cadence, not a new execution engine). A run that fails to start (or whose
// run rejects synchronously) is recorded as a failed tick; three consecutive failures
// auto-pause the schedule with reason 'stuck' so a broken routine stops burning task runs.

import type { RoutineSchedule, RoutineTickResult } from '../../shared/routine'

// How often the scheduler scans for due schedules. Ticks are minute-granular; a 30s scan keeps
// jitter small without waking the app more than needed.
const TICK_INTERVAL_MS = 30_000

// A routine that failed to dispatch (sync rejection / missing session) — as opposed to a
// dispatched run that later fails on its own. Both count toward the stuck streak.
export type RoutineTickOutcome =
  | { kind: 'ok'; runId?: string }
  | { kind: 'error'; message: string }

export type RoutineSchedulerOptions = {
  repository: {
    listAllSchedules: () => Promise<RoutineSchedule[]>
    recordTick: (
      sessionId: string,
      routineId: string,
      result: RoutineTickResult
    ) => Promise<RoutineSchedule | null>
    setEnabled: (
      sessionId: string,
      routineId: string,
      enabled: boolean
    ) => Promise<RoutineSchedule | null>
  }
  // Dispatches one schedule tick. Implemented by the app with the task runner; must resolve
  // with the dispatch outcome (ok once the run has been accepted).
  dispatchTick: (schedule: RoutineSchedule) => Promise<RoutineTickOutcome>
  now?: () => number
  tickIntervalMs?: number
}

export class RoutineScheduler {
  private readonly now: () => number
  private readonly tickIntervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  // Guards against overlapping scans (a slow dispatchTick must not stack ticks).
  private scanning = false
  private lastScanAt = 0

  constructor(private readonly options: RoutineSchedulerOptions) {
    this.now = options.now ?? (() => Date.now())
    this.tickIntervalMs = options.tickIntervalMs ?? TICK_INTERVAL_MS
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.scan()
    }, this.tickIntervalMs)
    // First scan promptly so a schedule due in the past fires without waiting a full interval.
    this.timer.unref?.()
    void this.scan()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  // Exposed for tests and the settings panel ("run now").
  async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const now = this.now()
      if (now - this.lastScanAt < 1000 && this.lastScanAt > 0) return
      this.lastScanAt = now
      const schedules = await this.options.repository.listAllSchedules()
      const due = schedules.filter(
        (schedule) =>
          schedule.enabled &&
          schedule.nextDue !== null &&
          schedule.nextDue <= now
      )
      for (const schedule of due) {
        await this.fire(schedule)
      }
    } finally {
      this.scanning = false
    }
  }

  // Fires one due schedule: dispatch the tick, then record the outcome.
  private async fire(schedule: RoutineSchedule): Promise<void> {
    const outcome = await this.options.dispatchTick(schedule)
    await this.options.repository.recordTick(schedule.sessionId, schedule.id, {
      tickedAt: this.now(),
      ...(outcome.kind === 'ok'
        ? { ok: true, runId: outcome.runId }
        : { ok: false, error: outcome.message })
    })
  }
}
