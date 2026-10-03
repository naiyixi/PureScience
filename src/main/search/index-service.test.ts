import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  createSearchIndexService,
  toSearchIndexSummary,
  type SearchIndexFile
} from './index-service'

const makeRoot = (): string => mkdtempSync(join(tmpdir(), 'ps-index-service-'))
const NOW = '2026-10-03T00:00:00.000Z'

const file = (overrides: Partial<SearchIndexFile> = {}): SearchIndexFile => ({
  id: 'file-1',
  title: 'panel.csv',
  relativePath: 'uploads/panel.csv',
  source: 'upload',
  checksum: 'checksum-1',
  ...overrides
})

const service = (
  root: string,
  overrides: {
    files?: SearchIndexFile[]
    activeProjectId?: string | undefined
    texts?: Record<string, string | undefined>
    listBounded?: boolean
    intervalMs?: number
    budget?: number
  } = {}
): ReturnType<typeof createSearchIndexService> =>
  createSearchIndexService({
    root,
    listFiles: async () => ({
      files: overrides.files ?? [file()],
      ...(overrides.listBounded === undefined ? {} : { listBounded: overrides.listBounded })
    }),
    readFileText: async (id) => (overrides.texts ?? { 'file-1': 'zebrafish ortholog panel' })[id],
    activeProjectId: () =>
      'activeProjectId' in overrides ? overrides.activeProjectId : 'project-1',
    now: () => NOW,
    intervalMs: overrides.intervalMs ?? 5_000,
    budget: overrides.budget ?? 50
  })

describe('search index service (S3-S1b)', () => {
  it('answers the query port with EMPTY before any tick, rather than with a zero count', async () => {
    const root = makeRoot()
    const index = service(root)

    // Before a tick there is no measurement. `present: false` is what makes coverage read "empty" instead
    // of "the index is there and holds nothing", which are different sentences.
    const before = await index.readIndex()
    expect(before.present).toBe(false)
    expect(before.records).toEqual([])
    expect(before.pendingByScope).toEqual({})
    expect(before.measuredAt).toBeUndefined()
    rmSync(root, { recursive: true, force: true })
  })

  it('indexes the active project on a tick and then serves those records to the query path', async () => {
    const root = makeRoot()
    const index = service(root)

    const after = await index.tick()

    expect(after.present).toBe(true)
    expect(after.indexedByScope).toEqual({ uploads: 1 })
    expect(after.pendingByScope).toEqual({})
    expect(after.records.map((record) => record.id)).toEqual(['file-1'])
    expect(after.records[0]?.text).toBe('zebrafish ortholog panel')
    expect(after.measuredAt).toBe(NOW)

    // The port answers from the last tick, without listing files again.
    expect((await index.readIndex()).records.map((record) => record.id)).toEqual(['file-1'])
    rmSync(root, { recursive: true, force: true })
  })

  it('files a generated artifact under its own scope rather than under uploads', async () => {
    const root = makeRoot()
    const index = service(root, {
      files: [file({ source: 'artifact', id: 'artifact-1' })],
      texts: { 'artifact-1': 'generated table' }
    })

    const after = await index.tick()

    expect(after.indexedByScope).toEqual({ artifacts: 1 })
    expect(after.records[0]?.scope).toBe('artifacts')
    rmSync(root, { recursive: true, force: true })
  })

  it('reports pending for what it could not index, instead of presenting a smaller index as complete', async () => {
    const root = makeRoot()
    const index = service(root, {
      files: [
        file({ id: 'ok', checksum: 'c1' }),
        // No checksum and no stat data: not indexable, and that has to be visible.
        file({ id: 'opaque', checksum: undefined }),
        // Fingerprintable but unreadable.
        file({ id: 'broken', checksum: 'c3' })
      ],
      texts: { ok: 'readable', broken: undefined }
    })

    const after = await index.tick()

    expect(after.present).toBe(true)
    expect(after.indexedByScope).toEqual({ uploads: 1 })
    expect(after.pendingByScope).toEqual({ uploads: 2 })
    expect(after.unfingerprintable).toBe(1)
    expect(after.unreadable).toBe(1)
    // Not even the opaque one's text was read: fingerprintability is judged first.
    expect(after.records.map((record) => record.id)).toEqual(['ok'])
    rmSync(root, { recursive: true, force: true })
  })

  it('says nothing was indexed when there is no active project, without inventing a measurement', async () => {
    const root = makeRoot()
    const index = service(root, { activeProjectId: undefined })

    const after = await index.tick()

    expect(after.present).toBe(false)
    expect(after.records).toEqual([])
    expect(after.measuredAt).toBe(NOW)
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps the previous measurement when the listing itself fails', async () => {
    const root = makeRoot()
    let failing = false
    const index = createSearchIndexService({
      root,
      listFiles: async () => {
        if (failing) throw new Error('listing unavailable')
        return { files: [file()] }
      },
      readFileText: async () => 'zebrafish ortholog panel',
      activeProjectId: () => 'project-1',
      now: () => NOW
    })

    const first = await index.tick()
    expect(first.records).toHaveLength(1)

    failing = true
    const second = await index.tick()

    // A failed listing must not read as "the project now holds nothing" — the old measurement stands.
    expect(second.records.map((record) => record.id)).toEqual(['file-1'])
    rmSync(root, { recursive: true, force: true })
  })

  it('ticks on its own interval once started, and stops when told to', async () => {
    const root = makeRoot()
    const index = createSearchIndexService({
      root,
      listFiles: async () => ({ files: [file()] }),
      readFileText: async () => 'zebrafish ortholog panel',
      activeProjectId: () => 'project-1',
      now: () => NOW,
      intervalMs: 10
    })

    // This case is about the TIMER wiring (fires the tick, and stop() really stops it). It substitutes the
    // tick rather than letting real writes run: a real interval plus real file I/O races the teardown, and a
    // flaky test is its own defect. The real tick's behaviour is covered by the cases above.
    vi.useFakeTimers()
    try {
      const tick = vi.spyOn(index, 'tick').mockResolvedValue(index.snapshot())
      index.start()
      await vi.advanceTimersByTimeAsync(35)
      expect(tick.mock.calls.length).toBeGreaterThanOrEqual(3)

      index.stop()
      const afterStop = tick.mock.calls.length
      await vi.advanceTimersByTimeAsync(100)
      expect(tick.mock.calls.length).toBe(afterStop)
      tick.mockRestore()
    } finally {
      vi.useRealTimers()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// The reading a panel is shown must be assembled from what a tick MEASURED. These cases pin the two ways
// that could turn into a lie: summing the wrong map, and inventing a measurement time.
describe('toSearchIndexSummary', () => {
  it('sums the entries across scopes and keeps the counts that are behind', () => {
    const summary = toSearchIndexSummary({
      present: true,
      records: [],
      indexedByScope: { uploads: 2, artifacts: 3 },
      pendingByScope: { uploads: 1 },
      capped: false,
      truncated: false,
      unfingerprintable: 0,
      unreadable: 0,
      listBounded: false,
      measuredAt: NOW
    })

    expect(summary).toEqual({
      present: true,
      indexed: 5,
      pending: 1,
      capped: false,
      measuredAt: NOW
    })
  })

  it('keeps an absent measurement time absent rather than inventing one', () => {
    const summary = toSearchIndexSummary({
      present: false,
      records: [],
      indexedByScope: {},
      pendingByScope: {},
      capped: false,
      truncated: false,
      unfingerprintable: 0,
      unreadable: 0,
      listBounded: false
    })

    // No tick has run: `present: false` and no timestamp. Substituting `now` would make an unbuilt index
    // look like one measured this second.
    expect(summary.present).toBe(false)
    expect(summary.indexed).toBe(0)
    expect('measuredAt' in summary).toBe(false)
  })
})
