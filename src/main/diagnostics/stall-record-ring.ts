// The stall watchdog reports each stall by writing one log line. That line is the full evidence, but it is
// only readable by grepping megabytes of runtime JSON — and the bundle copies logs newest-first under a byte
// cap, so the record of the hang that made someone export a bundle can already be rotated out by the time
// they do it. The support bundle is assembled exactly then, and "how many stalls, how long, and what did the
// machine look like inside them" is the first thing a maintainer asks.
//
// This keeps the last few records in memory, in the watchdog's own shape, so the bundle can carry them
// without re-parsing the log text: a parser would be a second vocabulary for the same record, and a log
// format change would make it report zero stalls — which reads exactly like a healthy machine.
//
// Bounded on purpose (a permanent diagnostic must not grow for the life of the process), and honest about
// what it dropped: `records` is the tail, `observed` is everything the watchdog saw, and `dropped` is the
// difference. Folding either into the other would turn "we saw 40 stalls" into "we saw 16".
//
// Deliberately a process-wide singleton for the same reason as `loop-held-windows`: the watchdog is started
// once in main and the bundle facts are assembled in the composition root, so neither needs a seam. Tests
// inject their own instance instead of reading this one.

import type { EventLoopStallRecord } from './event-loop-stall-watchdog'

/** A record plus the wall clock it was observed at, so a bundle reader can line it up with the logs. */
export type StallRecordSnapshot = EventLoopStallRecord & { at: string }

export type StallRecordSummary = {
  /** How many records are kept. Named so a reader can tell a full ring from a short history. */
  capacity: number
  /** Stalls the watchdog reported since it started (kept + dropped). */
  observed: number
  /** Stalls that were observed but are no longer kept: the oldest ones, dropped first. */
  dropped: number
  /** Wall clock of the oldest kept record (ISO 8601). Absent when nothing is kept. */
  oldestAt?: string
  /** Wall clock of the newest kept record (ISO 8601). Absent when nothing is kept. */
  newestAt?: string
  /**
   * Named rather than left for the reader to derive: `no-stalls-observed` means no window crossed the
   * watchdog's threshold since it started. It does not mean the machine was fine — an idle process and a
   * process that was never watched produce the same empty list, so the empty case says what it is.
   */
  status: 'records' | 'no-stalls-observed'
  /** Oldest first, so the tail reads as a timeline. */
  records: StallRecordSnapshot[]
}

export type StallRecordRing = {
  record: (record: EventLoopStallRecord) => void
  summary: () => StallRecordSummary
  /** Test seam: forget everything without rebuilding the ring. */
  clear: () => void
}

export type StallRecordRingInput = {
  /** Records kept: 16 covers a burst plus its aftermath at a few KB each. */
  capacity?: number
  /** Seam. Production leaves it alone. */
  now?: () => Date
}

const DEFAULT_CAPACITY = 16

export const createStallRecordRing = (input: StallRecordRingInput = {}): StallRecordRing => {
  const capacity = Math.max(1, Math.floor(input.capacity ?? DEFAULT_CAPACITY))
  const now = input.now ?? ((): Date => new Date())
  const records: StallRecordSnapshot[] = []
  let observed = 0

  const record = (entry: EventLoopStallRecord): void => {
    // The snapshot is shallow on purpose: the watchdog builds a fresh record per stall, and copying the
    // nested arrays would cost more than the ring saves.
    records.push({ ...entry, at: now().toISOString() })
    observed += 1
    while (records.length > capacity) records.shift()
  }

  const clear = (): void => {
    records.length = 0
    observed = 0
  }

  const summary = (): StallRecordSummary => {
    const kept = records.length
    const oldestAt = kept > 0 ? records[0].at : undefined
    const newestAt = kept > 0 ? records[kept - 1].at : undefined
    return {
      capacity,
      observed,
      dropped: observed - kept,
      ...(oldestAt ? { oldestAt } : {}),
      ...(newestAt ? { newestAt } : {}),
      status: kept > 0 ? 'records' : 'no-stalls-observed',
      records: [...records]
    }
  }

  return { record, summary, clear }
}

// Written by the event-loop watchdog, read by the support bundle facts.
export const sharedStallRecords: StallRecordRing = createStallRecordRing()
