// A caller that measured 21.7 s across a window in which this process was not running did not spend
// 21.7 s working. Measured on this machine: at Settings mount five unrelated IPC channels finished within
// 8 s of each other and every one of them was 93-100 % inside a single 15-23 s window where the loop never
// ran — so "five slow channels" was one blocked loop, and optimizing any of the five would have optimized
// nothing. Without this split the wall duration is all a reader sees, which is how a machine-side freeze
// becomes an app-side slow path in the next report.
//
// The event-loop watchdog already knows exactly when the loop came back (each stall it reports ends at that
// moment), so the windows live here in one clock domain — `performance.now()`, the same clock the watchdog
// and the IPC diagnostics use — and a duration can be split into "the process was running" and "it was not".
//
// Deliberately a process-wide singleton: the watchdog is started once in main and the IPC adapter is created
// when its module loads, so a composition-root hand-off would add a seam neither side needs. Tests inject
// their own instance instead of reading this one.
export type LoopHeldWindows = {
  record(startMs: number, endMs: number): void
  // Clipped sum of the recorded windows inside [startMs, endMs]: never more than the span asked about.
  heldMsWithin(startMs: number, endMs: number): number
  // The instant from which this ring's coverage is complete: every qualifying stall that ended at or after it
  // is still retained. `undefined` while nothing has been dropped, which in production means coverage reaches
  // back to the first recorded window.
  //
  // Why this is a reading of its own: a span that begins before it may have lost stalls to the ring, and
  // `heldMsWithin` then answers less than the truth — including zero, and zero is what every caller prints as
  // "the loop was free". The stall-record ring beside this module keeps a `dropped` count for exactly this
  // reason; without the same number here, "we dropped those windows" and "the loop never stalled" are the
  // same line in a postmortem.
  coverageStartMs(): number | undefined
}

// Long enough to cover the settings-mount burst above many times over, short enough to stay a few KB.
const DEFAULT_CAPACITY = 64
// Below this a window is scheduler jitter, not a period the process was held: counting those would let a
// handful of 200 ms hiccups read as seconds of "held" time and push a real slow handler toward "not ours".
const DEFAULT_MINIMUM_MS = 200

export const createLoopHeldWindows = (
  options: { capacity?: number; minimumMs?: number } = {}
): LoopHeldWindows => {
  const capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_CAPACITY))
  const minimumMs = Math.max(0, options.minimumMs ?? DEFAULT_MINIMUM_MS)
  const windows: { startMs: number; endMs: number }[] = []
  // The end of the newest window the ring has dropped. Everything from here on is still retained, so a span
  // that starts before it cannot be answered from what is left — see `coverageStartMs`.
  let droppedThroughMs: number | undefined

  const record = (startMs: number, endMs: number): void => {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return
    if (endMs - startMs < minimumMs) return
    windows.push({ startMs, endMs })
    // Oldest first: a handler that started before the oldest kept window simply loses that coverage, which
    // under-reports held time (the safe direction — it never invents time the process did not lose). What the
    // under-report must not do is stay silent: the dropped boundary is remembered below so the reader can tell
    // "no window covered this span" from "the loop was free".
    while (windows.length > capacity) {
      const dropped = windows.shift()
      if (dropped) droppedThroughMs = Math.max(droppedThroughMs ?? dropped.endMs, dropped.endMs)
    }
  }

  const heldMsWithin = (startMs: number, endMs: number): number => {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0
    let total = 0
    for (const window of windows) {
      const overlap = Math.min(endMs, window.endMs) - Math.max(startMs, window.startMs)
      if (overlap > 0) total += overlap
    }
    return Math.min(total, endMs - startMs)
  }

  return { record, heldMsWithin, coverageStartMs: (): number | undefined => droppedThroughMs }
}

// Written by the event-loop watchdog, read by the IPC slow-handler diagnostic.
export const sharedLoopHeldWindows: LoopHeldWindows = createLoopHeldWindows()

// Most timers in this app measure their window with `Date.now()`, which is a different domain from the
// windows above. Rather than move a dozen call sites (and every test that fakes `Date`) onto a second
// clock, each wall-clock window is converted here with a *paired reading taken at its own end*: the offset
// is then exact for that window, so a wall-clock jump before or after it cannot shift it. What remains is
// sub-millisecond pairing error, and the result is still clipped to the span asked about.
export type ClockPair = Readonly<{ wallMs: number; perfMs: number }>

export const readClockPair = (): ClockPair => ({ wallMs: Date.now(), perfMs: performance.now() })

export const toMonotonicWindow = (
  wallStartMs: number,
  wallEndMs: number,
  pair: ClockPair
): { startMs: number; endMs: number } | undefined => {
  if (
    ![wallStartMs, wallEndMs, pair.wallMs, pair.perfMs].every((value) => Number.isFinite(value))
  ) {
    return undefined
  }
  if (wallEndMs < wallStartMs) return undefined
  return {
    startMs: pair.perfMs - (pair.wallMs - wallStartMs),
    endMs: pair.perfMs + (wallEndMs - pair.wallMs)
  }
}

export type HeldSplit = Readonly<{ heldMs: number; ownMs: number }>

/**
 * A span the ring cannot answer for: it starts before the oldest stall still kept, so whatever the loop lost
 * before that boundary is unknown. Reported instead of a split, because the alternative readings are both
 * wrong — `heldMs: 0` says "the loop was free", and saying nothing at all prints the wall duration as if all
 * of it had been our own work.
 */
export type HeldUnsplittable = Readonly<{ heldUnmeasured: 'windows-dropped' }>

/** What a slow line may carry about its window: the split, or the named reason there is none. */
export type HeldReading = HeldSplit | HeldUnsplittable

/** A source that can also say how far back its coverage is complete; the method is optional so a test double
 *  built from `heldMsWithin` alone keeps its old behaviour (nothing dropped ⇒ nothing to declare). */
export type HeldSplitSource = Pick<LoopHeldWindows, 'heldMsWithin'> &
  Partial<Pick<LoopHeldWindows, 'coverageStartMs'>>

/** The named gap for a span the retained windows no longer cover. A source that cannot answer, or throws,
 *  leaves the reading exactly as it was before this distinction existed. */
const unsplittableWithin = (
  source: HeldSplitSource,
  startMs: number
): HeldUnsplittable | undefined => {
  if (!source.coverageStartMs) return undefined
  let coverageStartMs: number | undefined
  try {
    coverageStartMs = source.coverageStartMs()
  } catch {
    return undefined
  }
  if (coverageStartMs === undefined || !Number.isFinite(coverageStartMs)) return undefined
  return startMs < coverageStartMs ? { heldUnmeasured: 'windows-dropped' } : undefined
}

/**
 * The two fields for a held reading that was already measured in this clock domain (the IPC adapters do
 * that themselves, so they do not need the wall-clock bridge). One place computes the arithmetic: a site
 * that inlined its own `ownMs` would be a second answer to "how much of this was ours".
 */
export const heldSplitFromMeasured = (heldMs: number, windowMs: number): HeldSplit | undefined => {
  if (!Number.isFinite(windowMs) || !(windowMs > 0)) return undefined
  if (!Number.isFinite(heldMs)) return undefined
  const rounded = Math.min(Math.round(windowMs), Math.max(0, Math.round(heldMs)))
  if (rounded < 1) return undefined
  return { heldMs: rounded, ownMs: Math.max(0, Math.round(windowMs) - rounded) }
}

/**
 * The held/own split for a window already measured on a monotonic clock (`performance.now()`), with the
 * measurement's own start/end rather than a width. Three adapters used to clip and round this arithmetic
 * themselves — a fourth copy would be a fourth answer to "how much of this was ours".
 */
export const heldSplitForMonotonicWindow = (
  startMs: number,
  endMs: number,
  windowMs: number,
  source: HeldSplitSource = sharedLoopHeldWindows
): HeldReading | undefined => {
  if (![startMs, endMs, windowMs].every((value) => Number.isFinite(value))) return undefined
  if (!(windowMs > 0)) return undefined
  const unsplittable = unsplittableWithin(source, startMs)
  if (unsplittable) return unsplittable
  const heldMs = Math.min(windowMs, Math.max(0, source.heldMsWithin(startMs, endMs)))
  return heldSplitFromMeasured(heldMs, windowMs)
}

/**
 * The held/own split for a window measured on the wall clock. `undefined` when the loop was never held
 * inside it — the caller then prints no field at all, so "the loop was free" and "nobody measured" stay
 * distinguishable by presence rather than by a zero.
 */
export const heldSplitForWallWindow = (
  wallStartMs: number,
  windowMs: number,
  options: { source?: HeldSplitSource; pair?: ClockPair } = {}
): HeldReading | undefined => {
  if (!Number.isFinite(windowMs) || !(windowMs > 0)) return undefined
  const window = toMonotonicWindow(
    wallStartMs,
    wallStartMs + windowMs,
    options.pair ?? readClockPair()
  )
  if (!window) return undefined
  const source = options.source ?? sharedLoopHeldWindows
  const unsplittable = unsplittableWithin(source, window.startMs)
  if (unsplittable) return unsplittable
  return heldSplitFromMeasured(source.heldMsWithin(window.startMs, window.endMs), windowMs)
}

/**
 * The two fields a slow line adds when part of it fell inside a loop-held window; the named `heldUnmeasured`
 * marker when the ring no longer covers that span; nothing otherwise.
 */
export const heldSplitFields = (
  wallStartMs: number,
  windowMs: number,
  options: { source?: HeldSplitSource; pair?: ClockPair } = {}
): { heldMs?: number; ownMs?: number; heldUnmeasured?: 'windows-dropped' } =>
  heldSplitForWallWindow(wallStartMs, windowMs, options) ?? {}
