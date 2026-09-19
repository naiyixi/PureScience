import type { StorageUsage } from './usage'

// Disk usage is a full walk of the data root (measured ~15s on a 7 GB root), and the Storage panel
// asks for it every time it opens. Numbers that are a minute old are far better than a panel stuck on
// "Loading…", so this keeps the last reading and refreshes it behind the user's back.
export type StorageUsageCacheOptions = {
  compute: (dataRoot: string) => Promise<StorageUsage>
  ttlMs?: number
  now?: () => number
}

export type StorageUsageCache = {
  read: (dataRoot: string) => Promise<StorageUsage>
  warm: (dataRoot: string) => void
  clear: () => void
}

const DEFAULT_TTL_MS = 60_000

// Shown only when the very first read of a root has nothing to hand back yet.
const EMPTY_USAGE: StorageUsage = { categories: [], totalBytes: 0 }

// The cold-read answer: the walk is started and the caller is told the numbers are still coming. Waiting for it
// is what put a measured 13.7 s in front of the first caller on a real 7 GB root, and the panel can say
// "measuring" for those seconds far more honestly than it can show a zero it does not believe.
const PENDING_USAGE: StorageUsage = { ...EMPTY_USAGE, pending: true }

export const createStorageUsageCache = (options: StorageUsageCacheOptions): StorageUsageCache => {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? (() => Date.now())
  let entry: { dataRoot: string; usage: StorageUsage; at: number } | undefined
  // At most one scan per root at a time: a burst of reads must not start a burst of walks.
  let inFlight: { dataRoot: string; promise: Promise<void> } | undefined

  const refresh = (dataRoot: string): Promise<void> => {
    if (inFlight && inFlight.dataRoot === dataRoot) return inFlight.promise
    const promise = options
      .compute(dataRoot)
      .then((usage) => {
        entry = { dataRoot, usage, at: now() }
      })
      // A failed walk keeps the previous numbers: the reader must never see an error where numbers
      // used to be, and the next read simply tries again.
      .catch(() => {})
      .finally(() => {
        if (inFlight && inFlight.promise === promise) inFlight = undefined
      })
    inFlight = { dataRoot, promise }
    return promise
  }

  return {
    read: async (dataRoot) => {
      if (entry && entry.dataRoot === dataRoot) {
        if (now() - entry.at >= ttlMs) void refresh(dataRoot)
        return entry.usage
      }
      // Nothing for this root yet: start the walk and answer now. The caller gets `pending` instead of a stall
      // (13.7 s measured on a real root) and sees the real numbers from its next read on.
      void refresh(dataRoot)
      return PENDING_USAGE
    },
    warm: (dataRoot) => {
      void refresh(dataRoot)
    },
    clear: () => {
      entry = undefined
      inFlight = undefined
    }
  }
}
