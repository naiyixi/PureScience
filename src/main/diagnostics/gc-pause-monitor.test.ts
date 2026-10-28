import { describe, expect, it, vi } from 'vitest'

import { createGcPauseMonitor, type GcPauseMonitor, type GcPauseSample } from './gc-pause-monitor'

// A source of pauses the case drives by hand: the real observer reports pauses it cannot schedule, and the
// window arithmetic is what this module is.
const handDriven = (
  capacity?: number
): {
  monitor: GcPauseMonitor
  pause: (startMs: number, durationMs: number) => void
  unsubscribe: ReturnType<typeof vi.fn>
} => {
  let listener: ((sample: GcPauseSample) => void) | undefined
  const unsubscribe = vi.fn()
  const monitor = createGcPauseMonitor({
    ...(capacity === undefined ? {} : { capacity }),
    subscribe: (onPause) => {
      listener = onPause
      return unsubscribe
    }
  })
  return {
    monitor,
    pause: (startMs, durationMs) => listener?.({ startMs, durationMs }),
    unsubscribe
  }
}

describe('gc pause monitor', () => {
  it('counts only the part of a pause that falls inside the window', () => {
    const { monitor, pause } = handDriven()

    // Straddles the window's start: 60 of its 100 ms belong to [1 000, 1 500].
    pause(960, 100)
    // Inside, whole.
    pause(1_100, 50)
    // Straddles the end: 20 ms inside, 30 ms after it.
    pause(1_480, 50)
    // Entirely before the window.
    pause(100, 90)

    expect(monitor.pauseMsWithin(1_000, 1_500)).toEqual({
      status: 'measured',
      pauseMs: 130,
      pauses: 3
    })
  })

  it('reports unavailable when the runtime refuses to observe, not zero pauses', () => {
    const monitor = createGcPauseMonitor({ subscribe: () => undefined })
    // The distinction is the whole point: a process that cannot observe and a process without pauses both
    // have nothing to report, and only one of them means the loop was calm.
    expect(monitor.pauseMsWithin(0, 1_000)).toEqual({ status: 'unavailable' })
  })

  it('keeps a bounded history and drops the oldest pauses first', () => {
    const { monitor, pause } = handDriven(2)

    pause(100, 10)
    pause(200, 10)
    pause(300, 10)

    // The 100 ms pause fell out of the ring; the window that would have seen it now sees nothing.
    expect(monitor.pauseMsWithin(0, 150)).toEqual({ status: 'measured', pauseMs: 0, pauses: 0 })
    expect(monitor.pauseMsWithin(0, 400)).toEqual({ status: 'measured', pauseMs: 20, pauses: 2 })
  })

  it('disconnects the observer when the watchdog stops', () => {
    const { monitor, unsubscribe } = handDriven()
    monitor.stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
