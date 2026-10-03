import { readSearchIndex, readSearchIndexRecords, type SearchIndexRecord } from './index-store'
import type { GlobalSearchIndexSummary } from '../../shared/global-search'
import {
  fingerprintOf,
  runSearchIndexTick,
  summarizeDispositions,
  type SearchIndexSource
} from './index-builder'

// The OWNER of the index (S3-S1b, second half). index-store.ts holds the durable shape, index-builder.ts does
// one bounded tick of work; this module decides WHEN ticks happen and answers the query path's `readIndex`
// port. Two rules shape it:
//   - the build never runs on the startup critical path (the benchmark product makes you restart for this;
//     here the first tick happens after the app is already usable, and a search that runs before any tick
//     is answered by the live scan alone with coverage reporting `indexed: 0`), and
//   - what it reports is the LAST MEASURED tick, never an optimistic guess: `pendingByScope` is recomputed
//     from a real listing during the tick, and a scope nobody has listed yet simply has no number.

/** One file as the file listing knows it. `checksum`/`size`/`modifiedAt` are what a fingerprint can be
 *  built from; a listing that carries none of them yields `unfingerprintable` items, which is reported. */
export type SearchIndexFile = {
  id: string
  title: string
  relativePath: string
  source: 'artifact' | 'upload'
  timestamp?: string
  checksum?: string
  size?: number
  modifiedAt?: string
}

export type SearchIndexServicePorts = {
  /** Where the index lives (the caller derives it from the data root). */
  root: string
  listFiles(projectId: string): Promise<{ files: SearchIndexFile[]; listBounded?: boolean }>
  /** `undefined` means unreadable — never "empty". */
  readFileText(fileId: string): Promise<string | undefined>
  /** The project whose files are indexed. No project ⇒ nothing to index, stated as such. */
  activeProjectId(): string | undefined
  intervalMs?: number
  budget?: number
  now?(): string
}

export type SearchIndexSnapshot = {
  /** False when no index has been built (or the directory is gone) — coverage must read EMPTY, not zero. */
  present: boolean
  records: SearchIndexRecord[]
  indexedByScope: Record<string, number>
  /** Items that a tick could not index (changed since, unfingerprintable, unreadable, or cut off by the
   *  tick budget). Recomputed during the tick from a real listing — never carried forward as a guess. */
  pendingByScope: Record<string, number>
  capped: boolean
  truncated: boolean
  unfingerprintable: number
  unreadable: number
  /** When the last tick finished, so a reader can judge staleness itself. */
  measuredAt?: string
  /** True when the file listing itself was bounded, so a reader knows the count is a floor. */
  listBounded: boolean
}

const EMPTY_SNAPSHOT: SearchIndexSnapshot = {
  present: false,
  records: [],
  indexedByScope: {},
  pendingByScope: {},
  capped: false,
  truncated: false,
  unfingerprintable: 0,
  unreadable: 0,
  listBounded: false
}

/** The service's own surface — named so the factory can carry an explicit return type. */
export type SearchIndexService = {
  /** The query path's port: the LAST MEASURED tick, never a fresh listing. */
  readIndex(): Promise<SearchIndexSnapshot>
  tick(): Promise<SearchIndexSnapshot>
  start(): void
  stop(): void
  snapshot(): SearchIndexSnapshot
}

/**
 * The shared reading a panel shows, derived from one measured snapshot. Pure and total: every number
 * comes from the snapshot the tick actually recorded, so nothing here can turn "not measured" into 0 —
 * `present: false` and an absent `measuredAt` travel through as the honest answers they are.
 */
export const toSearchIndexSummary = (snapshot: SearchIndexSnapshot): GlobalSearchIndexSummary => ({
  present: snapshot.present,
  indexed: Object.values(snapshot.indexedByScope).reduce((total, count) => total + count, 0),
  pending: Object.values(snapshot.pendingByScope).reduce((total, count) => total + count, 0),
  capped: snapshot.capped,
  ...(snapshot.measuredAt === undefined ? {} : { measuredAt: snapshot.measuredAt })
})

export const createSearchIndexService = (ports: SearchIndexServicePorts): SearchIndexService => {
  const intervalMs = ports.intervalMs ?? 5_000
  const budget = ports.budget ?? 50
  const now = ports.now ?? ((): string => new Date().toISOString())

  let snapshot: SearchIndexSnapshot = EMPTY_SNAPSHOT
  let timer: ReturnType<typeof setInterval> | undefined

  const toSources = (projectId: string, files: SearchIndexFile[]): SearchIndexSource[] =>
    files.map((file): SearchIndexSource => ({
      id: file.id,
      scope: file.source === 'upload' ? 'uploads' : 'artifacts',
      projectId,
      title: file.title,
      relativePath: file.relativePath,
      ...(file.timestamp === undefined ? {} : { timestamp: file.timestamp }),
      ...(file.checksum === undefined ? {} : { checksum: file.checksum }),
      ...(file.size === undefined ? {} : { size: file.size }),
      ...(file.modifiedAt === undefined ? {} : { modifiedAt: file.modifiedAt })
    }))

  /** Runs exactly one tick and records what it measured. Safe to call at any time; never throws outward —
   *  an index failure must not break the app, but it must not be silent either (it lands in the snapshot). */
  const tick = async (): Promise<SearchIndexSnapshot> => {
    const projectId = ports.activeProjectId()
    if (projectId === undefined) {
      snapshot = { ...EMPTY_SNAPSHOT, measuredAt: now() }
      return snapshot
    }

    let files: SearchIndexFile[] = []
    let listBounded = false
    try {
      const listing = await ports.listFiles(projectId)
      files = listing.files
      listBounded = listing.listBounded ?? false
    } catch {
      // A listing that cannot be read leaves the previous measurement standing rather than reporting a
      // smaller index as the truth; the next tick tries again.
      return snapshot
    }

    const sources = toSources(projectId, files)
    const state = await readSearchIndex(ports.root)
    const result = await runSearchIndexTick(
      { root: ports.root, readText: (id) => ports.readFileText(id), budget, now },
      sources,
      state
    )

    const entries = new Map(result.state.entries.map((entry) => [entry.id, entry]))
    // `indexedByScope` counts what the INDEX holds (not what the listing showed), so a scope the index
    // covers 0 items of reads 0 rather than "not measured".
    const indexedByScope: Record<string, number> = {}
    for (const entry of result.state.entries) {
      indexedByScope[entry.scope] = (indexedByScope[entry.scope] ?? 0) + 1
    }
    const pendingByScope: Record<string, number> = {}
    for (const source of sources) {
      const fingerprint = fingerprintOf(source)
      const entry = entries.get(source.id)
      const upToDate =
        fingerprint !== undefined && entry !== undefined && entry.fingerprint === fingerprint
      if (!upToDate) pendingByScope[source.scope] = (pendingByScope[source.scope] ?? 0) + 1
    }
    const counts = summarizeDispositions(result.disposition)

    snapshot = {
      // The store's own answer: false means the index is absent/unreadable for this schema version, which
      // coverage must report as EMPTY rather than as a zero count.
      present: result.state.present,
      records: await readSearchIndexRecords(ports.root),
      indexedByScope,
      pendingByScope,
      capped: counts.capped > 0,
      truncated: result.truncated,
      unfingerprintable: counts.unfingerprintable,
      unreadable: counts.unreadable,
      measuredAt: now(),
      listBounded
    }
    return snapshot
  }

  const api: SearchIndexService = {
    /** The query path's port. Cheap: it answers from the last measured tick, never by listing files. */
    readIndex: async (): Promise<SearchIndexSnapshot> => snapshot,
    tick,
    /** Starts ticking. Deliberately NOT called from the startup path's synchronous section. Dispatches
     *  through the returned object, so a test can substitute `tick` and verify the TIMER wiring without
     *  doing file I/O (a real timer plus real writes races the teardown and flakes). */
    start: (): void => {
      if (timer !== undefined) return
      timer = setInterval(() => {
        void api.tick()
      }, intervalMs)
      // A pending timer must not hold the process open on quit.
      timer.unref?.()
    },
    stop: (): void => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
    snapshot: (): SearchIndexSnapshot => snapshot
  }
  return api
}
