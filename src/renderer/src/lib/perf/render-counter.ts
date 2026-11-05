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

const bucket = (): RenderCounts | undefined =>
  (window as unknown as Record<string, RenderCounts | undefined>)[BUCKET_KEY]

export const countRender = (slotId: string): void => {
  const counts = bucket()
  if (!counts) return
  counts[slotId] = (counts[slotId] ?? 0) + 1
}

export const installRenderCounts = (): void => {
  ;(window as unknown as Record<string, RenderCounts>)[BUCKET_KEY] = {}
}

export const readRenderCounts = (): RenderCounts =>
  (window as unknown as Record<string, RenderCounts | undefined>)[BUCKET_KEY] ?? {}

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
  const buckets = (
    window as unknown as Record<string, Record<string, Record<number, number>> | undefined>
  )[CHURN_KEY]
  if (!buckets || !previous) return
  const bucket = (buckets[slotId] ??= {})
  previous.forEach((value, index) => {
    if (!Object.is(value, next[index])) bucket[index] = (bucket[index] ?? 0) + 1
  })
}

export const installPropChurn = (): void => {
  ;(window as unknown as Record<string, Record<string, Record<number, number>>>)[CHURN_KEY] = {}
}

export const readPropChurn = (): Record<string, Record<number, number>> =>
  (window as unknown as Record<string, Record<string, Record<number, number>> | undefined>)[
    CHURN_KEY
  ] ?? {}
