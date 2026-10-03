import {
  applySearchIndexPlan,
  planSearchIndexTick,
  readSearchIndex,
  SEARCH_INDEX_MAX_ENTRY_CHARS,
  type SearchIndexCandidate,
  type SearchIndexEntry,
  type SearchIndexState
} from './index-store'

// The FILLING half of the incremental index (S3-S1b). index-store.ts owns the durable shape; this module
// owns "what work is there to do right now" and does it a bounded tick at a time.
//
// Two properties are the whole point, and both are asserted by the tests rather than promised in prose:
//   1. an unchanged item is never re-read (that is what makes a resume cheap), and
//   2. an item this module cannot fingerprint or cannot read is NAMED, never silently dropped — because a
//      silently dropped item is indistinguishable from "there was nothing there", which is the shape of
//      lie this codebase refuses to tell.

/** One item the listing already knows about. */
export type SearchIndexSource = {
  id: string
  scope: 'uploads' | 'artifacts'
  projectId: string
  title: string
  relativePath: string
  timestamp?: string
  /** A content hash the corpus already publishes (upload versions carry one). Preferred over stat data:
   *  a checksum changes when the BYTES change, while a timestamp can be touched without an edit. */
  checksum?: string
  /** Fallback fingerprint when no checksum exists. Both halves are required — a size with no timestamp
   *  cannot tell "edited in place to the same length" from "untouched". */
  size?: number
  modifiedAt?: string
}

/** What happened to one source in a tick. Every source gets exactly one disposition. */
export type SearchIndexDisposition =
  | { id: string; kind: 'indexed' }
  | { id: string; kind: 'unchanged' }
  | { id: string; kind: 'unfingerprintable' }
  | { id: string; kind: 'unreadable' }
  /** Read and planned, but the storage cap refused it — a named non-write, never counted as indexed. */
  | { id: string; kind: 'capped' }

export type SearchIndexTickDeps = {
  /** Where the index lives (the caller owns the root; tests point it at a tmpdir). */
  root: string
  /** Reads the item's text. `undefined` means "could not be read" — NOT "empty". */
  readText(id: string): Promise<string | undefined>
  /** How many items this tick may read text for. Bounds the work; the caller decides the interval. */
  budget: number
  /** Timestamp stamped onto the checkpoint this tick writes. */
  now(): string
  /** Storage cap for this tick's write. Injected so the refusal path is testable (production uses the
   *  store's own SEARCH_INDEX_MAX_BYTES default). */
  maxBytes?: number
}

export type SearchIndexTickResult = {
  state: SearchIndexState
  disposition: SearchIndexDisposition[]
  /** True when the budget cut work off — the caller should tick again rather than treat this as done. */
  truncated: boolean
}

/**
 * The fingerprint of a source, or `undefined` when this module cannot judge whether the item changed.
 * `undefined` is a real answer: such an item is reported as `unfingerprintable` and left out of the index,
 * so it keeps counting as pending instead of being written under a fingerprint that cannot detect edits.
 */
export const fingerprintOf = (source: SearchIndexSource): string | undefined => {
  if (source.checksum !== undefined && source.checksum !== '') return `checksum:${source.checksum}`
  if (source.size !== undefined && source.modifiedAt !== undefined) {
    return `stat:${source.size}:${source.modifiedAt}`
  }
  return undefined
}

/**
 * Runs ONE bounded tick: read what changed, leave the index consistent, and report per item what happened.
 * Items already indexed under the same fingerprint are skipped without a read; items that cannot be
 * fingerprinted or read are named in the disposition and produce no entry.
 */
export const runSearchIndexTick = async (
  deps: SearchIndexTickDeps,
  sources: SearchIndexSource[],
  state: SearchIndexState
): Promise<SearchIndexTickResult> => {
  const indexed = new Map(state.entries.map((entry) => [entry.id, entry]))
  const candidates: SearchIndexCandidate[] = []
  const disposition: SearchIndexDisposition[] = []
  let reads = 0
  let truncated = false

  for (const source of sources) {
    const fingerprint = fingerprintOf(source)
    if (fingerprint === undefined) {
      disposition.push({ id: source.id, kind: 'unfingerprintable' })
      continue
    }

    const existing = indexed.get(source.id)
    if (
      existing !== undefined &&
      existing.fingerprint === fingerprint &&
      existing.scope === source.scope
    ) {
      disposition.push({ id: source.id, kind: 'unchanged' })
      continue
    }

    if (reads >= deps.budget) {
      // Budget exhausted: the remaining work is left for the next tick and SAID SO, rather than being
      // reported as finished. Nothing is written for these items, so they stay pending — which is true.
      truncated = true
      continue
    }

    reads += 1
    const text = await deps.readText(source.id)
    if (text === undefined) {
      disposition.push({ id: source.id, kind: 'unreadable' })
      continue
    }

    candidates.push({
      id: source.id,
      scope: source.scope,
      fingerprint,
      text: text.slice(0, SEARCH_INDEX_MAX_ENTRY_CHARS),
      projectId: source.projectId,
      title: source.title,
      relativePath: source.relativePath,
      ...(source.timestamp === undefined ? {} : { timestamp: source.timestamp })
    })
    disposition.push({ id: source.id, kind: 'indexed' })
  }

  // Visibility is what keeps every listed item reachable: the drop set comes from the ids this listing
  // showed (`sources`), NOT from `candidates` — candidates only hold what was re-read THIS tick, so deriving
  // drops from them would delete every unchanged entry. An item that vanished from the listing does get its
  // entry removed, so queries stop matching text that is no longer there (a deleted file that keeps matching
  // is a worse lie than a gap).
  const plan = planSearchIndexTick(
    state,
    candidates,
    sources.map((source) => source.id)
  )
  const write = await applySearchIndexPlan(
    deps.root,
    state,
    plan,
    {
      // The checkpoint is a build-wide progress marker, so `scope` names the scopes this tick covered
      // (sorted, joined) rather than pretending one of them owns the whole index.
      scope: [...new Set(sources.map((source) => source.scope))].sort().join(',') || 'none',
      // Cumulative items READ, added to the previous value: it can only grow, and the store keeps the higher
      // of the two regardless (the monotonic guard lives there).
      processed: (state.checkpoint?.processed ?? 0) + reads,
      // A build's start is the FIRST tick's — it stays put while `updatedAt` moves with every tick.
      startedAt: state.checkpoint?.startedAt ?? deps.now(),
      updatedAt: deps.now()
    },
    deps.maxBytes === undefined ? {} : { maxBytes: deps.maxBytes }
  )

  // A cap that refused part of the batch must not read as "indexed": the store names what it skipped, and
  // each of those ids gets its own disposition here.
  const skipped = new Set(write.blocked?.skipped ?? [])
  const reconciled =
    skipped.size === 0
      ? disposition
      : disposition.map((entry) =>
          skipped.has(entry.id) ? { id: entry.id, kind: 'capped' as const } : entry
        )

  // Read the state back from disk rather than assuming this tick's writes landed as computed: the durable
  // index is the authority for what the next tick and every query will see.
  const next = await readSearchIndex(deps.root)

  return { state: next, disposition: reconciled, truncated }
}

/** Convenience for a caller that only needs the counters (the readouts the panel shows). */
export const summarizeDispositions = (
  disposition: SearchIndexDisposition[]
): {
  indexed: number
  unchanged: number
  unfingerprintable: number
  unreadable: number
  capped: number
} => ({
  indexed: disposition.filter((entry) => entry.kind === 'indexed').length,
  unchanged: disposition.filter((entry) => entry.kind === 'unchanged').length,
  unfingerprintable: disposition.filter((entry) => entry.kind === 'unfingerprintable').length,
  unreadable: disposition.filter((entry) => entry.kind === 'unreadable').length,
  capped: disposition.filter((entry) => entry.kind === 'capped').length
})

/** The entries the index holds for a scope — the shape the query path reads back. */
export const entriesForScope = (entries: SearchIndexEntry[], scope: string): SearchIndexEntry[] =>
  entries.filter((entry) => entry.scope === scope)
