// RoutineScheduler unit tests: due-fire dispatch, non-overlap guard, and error outcomes.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { RoutineScheduler, type RoutineTickOutcome } from './routine-scheduler'
import type { RoutineSchedule } from '../../shared/routine'

let counter = 0
const makeSchedule = (overrides: Partial<RoutineSchedule> = {}): RoutineSchedule => {
  counter += 1
  return {
    id: `routine-${counter}`,
    sessionId: 'session-1',
    label: undefined,
    instruction: 'Run the weekly check.',
    everyMinutes: 30,
    enabled: true,
    nextDue: 1_000_000,
    lastFireAt: null,
    lastOkAt: null,
    tickCount: 0,
    missedTicks: 0,
    idleStreak: 0,
    pausedReason: null,
    lastResults: [],
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    ...overrides
  }
}

const makeScheduler = (
  options: {
    schedules?: RoutineSchedule[]
    dispatch?: (schedule: RoutineSchedule) => Promise<RoutineTickOutcome>
    now?: () => number
    intervalMs?: number
  } = {}
): {
  scheduler: RoutineScheduler
  recordTick: ReturnType<typeof vi.fn>
  setEnabled: ReturnType<typeof vi.fn>
} => {
  const schedules = options.schedules ?? []
  const recordTick = vi.fn(async () => null)
  const setEnabled = vi.fn(async () => null)
  const scheduler = new RoutineScheduler({
    repository: {
      listAllSchedules: async () => schedules,
      recordTick,
      setEnabled
    },
    dispatchTick: options.dispatch ?? (async () => ({ kind: 'ok', runId: 'run-1' })),
    now: options.now ?? (() => 2_000_000),
    tickIntervalMs: options.intervalMs ?? 30_000
  })
  return { scheduler, recordTick, setEnabled }
}

afterEach(() => {
  counter = 0
})

describe('RoutineScheduler.scan', () => {
  it('fires schedules whose nextDue has passed and records an ok tick', async () => {
    const dispatch: (schedule: RoutineSchedule) => Promise<RoutineTickOutcome> = vi.fn(
      async (): Promise<RoutineTickOutcome> => ({ kind: 'ok', runId: 'run-abc' })
    )
    const { scheduler, recordTick } = makeScheduler({
      schedules: [makeSchedule({ nextDue: 1_500_000 })],
      dispatch,
      now: () => 2_000_000
    })
    await scheduler.scan()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(recordTick).toHaveBeenCalledWith('session-1', 'routine-1', {
      tickedAt: 2_000_000,
      ok: true,
      runId: 'run-abc'
    })
  })

  it('does not fire disabled schedules or schedules not yet due', async () => {
    const dispatch = vi.fn()
    const { scheduler } = makeScheduler({
      schedules: [
        makeSchedule({ id: 'disabled', enabled: false, nextDue: 0 }),
        makeSchedule({ id: 'future', nextDue: 3_000_000 })
      ],
      dispatch,
      now: () => 2_000_000
    })
    await scheduler.scan()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('records an error outcome when dispatch fails', async () => {
    const { scheduler, recordTick } = makeScheduler({
      schedules: [makeSchedule({ nextDue: 0 })],
      dispatch: async () => ({ kind: 'error', message: 'Session gone' }),
      now: () => 2_000_000
    })
    await scheduler.scan()
    expect(recordTick).toHaveBeenCalledWith('session-1', 'routine-1', {
      tickedAt: 2_000_000,
      ok: false,
      error: 'Session gone'
    })
  })

  it('does not re-fire within the 1s min-scan window', async () => {
    const dispatch: (schedule: RoutineSchedule) => Promise<RoutineTickOutcome> = vi.fn(
      async (): Promise<RoutineTickOutcome> => ({ kind: 'ok', runId: 'run-1' })
    )
    const { scheduler } = makeScheduler({
      schedules: [makeSchedule({ nextDue: 0 })],
      dispatch,
      now: () => 2_000_000
    })
    await scheduler.scan()
    await scheduler.scan()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('does not stack overlapping scans while one is in flight', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatch: (schedule: RoutineSchedule) => Promise<RoutineTickOutcome> = vi.fn(
      async (): Promise<RoutineTickOutcome> => {
        await gate
        return { kind: 'ok' }
      }
    )
    const { scheduler } = makeScheduler({
      schedules: [makeSchedule({ nextDue: 0 })],
      dispatch
    })
    const first = scheduler.scan()
    const second = scheduler.scan()
    release()
    await Promise.all([first, second])
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
