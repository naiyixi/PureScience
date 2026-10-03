import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  applySearchIndexBatch,
  applySearchIndexPlan,
  planSearchIndex,
  readSearchIndex,
  readSearchIndexRecords,
  removeSearchIndex,
  searchIndexSizeBytes,
  SEARCH_INDEX_SCHEMA_VERSION,
  type SearchIndexCandidate,
  type SearchIndexCheckpoint,
  type SearchIndexState
} from './index-store'

// S3 S1: the durable side of the incremental index. Every case here is one of the properties the parent
// plan makes the acceptance hinge on, and each is written so it would fail if the property were only
// documented rather than implemented:
//   * an absent/removed directory reads as EMPTY COVERAGE, never as "nothing exists";
//   * a resumed build never moves the processed counter backwards;
//   * the storage cap refuses BY NAME instead of dropping entries quietly;
//   * unchanged fingerprints are not re-indexed.

const makeRoot = (): string => mkdtempSync(join(tmpdir(), 'os-index-'))

const candidate = (id: string, fingerprint: string, text: string): SearchIndexCandidate => ({
  id,
  scope: 'uploads',
  fingerprint,
  text
})

const checkpoint = (processed: number, updatedAt = 't1'): SearchIndexCheckpoint => ({
  scope: 'uploads',
  processed,
  startedAt: 't0',
  updatedAt
})

const readState = (root: string): Promise<SearchIndexState> => readSearchIndex(root)

describe('search index store', () => {
  it('reads a missing directory as EMPTY coverage, not as an empty corpus', async () => {
    const root = makeRoot()
    const state = await readSearchIndex(root)

    expect(state).toEqual({ present: false, entries: [], totalBytes: 0 })
    // The distinction the caller needs: there ARE records to find, we simply hold no index.
    expect(await readSearchIndexRecords(root)).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('treats a manifest from another schema version as unreadable rather than parsing it on a hope', async () => {
    const root = makeRoot()
    await applySearchIndexBatch(
      root,
      await readSearchIndex(root),
      [candidate('a', 'f1', 'alpha')],
      checkpoint(1)
    )
    const manifest = join(root, 'search-index', 'manifest.json')
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>
    writeFileSync(
      manifest,
      JSON.stringify({ ...parsed, schemaVersion: SEARCH_INDEX_SCHEMA_VERSION + 1 })
    )

    expect(await readSearchIndex(root)).toEqual({ present: false, entries: [], totalBytes: 0 })
    rmSync(root, { recursive: true, force: true })
  })

  it('plans nothing when the fingerprints are unchanged, and only the moved one when they are not', async () => {
    const root = makeRoot()
    const first = await applySearchIndexBatch(
      root,
      await readSearchIndex(root),
      [candidate('a', 'f1', 'alpha'), candidate('b', 'f2', 'beta')],
      checkpoint(2)
    )
    const state = { present: true, entries: first.entries, totalBytes: 2 * 5 }

    expect(planSearchIndex(state, [candidate('a', 'f1', ''), candidate('b', 'f2', '')])).toEqual({
      toIndex: [],
      toDrop: [],
      unchanged: true
    })

    const moved = planSearchIndex(state, [
      candidate('a', 'f1-CHANGED', ''),
      candidate('b', 'f2', '')
    ])
    expect(moved.toIndex.map((entry) => entry.id)).toEqual(['a'])
    expect(moved.unchanged).toBe(false)

    const dropped = planSearchIndex(state, [candidate('b', 'f2', '')])
    expect(dropped.toDrop).toEqual(['a'])
    rmSync(root, { recursive: true, force: true })
  })

  it('stores text so a later query can match without re-reading the corpus, and keeps it for unchanged entries', async () => {
    const root = makeRoot()
    const first = await applySearchIndexBatch(
      root,
      await readSearchIndex(root),
      [candidate('a', 'f1', 'zebrafish_ortholog_panel'), candidate('b', 'f2', 'beta')],
      checkpoint(2)
    )
    expect(first.written).toEqual(['a', 'b'])

    // Only `b` moved: `a` must keep its stored text even though this batch never mentions it.
    const second = await applySearchIndexBatch(
      root,
      {
        present: true,
        entries: first.entries,
        totalBytes: first.entries.reduce((s, e) => s + e.bytes, 0)
      },
      [candidate('b', 'f3', 'beta v2')],
      checkpoint(3)
    )
    expect(second.written).toEqual(['b'])

    const records = await readSearchIndexRecords(root)
    expect(records.find((record) => record.id === 'a')?.text).toBe('zebrafish_ortholog_panel')
    expect(records.find((record) => record.id === 'b')?.text).toBe('beta v2')
    expect(records).toHaveLength(2)

    const state = await readState(root)
    expect(state.present).toBe(true)
    expect(state.checkpoint?.processed).toBe(3)
    expect(await searchIndexSizeBytes(root)).toBeGreaterThan(0)
    rmSync(root, { recursive: true, force: true })
  })

  it('never lets the processed counter go backwards across a resume', async () => {
    const root = makeRoot()
    const first = await applySearchIndexBatch(
      root,
      await readSearchIndex(root),
      [candidate('a', 'f1', 'alpha')],
      checkpoint(5, 't1')
    )
    expect((await readSearchIndex(root)).checkpoint?.processed).toBe(5)

    // A restarted build hands over a smaller counter — the stored one must win.
    await applySearchIndexBatch(
      root,
      { present: true, entries: first.entries, totalBytes: first.entries[0].bytes },
      [candidate('b', 'f2', 'beta')],
      checkpoint(2, 't2')
    )
    const resumed = await readSearchIndex(root)
    expect(resumed.checkpoint?.processed).toBe(5)
    // …and the batch itself still applied: the counter is monotone, not a lock.
    expect(resumed.entries.map((entry) => entry.id).sort()).toEqual(['a', 'b'])
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses a batch that would exceed the storage cap BY NAME, leaving the store untouched', async () => {
    const root = makeRoot()
    const first = await applySearchIndexBatch(
      root,
      await readSearchIndex(root),
      [candidate('a', 'f1', 'x'.repeat(100))],
      checkpoint(1)
    )
    const before = await readSearchIndex(root)

    const refused = await applySearchIndexBatch(
      root,
      before,
      [candidate('b', 'f2', 'y'.repeat(100))],
      checkpoint(2),
      { maxBytes: 150 }
    )

    expect(refused.blocked).toEqual({ reason: 'storage-cap', skipped: ['b'] })
    expect(refused.written).toEqual([])
    expect(refused.entries).toEqual(first.entries)
    // The manifest is unchanged, so nothing was silently dropped and nothing was half-written.
    expect(await readSearchIndex(root)).toEqual(before)
    rmSync(root, { recursive: true, force: true })
  })

  it('reports EMPTY coverage again after the index directory is removed', async () => {
    const root = makeRoot()
    await applySearchIndexBatch(
      root,
      await readSearchIndex(root),
      [candidate('a', 'f1', 'alpha')],
      checkpoint(1)
    )
    expect((await readSearchIndex(root)).present).toBe(true)

    await removeSearchIndex(root)

    expect(await readSearchIndex(root)).toEqual({ present: false, entries: [], totalBytes: 0 })
    expect(await searchIndexSizeBytes(root)).toBe(0)
    rmSync(root, { recursive: true, force: true })
  })

  it('drops the segment of a scope that lost its last entry', async () => {
    const root = makeRoot()
    const seeded = await applySearchIndexBatch(
      root,
      await readSearchIndex(root),
      [candidate('a', 'f1', 'alpha')],
      checkpoint(1)
    )
    mkdirSync(join(root, 'search-index', 'segments'), { recursive: true })

    // A deleted file must stop matching: applying the DROP half of the plan removes its entry and tears
    // down the now-empty scope segment, instead of leaving text a query would keep hitting.
    const prior = { present: true, entries: seeded.entries, totalBytes: seeded.entries[0].bytes }
    const plan = planSearchIndex(prior, [
      { id: 'r1', scope: 'references', fingerprint: 'f9', text: 'rho' }
    ])
    expect(plan.toDrop).toEqual(['a'])

    await applySearchIndexPlan(root, prior, plan, checkpoint(2))

    const records = await readSearchIndexRecords(root)
    expect(records.map((record) => record.scope)).toEqual(['references'])
    expect((await readSearchIndex(root)).entries.map((entry) => entry.id)).toEqual(['r1'])
    rmSync(root, { recursive: true, force: true })
  })
})
