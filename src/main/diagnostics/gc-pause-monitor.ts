// The stall watchdog can say how long the loop was held and whether this process burned CPU, but not what
// held it. Six days of `~/Library/Logs/PureScience/main.log` (214 error/warn lines, 24 event-loop stalls)
// answered `no-cpu-in-process` for every stall in the low band — a measurement, not a cause: three different
// situations produce it (the OS did not schedule us, we awaited something outside the process, or a
// stop-the-world pause ran on the main thread). Garbage collection is the one of those three this process can
// observe directly: V8 reports every pause through `perf_hooks`, with a start time and a duration on the same
// clock the watchdog ticks with.
//
// Bounded on purpose: a permanent diagnostic must not grow for the life of the process. Pauses older than the
// ring are dropped, which is fine because the ring is only ever asked about the window that just ended.
//
// `unavailable` is a named state, never an empty reading: a runtime that refuses the observer would otherwise
// make "no GC pauses" and "nobody was watching" produce the same zero.

import { PerformanceObserver } from 'node:perf_hooks'

/** Total pause time inside a window, on the `performance.now()` clock. */
export type GcPauseReading =
  { status: 'measured'; pauseMs: number; pauses: number } | { status: 'unavailable' }

export type GcPauseSample = { startMs: number; durationMs: number }

export type GcPauseMonitor = {
  /** Pause time overlapping `[startMs, endMs]`, both on the `performance.now()` clock. */
  pauseMsWithin: (startMs: number, endMs: number) => GcPauseReading
  stop: () => void
}

export type GcPauseMonitorInput = {
  /**
   * Where pauses come from. Defaults to a `PerformanceObserver` on `gc` entries; a case that drives its own
   * clock passes its own. Returning `undefined` means the runtime refused to observe, which the monitor then
   * reports as `unavailable` instead of as zero pauses.
   */
  subscribe?: (onPause: (sample: GcPauseSample) => void) => (() => void) | undefined
  /** Pauses kept. 512 covers a burst several minutes long; older pauses are dropped. */
  capacity?: number
}

const DEFAULT_CAPACITY = 512

const subscribeWithObserver = (
  onPause: (sample: GcPauseSample) => void
): (() => void) | undefined => {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // `duration` is the pause itself (0 when V8 does not report it); `startTime` shares the time origin
        // with `performance.now()`, which is the clock the watchdog measures its windows on.
        onPause({ startMs: entry.startTime, durationMs: entry.duration })
      }
    })
    observer.observe({ entryTypes: ['gc'] })
    return () => observer.disconnect()
  } catch {
    return undefined
  }
}

export const createGcPauseMonitor = (input: GcPauseMonitorInput = {}): GcPauseMonitor => {
  const capacity = Math.max(1, Math.floor(input.capacity ?? DEFAULT_CAPACITY))
  const pauses: GcPauseSample[] = []
  const subscribe = input.subscribe ?? subscribeWithObserver
  const unsubscribe = subscribe((sample) => {
    pauses.push(sample)
    while (pauses.length > capacity) pauses.shift()
  })

  return {
    pauseMsWithin: (startMs, endMs) => {
      if (!unsubscribe) return { status: 'unavailable' }
      let pauseMs = 0
      let count = 0
      for (const pause of pauses) {
        // Clip to the window: a pause that straddles either edge counts only for its overlap, so two
        // adjacent windows cannot both claim the whole pause.
        const from = Math.max(pause.startMs, startMs)
        const to = Math.min(pause.startMs + pause.durationMs, endMs)
        if (to <= from) continue
        pauseMs += to - from
        count += 1
      }
      return { status: 'measured', pauseMs: Math.round(pauseMs), pauses: count }
    },
    stop: () => {
      unsubscribe?.()
    }
  }
}
