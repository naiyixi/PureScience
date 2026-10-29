import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  armTurnSilenceWatchdog,
  disarmTurnSilenceWatchdog,
  silentForMs,
  TURN_SILENCE_TIMEOUT_MS,
  touchTurnSilenceWatchdog
} from './turn-silence-watchdog'

// The watchdog exists because a turn could wait forever: measured 2026-10-29, a runtime accepted a prompt and
// then produced no event for 15+ minutes while the session stayed `running`. These cases pin the three
// behaviours that make the bound safe — it fires only on total silence, it resets on every event, and a turn
// that has ended can never be reported as hung.
describe('turn silence watchdog', () => {
  afterEach(() => {
    vi.useRealTimers()
    disarmTurnSilenceWatchdog('s1')
  })

  it('fires once after a full timeout of silence, naming how long it was', () => {
    vi.useFakeTimers()
    const onSilent = vi.fn()
    armTurnSilenceWatchdog('s1', onSilent)

    vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS - 1)
    expect(onSilent).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onSilent).toHaveBeenCalledTimes(1)
    expect(onSilent.mock.calls[0][0]).toBeGreaterThanOrEqual(TURN_SILENCE_TIMEOUT_MS - 1)

    // Only once: a second fire would name a reason for a turn that no longer exists.
    vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS * 3)
    expect(onSilent).toHaveBeenCalledTimes(1)
  })

  it('resets on every inbound event, so a long turn that keeps streaming is never cut', () => {
    vi.useFakeTimers()
    const onSilent = vi.fn()
    armTurnSilenceWatchdog('s1', onSilent)

    // Nine minutes of work in ten-minute slices of patience: a streaming turn can run hours like this.
    for (let i = 0; i < 6; i += 1) {
      vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS - 60_000)
      touchTurnSilenceWatchdog('s1')
      expect(onSilent).not.toHaveBeenCalled()
    }

    vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS)
    expect(onSilent).toHaveBeenCalledTimes(1)
  })

  it('never fires for a turn that already ended', () => {
    vi.useFakeTimers()
    const onSilent = vi.fn()
    armTurnSilenceWatchdog('s1', onSilent)
    disarmTurnSilenceWatchdog('s1')

    vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS * 5)
    expect(onSilent).not.toHaveBeenCalled()
    expect(silentForMs('s1')).toBeUndefined()
  })

  it('replaces the previous turn when a new one is armed on the same session', () => {
    vi.useFakeTimers()
    const first = vi.fn()
    const second = vi.fn()
    armTurnSilenceWatchdog('s1', first)
    vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS - 1)
    armTurnSilenceWatchdog('s1', second)

    vi.advanceTimersByTime(TURN_SILENCE_TIMEOUT_MS - 1)
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('reports the silent span so a caller can log the measurement', () => {
    vi.useFakeTimers()
    armTurnSilenceWatchdog('s1', vi.fn())
    vi.advanceTimersByTime(90_000)
    expect(silentForMs('s1')).toBe(90_000)
    touchTurnSilenceWatchdog('s1')
    expect(silentForMs('s1')).toBe(0)
  })
})
