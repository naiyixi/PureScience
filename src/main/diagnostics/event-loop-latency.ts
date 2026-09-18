import { monitorEventLoopDelay } from 'node:perf_hooks'

// Wall-clock segment timing cannot attribute a stall: in the preview acquire path the same ~340 ms landed in
// the read segment for four calls and in the query segment for two, on identical byte counts. A segment
// boundary only partitions elapsed time, so the wait moves to whichever segment spans it.
//
// Event-loop delay answers the question the segments could not: if the loop was delayed for most of the
// operation, main was blocked; if the loop stayed healthy while the operation took that long, the call was
// genuinely awaiting something (engine round-trip, file system) rather than stalling the process.
type EventLoopLatency = {
  maxMs: number
  meanMs: number
  p99Ms: number
}

const histogram = monitorEventLoopDelay({ resolution: 20 })
let enabled = false

const ensureEnabled = (): void => {
  if (enabled) return
  histogram.enable()
  enabled = true
}

const toMs = (nanoseconds: number): number =>
  Number.isFinite(nanoseconds) ? Math.round(nanoseconds / 1e6) : 0

// Reset before the operation under measurement, read after it: the histogram then covers exactly that window.
const resetEventLoopLatency = (): void => {
  ensureEnabled()
  histogram.reset()
}

const readEventLoopLatency = (): EventLoopLatency => {
  ensureEnabled()
  return {
    maxMs: toMs(histogram.max),
    meanMs: toMs(histogram.mean),
    p99Ms: toMs(histogram.percentile(99))
  }
}

export { readEventLoopLatency, resetEventLoopLatency, type EventLoopLatency }
