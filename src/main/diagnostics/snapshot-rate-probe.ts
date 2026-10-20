import { performance } from 'node:perf_hooks'

import type { Logger } from '../logger'

// The renderer-facing state snapshot is rebuilt from scratch on every state emission and on every direct
// read, and during streaming an emission happens per state change — which is where the cost question came
// from. Two readings disagreed and neither could settle it: the stall profiles of the shipped build put
// `sortedRecords` (inside the grants projection of this same snapshot) at the top of ~60 % of the worst
// samples (~890 ms attributed), while the same projection measured 0.16 ms per call in isolation. A cost per
// call and a total per stall can only be reconciled through the call rate, and nothing in the product
// counted it — the emission path had no counter at all.
//
// This probe supplies exactly that: one aggregate line per window with the call count split by path, and
// the total/max/mean build cost. It deliberately does not report what it cannot see — per-phase durations
// inside the build, the IPC serialize/send after it, and the renderer's deserialize are not measured here,
// so a fast reading rules out *this* path as the source of a stall without claiming anything about those.
const DEFAULT_WINDOW_MS = 30_000

// `emission` is the push path (every state change rebuilds and broadcasts); `pull` is any build whose
// result is returned to a caller, which includes IPC command results as well as `acp:get-state`.
export type SnapshotPathSource = 'emission' | 'pull'

export type SnapshotRateReading = {
  // Actual span this window covered, not the configured target: a window only closes when the next call
  // arrives, so a quiet stretch makes the next line wider instead of inventing traffic.
  windowMs: number
  calls: number
  emissionCalls: number
  pullCalls: number
  totalMs: number
  maxMs: number
  meanMs: number
}

export type SnapshotRateProbe = {
  measure: <Value>(source: SnapshotPathSource, build: () => Value) => Value
  // Test and shutdown seam: closes the current window now. An empty window reports nothing — a line with
  // `calls 0` would read like a measurement of idle traffic that nobody asked for.
  flush: () => void
}

export type SnapshotRateProbeInput = {
  log: Pick<Logger, 'info'>
  windowMs?: number
  // Milliseconds from any fixed origin. Defaults to the monotonic clock, since this measures durations.
  now?: () => number
}

const round = (value: number): number => Math.round(value * 100) / 100

export const createSnapshotRateProbe = (input: SnapshotRateProbeInput): SnapshotRateProbe => {
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS
  const now = input.now ?? ((): number => performance.now())
  let windowStart = now()
  let calls = 0
  let emissionCalls = 0
  let pullCalls = 0
  let totalMs = 0
  let maxMs = 0
  // A build that measures itself again (a caller reading the snapshot in the middle of building one) is
  // the same milliseconds twice: the inner call runs unmeasured so `totalMs`/`maxMs` stay the cost of real
  // snapshot builds and cannot grow with nesting.
  let depth = 0

  const flush = (closedAt: number = now()): void => {
    const reading: SnapshotRateReading = {
      windowMs: Math.max(0, Math.round(closedAt - windowStart)),
      calls,
      emissionCalls,
      pullCalls,
      totalMs: round(totalMs),
      maxMs: round(maxMs),
      meanMs: calls > 0 ? round(totalMs / calls) : 0
    }
    const reported = calls > 0
    calls = 0
    emissionCalls = 0
    pullCalls = 0
    totalMs = 0
    maxMs = 0
    windowStart = closedAt
    if (!reported) return
    try {
      input.log.info('state snapshot build rate', reading)
    } catch {
      // A diagnostic must never take down the path it is measuring.
    }
  }

  const measure = <Value>(source: SnapshotPathSource, build: () => Value): Value => {
    if (depth > 0) return build()
    const startedAt = now()
    depth = 1
    try {
      return build()
    } finally {
      depth = 0
      const cost = now() - startedAt
      calls += 1
      if (source === 'emission') emissionCalls += 1
      else pullCalls += 1
      totalMs += cost
      if (cost > maxMs) maxMs = cost
      const at = now()
      if (at - windowStart >= windowMs) flush(at)
    }
  }

  return { measure, flush: () => flush() }
}
