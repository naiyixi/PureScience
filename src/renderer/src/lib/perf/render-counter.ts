// Render counting for the transcript performance work, not for production behaviour.
//
// Why this exists in shipped code: the only reliable way to answer "does a settled row re-render on
// every streamed chunk?" is to count renders at the component, and the counter has to be installed by
// whatever is driving the app (a perf spec) rather than compiled in. It is a single property lookup
// and a null check per row render when nobody installed the bucket, and it stays a no-op in production
// because nothing ever defines the global.
//
// Read it with: e2e/perf/render-count.spec.ts (non-gating tool, prints a table).
export type RenderCounts = Record<string, number>

const BUCKET_KEY = '__PURESCIENCE_RENDER_COUNTS__'

// Server-side rendering and jsdom-free unit tests have no `window`, and a perf counter must never be the
// reason a render throws.
const scope = (): Record<string, unknown> | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as Record<string, unknown>)

const bucket = (): RenderCounts | undefined => scope()?.[BUCKET_KEY] as RenderCounts | undefined

export const countRender = (slotId: string): void => {
  const counts = bucket()
  if (!counts) return
  counts[slotId] = (counts[slotId] ?? 0) + 1
}

export const installRenderCounts = (): void => {
  const host = scope()
  if (host) host[BUCKET_KEY] = {}
}

export const readRenderCounts = (): RenderCounts =>
  (scope()?.[BUCKET_KEY] as RenderCounts | undefined) ?? {}

// Which slot-props dependency changed. The transcript caches a props bundle per row and reuses it while
// its dependency tuple is unchanged; when the row re-renders on every chunk the first question is
// *which* dependency moved. Indexes match the tuple literal in WorkspaceMessageScroller, so a reading
// names the prop instead of the symptom.
const CHURN_KEY = '__PURESCIENCE_PROP_CHURN__'

export const recordPropChurn = (
  slotId: string,
  previous: readonly unknown[] | undefined,
  next: readonly unknown[]
): void => {
  const host = scope()
  if (!host || !previous) return
  const buckets = host[CHURN_KEY] as Record<string, Record<number, number>> | undefined
  if (!buckets) return
  const bucket = (buckets[slotId] ??= {})
  previous.forEach((value, index) => {
    if (!Object.is(value, next[index])) bucket[index] = (bucket[index] ?? 0) + 1
  })
}

export const installPropChurn = (): void => {
  const host = scope()
  if (host) host[CHURN_KEY] = {}
}

export const readPropChurn = (): Record<string, Record<number, number>> =>
  (scope()?.[CHURN_KEY] as Record<string, Record<number, number>> | undefined) ?? {}

// Markdown renders, counted separately from row renders: a row can re-render without re-parsing its
// markdown (the component is memoised on content), and a remount can re-parse without the row "rendering"
// in the transcript's sense. Parsing is the expensive half of a remount, so the window experiment needs
// its own counter to answer "how much parsing does the render window cost?" without depending on
// wall-clock readings, which this host cannot reproduce across batches.
const MARKDOWN_KEY = '__PURESCIENCE_MARKDOWN_RENDERS__'

export const countMarkdownRender = (contentLength: number): void => {
  const host = scope()
  if (!host) return
  const bucket = (host[MARKDOWN_KEY] as { count: number; chars: number } | undefined) ?? undefined
  if (!bucket) return
  bucket.count += 1
  bucket.chars += contentLength
}

export const installMarkdownCounts = (): void => {
  const host = scope()
  if (host) host[MARKDOWN_KEY] = { count: 0, chars: 0 }
}

export const readMarkdownCounts = (): { count: number; chars: number } =>
  (scope()?.[MARKDOWN_KEY] as { count: number; chars: number } | undefined) ?? {
    count: 0,
    chars: 0
  }

// Streamed chunks, counted where they enter the store. Row renders per turn only mean something divided
// by this: a row that renders 300 times while receiving 300 chunks is doing exactly one render per
// chunk, while the same 300 renders against 30 chunks is ten renders per chunk — different bugs.
const CHUNK_KEY = '__PURESCIENCE_STREAM_CHUNKS__'

export const countStreamChunk = (chars: number, committed: boolean): void => {
  const host = scope()
  if (!host) return
  const bucket = host[CHUNK_KEY] as { total: number; committed: number; chars: number } | undefined
  if (!bucket) return
  bucket.total += 1
  if (committed) bucket.committed += 1
  bucket.chars += chars
}

export const installStreamChunkCounts = (): void => {
  const host = scope()
  if (host) host[CHUNK_KEY] = { total: 0, committed: 0, chars: 0 }
}

export const readStreamChunkCounts = (): { total: number; committed: number; chars: number } =>
  (scope()?.[CHUNK_KEY] as { total: number; committed: number; chars: number } | undefined) ?? {
    total: 0,
    committed: 0,
    chars: 0
  }

// Why a row re-rendered, bucketed by which of its own inputs moved. A render count alone cannot say
// whether 300 renders per chunk are 300 text updates (the stream itself) or 3 text updates and 297
// re-renders for some other reason — and those two need opposite fixes.
const REASON_KEY = '__PURESCIENCE_RENDER_REASONS__'
const lastInputsByRow = new Map<string, { content: string; status: string }>()

export type RenderReason = 'first' | 'content' | 'status' | 'other'

export const recordRenderReason = (
  rowId: string,
  content: string,
  status: string
): RenderReason => {
  const previous = lastInputsByRow.get(rowId)
  lastInputsByRow.set(rowId, { content, status })
  if (!previous) return 'first'
  if (previous.content !== content) return 'content'
  if (previous.status !== status) return 'status'
  return 'other'
}

export const installRenderReasons = (): void => {
  const host = scope()
  lastInputsByRow.clear()
  if (host) host[REASON_KEY] = { first: 0, content: 0, status: 0, other: 0 }
}

export const countRenderReason = (reason: RenderReason): void => {
  const host = scope()
  if (!host) return
  const bucket = host[REASON_KEY] as Record<RenderReason, number> | undefined
  if (!bucket) return
  bucket[reason] += 1
}

export const readRenderReasons = (): Record<RenderReason, number> =>
  (scope()?.[REASON_KEY] as Record<RenderReason, number> | undefined) ?? {
    first: 0,
    content: 0,
    status: 0,
    other: 0
  }

// Store-commit attribution. Each write to the session store bumps a counter; a row render records which
// commit was current when it ran. Two shapes are then distinguishable and need different fixes:
//   · one commit → many rows rendered  = a write that invalidates the whole transcript
//   · many renders against one commit  = renders with no store write behind them at all (local state,
//     effects, or a cascade), which is what a 0.4 ms cadence in a single turn looks like
const COMMIT_KEY = '__PURESCIENCE_COMMITS__'
const AT_COMMIT_KEY = '__PURESCIENCE_RENDER_AT_COMMIT__'
const lastCommitByRow = new Map<string, number>()

export const bumpStoreCommit = (): void => {
  const host = scope()
  if (!host) return
  const bucket = host[COMMIT_KEY] as
    | {
        count: number
        rowsByCommit: Map<number, number>
        samples: Array<{ commit: number; ids: string[] }>
      }
    | undefined
  if (!bucket) return
  bucket.count += 1
  bucket.rowsByCommit.set(bucket.count, 0)
  // Rolling window over the most recent commits: a contiguous run of ids means a window boundary is
  // crossed, scattered ids mean the rows' own memo keys are unstable.
  bucket.samples.push({ commit: bucket.count, ids: [] })
  if (bucket.samples.length > 60) bucket.samples.shift()
}

export const installCommitCounts = (): void => {
  const host = scope()
  lastCommitByRow.clear()
  if (!host) return
  host[COMMIT_KEY] = { count: 0, rowsByCommit: new Map<number, number>(), samples: [] }
  host[AT_COMMIT_KEY] = { sameCommit: 0, afterCommit: 0 }
}

export const recordRenderAtCommit = (rowId: string): 'same-commit' | 'after-commit' => {
  const host = scope()
  const bucket = host?.[COMMIT_KEY] as
    | {
        count: number
        rowsByCommit: Map<number, number>
        samples: Array<{ commit: number; ids: string[] }>
      }
    | undefined
  if (!bucket) return 'after-commit'
  const current = bucket.count
  const previous = lastCommitByRow.get(rowId)
  lastCommitByRow.set(rowId, current)
  const tally = host?.[AT_COMMIT_KEY] as { sameCommit: number; afterCommit: number } | undefined
  if (previous === current) {
    if (tally) tally.sameCommit += 1
    return 'same-commit'
  }
  bucket.rowsByCommit.set(current, (bucket.rowsByCommit.get(current) ?? 0) + 1)
  const sample = bucket.samples[bucket.samples.length - 1]
  if (sample && sample.commit === current) sample.ids.push(rowId)
  if (tally) tally.afterCommit += 1
  return 'after-commit'
}

export const readCommitCounts = (): {
  commits: number
  maxRowsPerCommit: number
  rowsPerCommitHistogram: Record<number, number>
} => {
  const bucket = scope()?.[COMMIT_KEY] as
    { count: number; rowsByCommit: Map<number, number> } | undefined
  if (!bucket || bucket.count === 0)
    return { commits: 0, maxRowsPerCommit: 0, rowsPerCommitHistogram: {} }
  const values = [...bucket.rowsByCommit.values()]
  const histogram: Record<number, number> = {}
  for (const value of values) histogram[value] = (histogram[value] ?? 0) + 1
  return {
    commits: bucket.count,
    maxRowsPerCommit: Math.max(...values),
    rowsPerCommitHistogram: histogram
  }
}

export const readCommitSamples = (): Array<{ commit: number; ids: string[] }> => {
  const bucket = scope()?.[COMMIT_KEY] as
    { samples: Array<{ commit: number; ids: string[] }> } | undefined
  return bucket?.samples ?? []
}
