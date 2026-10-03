// Incremental full-text index storage (S3). The search path itself lives in global-search-service; this
// module owns ONLY the durable side: what has been indexed, what changed, where it resumes, and what the
// store could not take.
//
// Three rules shape it, and each one exists because the alternative is a silent lie:
//   * a missing/removed index directory reads as "coverage is empty", never as "there is nothing to find"
//     — the caller must be able to tell those apart (parent plan, acceptance ③);
//   * resuming never moves the processed counter backwards: the checkpoint is written after each applied
//     batch, so a crash mid-index loses at most one batch (acceptance ②);
//   * hitting the storage cap is NAMED (`blocked.byCap` + the ids it skipped), never a quiet drop
//     (acceptance: coverage must stay readable).
//
// Fingerprints decide what to re-index: a candidate whose fingerprint is unchanged is left alone, so a
// query after a large corpus is imported only pays for what actually moved.

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Bumped when the on-disk shape changes. A file written by a DIFFERENT version is treated as unreadable
// (coverage empty) rather than parsed on a hope.
export const SEARCH_INDEX_SCHEMA_VERSION = 1

// Storage budget. Reaching it is reported by name, with the ids that were skipped.
export const SEARCH_INDEX_MAX_BYTES = 256 * 1024 * 1024

// Per-entry text budget, matching the message-search budget so one huge file cannot dominate the store.
export const SEARCH_INDEX_MAX_ENTRY_CHARS = 20_000

export type SearchIndexEntry = {
  id: string
  scope: string
  fingerprint: string
  indexedAt: string
  bytes: number
}

/** What has been read out of a corpus item, ready to be matched later. */
export type SearchIndexRecord = SearchIndexEntry & { text: string }

export type SearchIndexCandidate = {
  id: string
  scope: string
  fingerprint: string
  /** The text to store. Truncated to SEARCH_INDEX_MAX_ENTRY_CHARS by the caller or here, either way the
   *  stored `bytes` says what was actually kept. */
  text: string
}

/** Where an interrupted build resumes. `processed` is monotone: it never decreases across runs. */
export type SearchIndexCheckpoint = {
  scope: string
  lastId?: string
  processed: number
  startedAt: string
  updatedAt: string
}

export type SearchIndexState = {
  /** False when the directory is absent/unreadable for this schema version ⇒ coverage is EMPTY, not
   *  "nothing matched". */
  present: boolean
  entries: SearchIndexEntry[]
  checkpoint?: SearchIndexCheckpoint
  totalBytes: number
}

export type SearchIndexPlan = {
  /** Candidates that are new or whose fingerprint moved — the only ones a build may re-read. */
  toIndex: SearchIndexCandidate[]
  /** Ids held in the index that the candidate set no longer contains. */
  toDrop: string[]
  /** True when the index already describes exactly these candidates. */
  unchanged: boolean
}

export type SearchIndexWriteResult = {
  entries: SearchIndexEntry[]
  /** Ids accepted in this batch. */
  written: string[]
  /** Set when the storage cap refused part of the batch; `skipped` names what was left out. */
  blocked?: { reason: 'storage-cap'; skipped: string[] }
}

const stateDirectory = (root: string): string => join(root, 'search-index')
const segmentsDirectory = (root: string): string => join(stateDirectory(root), 'segments')
const manifestPath = (root: string): string => join(stateDirectory(root), 'manifest.json')

const EMPTY_STATE: SearchIndexState = { present: false, entries: [], totalBytes: 0 }

const isEntry = (value: unknown): value is SearchIndexEntry => {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    typeof entry.scope === 'string' &&
    typeof entry.fingerprint === 'string' &&
    typeof entry.indexedAt === 'string' &&
    typeof entry.bytes === 'number'
  )
}

const isCheckpoint = (value: unknown): value is SearchIndexCheckpoint => {
  if (typeof value !== 'object' || value === null) return false
  const checkpoint = value as Record<string, unknown>
  return (
    typeof checkpoint.scope === 'string' &&
    typeof checkpoint.processed === 'number' &&
    typeof checkpoint.startedAt === 'string' &&
    typeof checkpoint.updatedAt === 'string'
  )
}

/**
 * Reads the durable state. An absent directory, an unparsable manifest, or a manifest written by another
 * schema version all answer `present: false` — the caller then reports EMPTY COVERAGE, which is a
 * different sentence from "no results".
 */
export const readSearchIndex = async (root: string): Promise<SearchIndexState> => {
  let raw: string
  try {
    raw = await readFile(manifestPath(root), 'utf8')
  } catch {
    return EMPTY_STATE
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed.schemaVersion !== SEARCH_INDEX_SCHEMA_VERSION) return EMPTY_STATE
    const entries = Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : []
    const checkpoint = isCheckpoint(parsed.checkpoint) ? parsed.checkpoint : undefined
    return {
      present: true,
      entries,
      ...(checkpoint ? { checkpoint } : {}),
      totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0)
    }
  } catch {
    return EMPTY_STATE
  }
}

/**
 * Decides what a build must do, WITHOUT touching the corpus: candidates whose fingerprint is unchanged
 * are skipped, ids the candidate set no longer holds are dropped. The same inputs always give the same
 * plan, so a resumed build and a fresh one cannot diverge on what counts as work.
 */
export const planSearchIndex = (
  state: SearchIndexState,
  candidates: readonly SearchIndexCandidate[]
): SearchIndexPlan => {
  const known = new Map(state.entries.map((entry) => [entry.id, entry]))
  const wanted = new Set(candidates.map((candidate) => candidate.id))
  const toIndex = candidates.filter((candidate) => {
    const entry = known.get(candidate.id)
    return entry === undefined || entry.fingerprint !== candidate.fingerprint
  })
  const toDrop = state.entries
    .filter((entry) => !wanted.has(entry.id))
    .map((entry) => entry.id)
    .sort()
  return { toIndex, toDrop, unchanged: toIndex.length === 0 && toDrop.length === 0 }
}

const writeAtomic = async (path: string, contents: string): Promise<void> => {
  const temporary = `${path}.tmp`
  await writeFile(temporary, contents, 'utf8')
  await rename(temporary, path)
}

/**
 * Applies one batch: appends the new/changed records to their scope segment, rewrites the segment of any
 * scope that lost entries, and writes the manifest + checkpoint last. The cap is checked BEFORE writing,
 * so a refused batch leaves the store exactly as it was.
 */
export const applySearchIndexPlan = async (
  root: string,
  state: SearchIndexState,
  plan: { toIndex: readonly SearchIndexCandidate[]; toDrop: readonly string[] },
  checkpoint: SearchIndexCheckpoint,
  options: { maxBytes?: number } = {}
): Promise<SearchIndexWriteResult> => {
  const maxBytes = options.maxBytes ?? SEARCH_INDEX_MAX_BYTES
  const records: SearchIndexRecord[] = plan.toIndex.map((candidate) => {
    const text = candidate.text.slice(0, SEARCH_INDEX_MAX_ENTRY_CHARS)
    return {
      id: candidate.id,
      scope: candidate.scope,
      fingerprint: candidate.fingerprint,
      indexedAt: checkpoint.updatedAt,
      bytes: Buffer.byteLength(text, 'utf8'),
      text
    }
  })
  const incoming = records.reduce((sum, record) => sum + record.bytes, 0)
  if (state.totalBytes + incoming > maxBytes) {
    return {
      entries: state.entries,
      written: [],
      blocked: { reason: 'storage-cap', skipped: records.map((record) => record.id) }
    }
  }

  // Dropped ids leave the index in this same batch (a deleted file must stop matching), so the manifest
  // and the affected segments are rewritten together with the writes.
  const dropped = state.entries.filter((entry) => plan.toDrop.includes(entry.id))
  const entries: SearchIndexEntry[] = state.entries.filter(
    (entry) => !plan.toDrop.includes(entry.id)
  )
  for (const record of records) {
    const next: SearchIndexEntry = {
      id: record.id,
      scope: record.scope,
      fingerprint: record.fingerprint,
      indexedAt: record.indexedAt,
      bytes: record.bytes
    }
    const at = entries.findIndex((entry) => entry.id === record.id)
    if (at >= 0) entries[at] = next
    else entries.push(next)
  }

  await mkdir(segmentsDirectory(root), { recursive: true })
  // Rewrite each touched scope's segment (append-then-compact is not worth the crash surface yet).
  const touched = new Set([
    ...records.map((record) => record.scope),
    ...dropped.map((entry) => entry.scope)
  ])
  for (const scope of touched) {
    const inScope = entries.filter((entry) => entry.scope === scope)
    if (inScope.length === 0) {
      await rm(join(segmentsDirectory(root), `${scope}.jsonl`), { force: true })
      continue
    }
    const lines = inScope.map((entry) => {
      const record =
        records.find((candidate) => candidate.id === entry.id) ??
        // Unchanged entries keep their text: read it back from the existing segment.
        undefined
      return { entry, record }
    })
    const rewritten: string[] = []
    for (const { entry, record } of lines) {
      if (record) {
        rewritten.push(JSON.stringify(record))
        continue
      }
      const existing = await readSegmentRecord(root, entry.scope, entry.id)
      rewritten.push(JSON.stringify(existing ?? { ...entry, text: '' }))
    }
    await writeAtomic(join(segmentsDirectory(root), `${scope}.jsonl`), `${rewritten.join('\n')}\n`)
  }

  // Disk is authoritative for the COUNTER: a caller that hands over a state without the checkpoint (or a
  // stale copy) must still not be able to move the processed count backwards.
  const priorCheckpoint = state.checkpoint ?? (await readSearchIndex(root)).checkpoint
  await writeAtomic(
    manifestPath(root),
    `${JSON.stringify(
      {
        schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
        entries,
        checkpoint: monotonicCheckpoint(priorCheckpoint, checkpoint)
      },
      null,
      2
    )}\n`
  )
  return { entries, written: records.map((record) => record.id) }
}

const monotonicCheckpoint = (
  previous: SearchIndexCheckpoint | undefined,
  next: SearchIndexCheckpoint
): SearchIndexCheckpoint => {
  if (previous === undefined || previous.scope !== next.scope) return next
  if (next.processed >= previous.processed) return next
  return { ...next, processed: previous.processed, startedAt: previous.startedAt }
}

/** Convenience for a batch that only ADDS or REPLACES entries (nothing dropped). */
export const applySearchIndexBatch = (
  root: string,
  state: SearchIndexState,
  batch: readonly SearchIndexCandidate[],
  checkpoint: SearchIndexCheckpoint,
  options: { maxBytes?: number } = {}
): Promise<SearchIndexWriteResult> =>
  applySearchIndexPlan(root, state, { toIndex: batch, toDrop: [] }, checkpoint, options)

const readSegmentRecord = async (
  root: string,
  scope: string,
  id: string
): Promise<SearchIndexRecord | undefined> => {
  try {
    const raw = await readFile(join(segmentsDirectory(root), `${scope}.jsonl`), 'utf8')
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      const parsed = JSON.parse(line) as SearchIndexRecord
      if (parsed.id === id) return parsed
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Reads every stored record, for the query path to match against. A missing segment reads as none. */
export const readSearchIndexRecords = async (root: string): Promise<SearchIndexRecord[]> => {
  let names: string[]
  try {
    names = await readdir(segmentsDirectory(root))
  } catch {
    return []
  }
  const records: SearchIndexRecord[] = []
  for (const name of names.filter((entry) => entry.endsWith('.jsonl')).sort()) {
    try {
      const raw = await readFile(join(segmentsDirectory(root), name), 'utf8')
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        records.push(JSON.parse(line) as SearchIndexRecord)
      }
    } catch {
      // A segment that cannot be read contributes nothing; the manifest still governs coverage.
    }
  }
  return records
}

/** Removes the index entirely — the acceptance ③ primitive: coverage must then read EMPTY. */
export const removeSearchIndex = async (root: string): Promise<void> => {
  await rm(stateDirectory(root), { recursive: true, force: true })
}

/** Bytes the index occupies on disk (manifest + segments), for the honest size readout. */
export const searchIndexSizeBytes = async (root: string): Promise<number> => {
  const dir = stateDirectory(root)
  try {
    const names = await readdir(dir)
    let total = 0
    for (const name of names) {
      if (name === 'segments') {
        for (const segment of await readdir(join(dir, 'segments'))) {
          total += (await stat(join(dir, 'segments', segment))).size
        }
        continue
      }
      total += (await stat(join(dir, name))).size
    }
    return total
  } catch {
    return 0
  }
}
