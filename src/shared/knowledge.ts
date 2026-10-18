// What the knowledge store registers: where a piece of knowledge came from, and the fingerprint that lets
// anyone re-derive it later. Shared rather than owned by the store because the entry layer, the store and
// the tests must agree on one shape — two definitions would drift into a request the transport accepts and
// the store refuses.
export type KnowledgeSourceKind = 'file' | 'url'

// Size and content digest together: the digest is what a reader recomputes, the byte count is what makes a
// truncated or empty read obvious without hashing anything.
export type KnowledgeFingerprint = {
  algorithm: 'sha256'
  value: string
  bytes: number
}

export type KnowledgeSource = {
  id: string
  kind: KnowledgeSourceKind
  // A file's absolute path, or the URL exactly as it was first registered.
  location: string
  // A URL: where the request actually landed after redirects, and the title we can show a reader.
  finalUrl?: string
  // What a reader sees. For a file it is the basename; for a URL, the final URL.
  label: string
  fingerprint: KnowledgeFingerprint
  // Set when this file came in as part of a managed tree, so a folder's entries can be told apart from
  // files registered one at a time.
  folder?: string
  registeredAt: number
  updatedAt: number
}

export type KnowledgeStoreSnapshot = { sources: KnowledgeSource[] }

// What a session-external reader gets. `unreadable` is reported rather than folded into "no sources":
// "nothing was registered" and "we could not look" lead to different actions.
export type KnowledgeOverview = {
  sources: KnowledgeSource[]
  unreadable: boolean
  /** The last completed sweep, so "when did this last run, and what did it do" is answerable without a second
   *  channel. Absent when nothing has swept yet — which is different from a sweep that found nothing. */
  lastSweep?: KnowledgeSweepRecord
  /** Set when a sweep note is on disk but will not be read. Distinct from `lastSweep` being absent on purpose:
   *  "no sweep has run" and "we cannot say what the last one did" lead to different actions, and folding the
   *  second into the first would have the screen report a fact nothing verified. */
  lastSweepUnreadable?: boolean
}

export type KnowledgeSweepRecord = {
  /** ISO timestamp of the sweep that produced the counts. */
  at: string
  scanned: number
  kept: number
  /** How many copies this sweep deleted (not the digests — the record stays small and readable). */
  removed: number
  /** Copies the sweep could not delete. Non-zero means the store needs attention, not an apology. */
  failed: number
  bytesFreed: number
  /** Copies deleted because their bytes no longer hashed to their own name. Optional because notes written before
   *  this count existed have no such reading: "not checked then" is not "none found", and an old note read as zero
   *  would be a claim that sweep never made. */
  mismatched?: number
}

// What sweeping the copy store found. A copy is named by the digest of its own bytes, so a copy no registered
// source names any more can never answer anything — it is bytes with no reader. Counted rather than summarised,
// because "we deleted three" and "one would not delete" lead to different actions, and the buckets below add up
// to `scanned` (a sweep that cannot account for every entry must not look like it did).
//
// `removed` and `mismatched` are separate buckets on purpose: "nobody references this copy" and "this copy is not
// the bytes its name claims" are different findings, and a store whose copies were edited underneath it needs a
// different response from one that merely accumulated orphans.
export type KnowledgeCopySweep = {
  /** Every entry in `<data root>/knowledge/contents`: digest-named files, plus anything else that sits there. */
  scanned: number
  /** Digest-named copies still referenced by a registered URL source AND still hashing to their own name. */
  kept: number
  /** Digest-named copies this sweep deleted because no source names them. */
  removed: string[]
  /** Digest-named copies whose bytes no longer hash to their own name — deleted, because such a copy cannot
   *  answer truthfully: a search reads it by name and would cite text the fingerprint never covered. */
  mismatched: string[]
  /** Digest-named copies that could not be deleted — named, never counted in `removed` or `mismatched`. */
  failed: string[]
  /** Bytes actually freed: the sizes of `removed` plus `mismatched`. */
  bytesFreed: number
  /** Entries that are not digest-named regular files: left alone, counted so the totals still add up. */
  ignored: number
}

export type KnowledgeRegistration =
  { kind: 'file'; path: string } | { kind: 'folder'; path: string } | { kind: 'url'; url: string }

export type KnowledgeRefusalCode =
  | 'source-outside-roots'
  | 'source-not-found'
  | 'source-not-a-file'
  | 'source-not-a-directory'
  | 'source-unreadable'
  | 'url-fetch-failed'
  | 'record-unreadable'
  | 'copy-store-unreadable'

// A named refusal, one per reason a source cannot be registered as asked: an empty read, a redirect loop
// and a path outside the managed roots are different mistakes and the caller can act on the difference.
export class KnowledgeValidationError extends Error {
  readonly code: KnowledgeRefusalCode

  constructor(code: KnowledgeRefusalCode, message: string) {
    super(message)
    this.name = 'KnowledgeValidationError'
    this.code = code
  }
}

// A citation is the whole point of the knowledge store: a result must be traceable back to the bytes it
// came from, so a reader can re-derive it. `sha256` is computed on the READ side (see the search service),
// never taken on trust from an index.
export type KnowledgeLocator =
  | { kind: 'file'; path: string; startLine: number; endLine: number }
  | { kind: 'url'; url: string }
  | { kind: 'pdf'; path: string; page: number }

export type KnowledgeCitation = {
  sourceId: string
  locator: KnowledgeLocator
  sha256: string
}

// `mode` says what was actually consulted, not what we wish had been: 'lexical' when only the
// incremental index answered, 'hybrid' when an embedding source answered too. 'semantic' is reserved
// for a future version that can rank without the lexical index — it is not produced here.
export type KnowledgeSearchMode = 'lexical' | 'semantic' | 'hybrid'
// Every way the semantic side can fail to contribute is named: not configured at all, configured and
// failed, configured and answered with nothing. A caller can act differently on each.
export type KnowledgeSearchDegradation =
  'semantic-source-unconfigured' | 'semantic-source-failed' | 'semantic-source-empty'

export type KnowledgeSearchResult = {
  sourceId: string
  label: string
  locator: KnowledgeLocator
  // The digest of the exact bytes this result was taken from, recomputed at read time.
  sha256: string
  // Present while only the lexical index answered: a row that says what it is. Absent once an
  // embedding source took part, because then `matchedBy` says more.
  lexicalOnly?: true
  // Which side(s) found this row — 'both' means the two independent methods agreed, which is a
  // different (and stronger) statement than either one alone.
  matchedBy?: 'lexical' | 'semantic' | 'both'
  // The fused score the ordering used, so a reader can see why one row ranked above another.
  score?: number
  // Set when a citation verifier re-read the location and the bytes no longer match. Absent means "not
  // found to have moved" — never "verified": the response's `verification` field says whether anyone looked.
  stale?: true
  // Set when the location could not be read at all — a different finding from `stale`, and not a retired
  // citation either.
  unreadable?: true
}

export type KnowledgeCoverage = {
  // What the index has actually seen, versus what it still owes. "No matches" and "not indexed yet" are
  // different answers and lead to different actions.
  indexed: number
  pending: number
}

export type KnowledgeSearchStatus = 'ok' | 'no-matches' | 'not-indexed'

export type KnowledgeSearchResponse = {
  status: KnowledgeSearchStatus
  mode: KnowledgeSearchMode
  degradation?: KnowledgeSearchDegradation
  // 'not-configured' is not a synonym for 'checked': it says nobody re-read the bytes, so no row below was
  // found fresh OR stale.
  verification: 'checked' | 'not-configured'
  coverage: KnowledgeCoverage
  results: KnowledgeSearchResult[]
}
