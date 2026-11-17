import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UpdateStatus } from '../../shared/update'
import type { UpdateStrategy } from './strategy'
import { startUpdateScheduler } from './scheduler'

const status = { state: 'idle' as const, current: '0.5.1' }

const createStrategy = (): UpdateStrategy => ({
  getStatus: vi.fn(() => status),
  check: vi.fn().mockResolvedValue(status),
  download: vi.fn().mockResolvedValue(status),
  cancel: vi.fn().mockResolvedValue(status),
  apply: vi.fn().mockResolvedValue(status)
})

const errorStatus = (): UpdateStatus => ({
  state: 'error',
  current: '0.5.1',
  error: 'net::ERR_NETWORK_CHANGED'
})

// Resolves with each entry in turn and with a plain success status once the list is used up, so a test only
// has to spell out the failures it cares about.
const createStrategyWith = (statuses: UpdateStatus[]): UpdateStrategy => {
  const queue = [...statuses]
  const strategy = createStrategy()
  strategy.check = vi.fn(() =>
    Promise.resolve(queue.shift() ?? { state: 'up-to-date' as const, current: '0.5.1' })
  )
  return strategy
}

describe('startUpdateScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('checks immediately and then at the requested interval', async () => {
    const strategy = createStrategy()
    const stop = startUpdateScheduler(strategy, 1_000)

    expect(strategy.check).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(strategy.check).toHaveBeenCalledTimes(4)

    stop()
  })

  it('stops future checks when the caller tears down the scheduler', async () => {
    const strategy = createStrategy()
    const stop = startUpdateScheduler(strategy, 1_000)

    await vi.advanceTimersByTimeAsync(1_000)
    stop()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(strategy.check).toHaveBeenCalledTimes(2)
  })

  // The wake-up shape, measured on a real machine: the timer that came due during a freeze fires the
  // moment the process resumes, the fetch dies on `net::ERR_NETWORK_CHANGED`, and a flat interval would
  // leave that failure final for six hours. These four cases pin the retry that makes it transient.
  describe('after a failed check', () => {
    it('retries after the base delay and returns to the interval once a check reports a status', async () => {
      const strategy = createStrategyWith([
        errorStatus(),
        { state: 'up-to-date', current: '0.5.1' }
      ])
      const stop = startUpdateScheduler(strategy, 5_000, { baseMs: 1_000, maxMs: 8_000 })

      expect(strategy.check).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(999)
      expect(strategy.check).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(strategy.check).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(4_998)
      expect(strategy.check).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(2)
      expect(strategy.check).toHaveBeenCalledTimes(3)

      stop()
    })

    it('doubles the delay between consecutive failures up to the cap', async () => {
      const strategy = createStrategyWith([
        errorStatus(),
        errorStatus(),
        errorStatus(),
        errorStatus()
      ])
      const stop = startUpdateScheduler(strategy, 5_000, { baseMs: 1_000, maxMs: 4_000 })

      await vi.advanceTimersByTimeAsync(1_000)
      expect(strategy.check).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(strategy.check).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(3_999)
      expect(strategy.check).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(strategy.check).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(strategy.check).toHaveBeenCalledTimes(5)

      // A success puts the schedule back on the interval: the next attempt is a full `intervalMs` away.
      strategy.check = vi.fn().mockResolvedValue({ state: 'up-to-date', current: '0.5.1' })
      await vi.advanceTimersByTimeAsync(4_999)
      expect(strategy.check).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(strategy.check).toHaveBeenCalledTimes(1)

      stop()
    })

    it('retries a strategy that throws instead of reporting the failure', async () => {
      const strategy = createStrategy()
      strategy.check = vi
        .fn()
        .mockRejectedValueOnce(new Error('feed unreachable'))
        .mockResolvedValue({ state: 'up-to-date', current: '0.5.1' })
      const stop = startUpdateScheduler(strategy, 5_000, { baseMs: 1_000, maxMs: 8_000 })

      await vi.advanceTimersByTimeAsync(1_000)
      expect(strategy.check).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(strategy.check).toHaveBeenCalledTimes(3)

      stop()
    })
  })

  it('does not start a second check while the first one is still running', async () => {
    let finish: ((status: UpdateStatus) => void) | undefined
    const strategy = createStrategy()
    strategy.check = vi.fn(
      () =>
        new Promise<UpdateStatus>((resolve) => {
          finish = resolve
        })
    )
    const stop = startUpdateScheduler(strategy, 1_000, { baseMs: 500, maxMs: 2_000 })

    // The check spends its own deadline (ten seconds in the manifest strategy); an interval would fire
    // ten times behind it and stack duplicate fetches on a machine that just woke up.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(strategy.check).toHaveBeenCalledTimes(1)

    finish?.({ state: 'up-to-date', current: '0.5.1' })
    await vi.advanceTimersByTimeAsync(999)
    expect(strategy.check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(strategy.check).toHaveBeenCalledTimes(2)

    stop()
  })

  it('gives up on a check that never resolves so automatic updates are not silenced for good', async () => {
    const strategy = createStrategy()
    strategy.check = vi
      .fn()
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValue({ state: 'up-to-date', current: '0.5.1' })
    const stop = startUpdateScheduler(strategy, 5_000, { baseMs: 1_000, maxMs: 8_000 })

    // Five minutes of guard, then the base retry delay: the hung attempt counts as a failure.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(strategy.check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(strategy.check).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(strategy.check).toHaveBeenCalledTimes(3)

    stop()
  })
})
