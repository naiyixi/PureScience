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
