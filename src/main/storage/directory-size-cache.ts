import type { DirectorySizeMeasurement } from './usage'

// Why this exists (2026-11-11). `manage_environments(action:"list")` sizes every named prefix so the row
// can say what it occupies. Sizing a prefix is a FULL recursive walk with one `stat` per file: on this
// machine's real prefixes that is 1.65 GB / 44,716 files and measured 4.8–5.0 s of handler time per call
// (`runtime:manage-named-environments`: durationMs 11.2 s / 18.2 s, cpuShare 0.98 / 0.75, attribution
// cpu-bound-in-process, ownMs 4,760 / 4,991 — the rest was the event loop stalled behind it). The window
// asks for that list the moment the Runtimes panel opens, and the package dialog asks for it again to
// resolve a name it only reads the NAMES of.
//
// A prefix's size is a slow-changing fact about a directory the app itself owns, so it belongs behind the
// same doctrine as the disk-usage panel: hand back the last reading immediately, refresh it behind the
// reader, and on a cold read answer "not measured yet" (an ABSENT size — never a 0) instead of parking the
// main process. Three states stay distinct: a number that was measured, `undefined` (nothing measured for
// this prefix yet), and `unavailable` from the walker (we could not look), which is remembered only long
// enough to stop a burst of reads from re-walking an unreadable tree once per read.
export type DirectorySize = { bytes: number; at: number }

export type DirectorySizeCacheOptions = {
  measure: (dir: string) => Promise<DirectorySizeMeasurement>
  ttlMs?: number
  now?: () => number
  // How long a read may wait for a walk that is already (or newly) running. Small on purpose: the caller
  // is an IPC handler, and its latency is what the panel feels. A read that gives up mid-walk does NOT
  // cancel it — the walk finishes into the cache and the next read gets the number.
  waitBudgetMs?: number
}

export type DirectorySizeCache = {
  // The last measured size, or undefined when nothing has been measured yet. Never a fabricated 0.
  read: (dir: string) => Promise<number | undefined>
  // Drop one prefix's reading (after the app itself changes or removes it).
  invalidate: (dir: string) => void
  clear: () => void
}

const DEFAULT_TTL_MS = 60_000
const DEFAULT_WAIT_BUDGET_MS = 250

export const createDirectorySizeCache = (
  options: DirectorySizeCacheOptions
): DirectorySizeCache => {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const waitBudgetMs = options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS
  const now = options.now ?? (() => Date.now())
  const readings = new Map<string, DirectorySize>()
  // At most one walk per directory at a time: the panel's follow-up reads must JOIN the walk in flight,
  // not pile another full walk of the same tree on top of it.
  const walks = new Map<string, Promise<void>>()
  // A failed look is not a reading, so it is not cached as a number. It is remembered for one TTL so a
  // burst of reads does not re-walk a tree nobody can list (each attempt costs the same seconds).
  const failedAt = new Map<string, number>()

  const measureInto = (dir: string): Promise<void> => {
    const running = walks.get(dir)
    if (running) return running
    const walk = options
      .measure(dir)
      .then((measurement) => {
        if (measurement.state !== 'measured') {
          failedAt.set(dir, now())
          return
        }
        readings.set(dir, { bytes: measurement.bytes, at: now() })
        failedAt.delete(dir)
      })
      .catch(() => {
        failedAt.set(dir, now())
      })
      .finally(() => {
        if (walks.get(dir) === walk) walks.delete(dir)
      })
    walks.set(dir, walk)
    return walk
  }

  // `true` when the walk settled inside the budget. The timer is always cleared: a pending timeout would
  // otherwise keep the process (and every reader of this cache) alive for its remainder.
  const settlesWithin = (walk: Promise<void>): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), waitBudgetMs)
      void walk.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })

  return {
    read: async (dir) => {
      const cached = readings.get(dir)
      if (cached) {
        // Stale numbers are still numbers the panel can show; the new one lands behind the reader.
        if (now() - cached.at >= ttlMs) void measureInto(dir)
        return cached.bytes
      }
      const attempt = failedAt.get(dir)
      if (attempt !== undefined && now() - attempt < ttlMs) return undefined
      const walk = measureInto(dir)
      if (!(await settlesWithin(walk))) return undefined
      return readings.get(dir)?.bytes
    },
    invalidate: (dir) => {
      readings.delete(dir)
      failedAt.delete(dir)
    },
    clear: () => {
      readings.clear()
      failedAt.clear()
    }
  }
}
