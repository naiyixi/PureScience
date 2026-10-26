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

  const record = (startMs: number, endMs: number): void => {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return
    if (endMs - startMs < minimumMs) return
    windows.push({ startMs, endMs })
    // Oldest first: a handler that started before the oldest kept window simply loses that coverage, which
    // under-reports held time (the safe direction — it never invents time the process did not lose).
    while (windows.length > capacity) windows.shift()
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

  return { record, heldMsWithin }
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
 * The held/own split for a window measured on the wall clock. `undefined` when the loop was never held
 * inside it — the caller then prints no field at all, so "the loop was free" and "nobody measured" stay
 * distinguishable by presence rather than by a zero.
 */
export const heldSplitForWallWindow = (
  wallStartMs: number,
  windowMs: number,
  options: { source?: LoopHeldWindows; pair?: ClockPair } = {}
): HeldSplit | undefined => {
  if (!Number.isFinite(windowMs) || !(windowMs > 0)) return undefined
  const window = toMonotonicWindow(
    wallStartMs,
    wallStartMs + windowMs,
    options.pair ?? readClockPair()
  )
  if (!window) return undefined
  const source = options.source ?? sharedLoopHeldWindows
  return heldSplitFromMeasured(source.heldMsWithin(window.startMs, window.endMs), windowMs)
}

/** The two fields a slow line adds when part of it fell inside a loop-held window; nothing otherwise. */
export const heldSplitFields = (
  wallStartMs: number,
  windowMs: number,
  options: { source?: LoopHeldWindows; pair?: ClockPair } = {}
): { heldMs?: number; ownMs?: number } =>
  heldSplitForWallWindow(wallStartMs, windowMs, options) ?? {}
