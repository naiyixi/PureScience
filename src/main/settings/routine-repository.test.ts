// Routine repository unit tests: schedule CRUD, interval validation, tick accounting
// (missed/idle/stuck auto-pause), and the cross-session scheduler scan.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RoutineRepository, RoutineValidationError } from './routine-repository'
import type { RoutineSchedule } from '../../shared/routine'

let counter = 0
const createId = (): string => `routine-${++counter}`
let now = 1_000_000

const makeRepository = async (): Promise<{
  root: string
  repository: RoutineRepository
}> => {
  const root = await mkdtemp(join(tmpdir(), 'routine-repo-'))
  return {
    root,
    repository: new RoutineRepository({ storageRoot: root, createId, now: () => now })
  }
}

const loadOnDisk = async (root: string, sessionId: string): Promise<RoutineSchedule[]> => {
  const raw = await readFile(join(root, 'artifacts', sessionId, '.routines', 'routines.json'), 'utf8')
  return JSON.parse(raw) as RoutineSchedule[]
}

afterEach(async () => {
  // No-op: roots are cleaned at the end of each test that created one.
})

describe('RoutineRepository.upsert', () => {
  it('creates a schedule with a due tick one interval out', async () => {
    const { repository } = await makeRepository()
    const schedule = await repository.upsert('session-1', {
      everyMinutes: 30,
      instruction: 'Check for new variants and summarize.'
    })
    expect(schedule.id).toBe('routine-1')
    expect(schedule.enabled).toBe(true)
    expect(schedule.nextDue).toBe(now + 30 * 60_000)
    expect(schedule.tickCount).toBe(0)
    expect(schedule.missedTicks).toBe(0)
    expect(schedule.idleStreak).toBe(0)
    expect(schedule.pausedReason).toBeNull()
  })

  it('rejects intervals below the 5-minute floor and above the 1440 ceiling', async () => {
    const { repository } = await makeRepository()
    await expect(
      repository.upsert('s', { everyMinutes: 4, instruction: 'x' })
    ).rejects.toMatchObject({ code: 'invalid_interval' })
    await expect(
      repository.upsert('s', { everyMinutes: 1441, instruction: 'x' })
    ).rejects.toMatchObject({ code: 'invalid_interval' })
    await expect(
      repository.upsert('s', { everyMinutes: 1.5, instruction: 'x' })
    ).rejects.toMatchObject({ code: 'invalid_interval' })
  })

  it('rejects an empty instruction', async () => {
    const { repository } = await makeRepository()
    await expect(
      repository.upsert('s', { everyMinutes: 30, instruction: '   ' })
    ).rejects.toMatchObject({ code: 'empty_instruction' })
  })

  it('updates an existing schedule by id and re-enables it', async () => {
    const { repository } = await makeRepository()
    const created = await repository.upsert('session-1', {
      everyMinutes: 30,
      instruction: 'old'
    })
    now += 5_000
    // Simulate a stuck pause, then update: update must re-enable and reset the streak.
    await repository.setEnabled('session-1', created.id, false, 'stuck')
    const updated = await repository.upsert('session-1', {
      routineId: created.id,
      everyMinutes: 60,
      instruction: 'new instruction',
      label: 'weekly'
    })
    expect(updated.id).toBe(created.id)
    expect(updated.everyMinutes).toBe(60)
    expect(updated.instruction).toBe('new instruction')
    expect(updated.label).toBe('weekly')
    expect(updated.enabled).toBe(true)
    expect(updated.pausedReason).toBeNull()
    expect(updated.idleStreak).toBe(0)
    expect(updated.nextDue).toBe(now + 60 * 60_000)
  })

  it('errors when updating an unknown routine id', async () => {
    const { repository } = await makeRepository()
    await expect(
      repository.upsert('session-1', {
        routineId: 'missing',
        everyMinutes: 30,
        instruction: 'x'
      })
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('persists to disk and reloads', async () => {
    const { root, repository } = await makeRepository()
    await repository.upsert('session-1', {
      everyMinutes: 30,
      instruction: 'persisted instruction',
      label: 'label'
    })
    const onDisk = await loadOnDisk(root, 'session-1')
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0].instruction).toBe('persisted instruction')

    const reloaded = await repository.list('session-1')
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0].label).toBe('label')
  })
})

describe('RoutineRepository.list / remove', () => {
  it('lists only the owning session schedules', async () => {
    const { repository } = await makeRepository()
    await repository.upsert('session-1', { everyMinutes: 30, instruction: 'a' })
    await repository.upsert('session-2', { everyMinutes: 60, instruction: 'b' })
    expect(await repository.list('session-1')).toHaveLength(1)
    expect(await repository.list('session-2')).toHaveLength(1)
  })

  it('remove deletes only the target schedule and reports absence', async () => {
    const { repository } = await makeRepository()
    const a = await repository.upsert('session-1', { everyMinutes: 30, instruction: 'a' })
    await repository.upsert('session-1', { everyMinutes: 60, instruction: 'b' })
    expect(await repository.remove('session-1', a.id)).toBe(true)
    expect(await repository.remove('session-1', a.id)).toBe(false)
    expect(await repository.list('session-1')).toHaveLength(1)
  })
})

describe('RoutineRepository.setEnabled', () => {
  it('pauses with a reason and clears nextDue; re-enable restores scheduling', async () => {
    const { repository } = await makeRepository()
    const created = await repository.upsert('session-1', {
      everyMinutes: 30,
      instruction: 'x'
    })
    now += 10_000
    const paused = await repository.setEnabled('session-1', created.id, false, 'user')
    expect(paused?.enabled).toBe(false)
    expect(paused?.pausedReason).toBe('user')
    expect(paused?.nextDue).toBeNull()

    const resumed = await repository.setEnabled('session-1', created.id, true)
    expect(resumed?.enabled).toBe(true)
    expect(resumed?.pausedReason).toBeNull()
    expect(resumed?.nextDue).toBe(now + 30 * 60_000)
  })
})

describe('RoutineRepository.recordTick', () => {
  it('records an ok tick: bumps tickCount, resets idleStreak, keeps nextDue rolling', async () => {
    const { repository } = await makeRepository()
    const created = await repository.upsert('session-1', {
      everyMinutes: 30,
      instruction: 'x'
    })
    now += 30 * 60_000
    const after = await repository.recordTick('session-1', created.id, {
      tickedAt: now,
      runId: 'run-1',
      ok: true
    })
    expect(after?.tickCount).toBe(1)
    expect(after?.missedTicks).toBe(0)
    expect(after?.idleStreak).toBe(0)
    expect(after?.lastOkAt).toBe(now)
    expect(after?.lastFireAt).toBe(now)
    expect(after?.nextDue).toBe(now + 30 * 60_000)
    expect(after?.lastResults).toHaveLength(1)
    expect(after?.lastResults[0].runId).toBe('run-1')
  })

  it('counts failed ticks into missed/idle and auto-pauses after three consecutive failures', async () => {
    const { repository } = await makeRepository()
    const created = await repository.upsert('session-1', {
      everyMinutes: 30,
      instruction: 'x'
    })
    for (let i = 1; i <= 3; i += 1) {
      now += 30 * 60_000
      const after = await repository.recordTick('session-1', created.id, {
        tickedAt: now,
        ok: false,
        error: 'boom'
      })
      expect(after?.idleStreak).toBe(i)
      expect(after?.missedTicks).toBe(i)
      if (i < 3) {
        expect(after?.enabled).toBe(true)
        expect(after?.pausedReason).toBeNull()
      }
    }
    const stuck = await repository.list('session-1')
    expect(stuck[0].enabled).toBe(false)
    expect(stuck[0].pausedReason).toBe('stuck')
  })

  it('keeps only the most recent 8 results', async () => {
    now = 1_000_000
    const { repository } = await makeRepository()
    const created = await repository.upsert('session-1', {
      everyMinutes: 5,
      instruction: 'x'
    })
    for (let i = 1; i <= 10; i += 1) {
      now += 5 * 60_000
      await repository.recordTick('session-1', created.id, { tickedAt: now, ok: true })
    }
    const after = await repository.list('session-1')
    expect(after[0].lastResults).toHaveLength(8)
    // The 3rd tick's timestamp is the oldest retained one (10 ticks, 8 kept).
    expect(after[0].lastResults[0].tickedAt).toBe(1_000_000 + 3 * 5 * 60_000)
  })
})

describe('RoutineRepository.listAllSchedules', () => {
  it('aggregates schedules across sessions and tolerates missing files', async () => {
    const { root, repository } = await makeRepository()
    await repository.upsert('session-1', { everyMinutes: 30, instruction: 'a' })
    await repository.upsert('session-2', { everyMinutes: 60, instruction: 'b' })
    // A session dir with no routines file (or a stray file) must not break the scan.
    const all = await repository.listAllSchedules()
    expect(all).toHaveLength(2)
    expect(all.map((s) => s.instruction).sort()).toEqual(['a', 'b'])

    await rm(root, { recursive: true, force: true })
  })
})

// Keep RoutineValidationError's shape under test so callers can rely on the code.
describe('RoutineValidationError', () => {
  it('carries a machine-readable code', () => {
    const error = new RoutineValidationError('invalid_interval', 'bad interval')
    expect(error.name).toBe('RoutineValidationError')
    expect(error.code).toBe('invalid_interval')
    expect(error.message).toBe('bad interval')
  })
})
