// Connector readings, recorded per session so a Version can later be walked back to the bytes.
//
// The fingerprint alone was not enough: a reading was handed to whoever called the tool and then
// forgotten, so "which reading produced this artifact" had no answer to look up. This is the carrier —
// one JSON file per session under `.connector-readings/`, written by the main process only (atomic
// temp-file + rename), the same spine the annotation and bookmark stores use.
//
// Three rules, each with a consumer:
//
// 1. Attribution is SESSION + TIME WINDOW, stated as such. The connector service knows the session a
//    call came from and nothing finer, so the journal deliberately records no run id: a run id reaching
//    this layer would have come from RPC parameters, which are not authority. Every reader is told the
//    window, never left to assume per-run causality.
// 2. Recording NEVER throws into the call path. A connector call that succeeded must not fail because a
//    journal write did, so every failure here is swallowed and the absence surfaces later as
//    `not-recorded`. (One consequence, stated rather than hidden: a failed write is indistinguishable
//    from a session that read nothing. Recording is best-effort by construction and the rule above is
//    why.)
// 3. Bounded, and it says so. The journal answers "what was read in this session", so it keeps the
//    newest entries and reports how many it dropped instead of growing without limit.
// 4. One writer at a time per journal. Parallel connector calls in one session are ordinary, and a
//    plain read-modify-write loses every entry but the last — silently, with `dropped` still reporting
//    0. That is the failure this whole module exists to prevent, so writes are serialised (below).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  isReadingFingerprint,
  type ConnectorReadingFingerprint
} from '../../shared/reading-fingerprint'

export const CONNECTOR_READINGS_DIR = '.connector-readings'

/** Newest entries kept per session. Older ones are dropped and counted, never silently lost. */
export const MAX_SESSION_READINGS = 200

export type SessionReadingEntry = {
  /** When the reading was taken (ISO 8601), so a Version's window can be compared against it. */
  recordedAt: string
  reading: ConnectorReadingFingerprint
}

export type SessionReadingJournal = {
  schemaVersion: 1
  sessionId: string
  entries: SessionReadingEntry[]
  /** How many entries were dropped to stay inside the cap. Reported, so a short list is explainable. */
  dropped: number
}

export type SessionReadingsResult =
  | { state: 'available'; entries: SessionReadingEntry[]; dropped: number }
  | { state: 'unavailable'; reason: 'not-recorded' | 'unreadable' }

// A session id used as a file name: anything that could escape the directory (a separator, `..`, an
// empty string) is refused here rather than trusted from the caller. Refusal is silent by design —
// see rule 2 — and the absence is what a reader finally sees.
const isSafeSegment = (value: string): boolean =>
  value !== '' &&
  value !== '.' &&
  value !== '..' &&
  !value.includes('/') &&
  !value.includes('\\') &&
  value === value.trim()

const journalPath = (root: string, sessionId: string): string =>
  join(root, CONNECTOR_READINGS_DIR, `${sessionId}.json`)

// The tail of the write chain per journal path. Main is the only writer (see the header), so an
// in-process queue is enough: no lock file, and no second process to coordinate with.
const journalWriteTails = new Map<string, Promise<void>>()

const serialisePerJournal = <T>(key: string, work: () => Promise<T>): Promise<T> => {
  const previous = journalWriteTails.get(key) ?? Promise.resolve()
  // Run whether or not the previous write settled well: one failed write must not block the rest.
  const run = previous.then(work, work)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  journalWriteTails.set(key, tail)
  // Drop the entry once this is the last write in the chain, so the map does not grow per session.
  void tail.then(() => {
    if (journalWriteTails.get(key) === tail) journalWriteTails.delete(key)
  })
  return run
}

/** Read a session's journal. A missing file is `not-recorded` — never an empty success. */
export const readSessionReadings = async (
  root: string,
  sessionId: string
): Promise<SessionReadingsResult> => {
  if (!isSafeSegment(sessionId)) return { state: 'unavailable', reason: 'not-recorded' }
  let raw: string
  try {
    raw = await readFile(journalPath(root, sessionId), 'utf8')
  } catch {
    // ENOENT is the ordinary case for a session that never read anything.
    return { state: 'unavailable', reason: 'not-recorded' }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SessionReadingJournal>
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
      return { state: 'unavailable', reason: 'unreadable' }
    }
    const entries: SessionReadingEntry[] = []
    for (const entry of parsed.entries) {
      if (typeof entry !== 'object' || entry === null) {
        return { state: 'unavailable', reason: 'unreadable' }
      }
      const candidate = entry as SessionReadingEntry
      if (typeof candidate.recordedAt !== 'string') {
        return { state: 'unavailable', reason: 'unreadable' }
      }
      // A digest that is not a well-formed fingerprint cannot be recomputed by anyone, so serving it
      // as a reading would advertise a check that cannot be performed. Fail closed instead: the
      // projection already says `unreadable` for exactly this.
      if (!isReadingFingerprint(candidate.reading)) {
        return { state: 'unavailable', reason: 'unreadable' }
      }
      entries.push(candidate)
    }
    return {
      state: 'available',
      entries,
      dropped: typeof parsed.dropped === 'number' ? parsed.dropped : 0
    }
  } catch {
    // A corrupt journal is reported as unreadable rather than as "nothing was read".
    return { state: 'unavailable', reason: 'unreadable' }
  }
}

/**
 * Append readings to a session's journal.
 *
 * Resolves either way: the caller is a connector call that has already succeeded, and a journal problem
 * is not its failure. Returns whether the write landed, so a test can assert the path without the call
 * path having to care.
 */
export const recordSessionReadings = async (
  root: string,
  sessionId: string,
  readings: readonly ConnectorReadingFingerprint[],
  now: () => Date = () => new Date()
): Promise<boolean> => {
  if (readings.length === 0) return false
  if (!isSafeSegment(sessionId)) return false
  const target = journalPath(root, sessionId)
  return serialisePerJournal(target, async () => {
    try {
      const existing = await readSessionReadings(root, sessionId)
      const previous = existing.state === 'available' ? existing.entries : []
      const droppedBefore = existing.state === 'available' ? existing.dropped : 0
      const stamp = now().toISOString()
      const appended = [...previous, ...readings.map((reading) => ({ recordedAt: stamp, reading }))]
      const overflow = Math.max(0, appended.length - MAX_SESSION_READINGS)
      const journal: SessionReadingJournal = {
        schemaVersion: 1,
        sessionId,
        entries: overflow > 0 ? appended.slice(overflow) : appended,
        dropped: droppedBefore + overflow
      }

      const directory = join(root, CONNECTOR_READINGS_DIR)
      await mkdir(directory, { recursive: true })
      // Atomic: a reader never sees a half-written journal, and a crash mid-write leaves the old one.
      const temporary = `${target}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(journal), 'utf8')
      await rename(temporary, target)
      return true
    } catch {
      return false
    }
  })
}
