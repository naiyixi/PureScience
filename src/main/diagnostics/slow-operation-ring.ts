// The slow-handler lines already answer the right question — how long the caller waited, how much of that
// window the process was actually running, and whether the event loop was held by other work (see
// `ipc-rejection` and `application-command-router`). What they cannot do is travel: they are log lines, and
// the log on this machine reached 81 MB / 3.7 M lines, of which one old stall storm was 3.5 M. The support
// bundle copies logs newest-first under an 8 MB cap, so by the time someone exports a bundle about "the
// window took 20 seconds", the line that would explain it may already be rotated out.
//
// This ring is the machine-readable tail of those same records, in the producers' own field names, handed to
// the bundle in the same process. It is deliberately not a re-parse of the log text: a parser would be a
// second vocabulary for the same evidence, and a log-format change would make it report zero slow calls —
// which reads exactly like a fast application.
//
// Bounded on purpose (a permanent diagnostic must not grow for the life of the process), and honest about
// what it dropped: `records` is the tail, `observed` counts everything, `dropped` is the difference. An
// absent field means the producer did not measure it (never "zero"), and an empty list names itself
// `no-slow-operations-observed` rather than leaving a reader to guess whether anyone was watching.
//
// Deliberately a process-wide singleton, for the same reason as `stall-record-ring`: the producers are
// created where their modules load and the bundle facts are assembled in the composition root, so a
// composition-root hand-off would add a seam neither side needs. Tests inject their own instance.

import type { ActivityAttribution } from './cpu-attribution'

export type SlowOperationKind = 'ipc' | 'command'

/** The call, and what the producer measured around it. Optional fields are "not measured", never zero. */
export type SlowOperationFacts = Readonly<{
  kind: SlowOperationKind
  /** IPC channel or application-command name — the identifier a maintainer can grep for. */
  name: string
  /** IPC only: which surface issued the call (`renderer`, `web`, …). */
  surface?: string
  /** IPC only: where inside that surface the call came from. */
  location?: string
  /**
   * Commands only: which diagnostic code this record came from. A rejected command has no result, so a
   * reader needs to know that the duration it sees ended in a throw.
   */
  code?: 'slow-handler' | 'handler-rejected'
  durationMs: number
  cpuMs?: number
  cpuShare?: number
  attribution?: ActivityAttribution
  /** Part of `durationMs` the process was not running at all (stall-watchdog windows). */
  heldMs?: number
  /** The remainder that was ours: `durationMs - heldMs`. */
  ownMs?: number
  /** Present instead of the split when the stall ring had already dropped the windows covering the span. */
  heldUnmeasured?: 'windows-dropped'
}>

/** A record plus the wall clock it finished at, so a bundle reader can line it up with the logs. */
export type SlowOperationRecord = SlowOperationFacts & { at: string }

export type SlowOperationSummary = {
  /** How many records are kept. Named so a reader can tell a full ring from a short history. */
  capacity: number
  /** Slow operations reported since the ring was created (kept + dropped). */
  observed: number
  /** Reported but no longer kept: the oldest ones, dropped first. */
  dropped: number
  /** Wall clock of the oldest kept record (ISO 8601). Absent when nothing is kept. */
  oldestAt?: string
  /** Wall clock of the newest kept record (ISO 8601). Absent when nothing is kept. */
  newestAt?: string
  /**
   * Named rather than derived: `no-slow-operations-observed` means the producers reported nothing over the
   * threshold since this process started. It does not mean the application was fast — a process that never
   * served a request produces the same empty list.
   */
  status: 'records' | 'no-slow-operations-observed'
  /** Oldest first, so the tail reads as a timeline. */
  records: SlowOperationRecord[]
}

export type SlowOperationRing = {
  record: (facts: SlowOperationFacts) => void
  summary: () => SlowOperationSummary
  /** Test seam: forget everything without rebuilding the ring. */
  clear: () => void
}

export type SlowOperationRingInput = {
  /** Records kept: 24 covers a settings-mount burst plus its aftermath at well under a KB each. */
  capacity?: number
  /** Seam. Production leaves it alone. */
  now?: () => Date
}

const DEFAULT_CAPACITY = 24

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * Keeps only the fields the producer actually measured. A reader must be able to tell "the split was not
 * needed" from "the split was needed and unavailable", so an explicitly named state
 * (`heldUnmeasured: 'windows-dropped'`) survives while a zero-valued optional field does not become a claim.
 */
const normalize = (facts: SlowOperationFacts): SlowOperationFacts => ({
  kind: facts.kind,
  name: facts.name,
  ...(facts.surface ? { surface: facts.surface } : {}),
  ...(facts.location ? { location: facts.location } : {}),
  ...(facts.code ? { code: facts.code } : {}),
  durationMs: isFiniteNumber(facts.durationMs) ? facts.durationMs : 0,
  ...(isFiniteNumber(facts.cpuMs) ? { cpuMs: facts.cpuMs } : {}),
  ...(isFiniteNumber(facts.cpuShare) ? { cpuShare: facts.cpuShare } : {}),
  ...(facts.attribution ? { attribution: facts.attribution } : {}),
  ...(isFiniteNumber(facts.heldMs) ? { heldMs: facts.heldMs } : {}),
  ...(isFiniteNumber(facts.ownMs) ? { ownMs: facts.ownMs } : {}),
  ...(facts.heldUnmeasured ? { heldUnmeasured: facts.heldUnmeasured } : {})
})

export const createSlowOperationRing = (input: SlowOperationRingInput = {}): SlowOperationRing => {
  const capacity = Math.max(1, Math.floor(input.capacity ?? DEFAULT_CAPACITY))
  const now = input.now ?? ((): Date => new Date())
  const records: SlowOperationRecord[] = []
  let observed = 0

  const record = (facts: SlowOperationFacts): void => {
    const at = now().toISOString()
    records.push({ ...normalize(facts), at })
    observed += 1
    while (records.length > capacity) records.shift()
  }

  const clear = (): void => {
    records.length = 0
    observed = 0
  }

  const summary = (): SlowOperationSummary => {
    const kept = records.length
    const oldestAt = kept > 0 ? records[0].at : undefined
    const newestAt = kept > 0 ? records[kept - 1].at : undefined
    return {
      capacity,
      observed,
      dropped: observed - kept,
      ...(oldestAt ? { oldestAt } : {}),
      ...(newestAt ? { newestAt } : {}),
      status: kept > 0 ? 'records' : 'no-slow-operations-observed',
      records: [...records]
    }
  }

  return { record, summary, clear }
}

// Written by both slow-reporting producers, read by the support bundle facts.
export const sharedSlowOperations: SlowOperationRing = createSlowOperationRing()
