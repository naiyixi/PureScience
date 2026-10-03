import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { readSearchIndex } from './index-store'
import {
  fingerprintOf,
  runSearchIndexTick,
  summarizeDispositions,
  type SearchIndexSource
} from './index-builder'

const makeRoot = (): string => mkdtempSync(join(tmpdir(), 'ps-index-builder-'))
const NOW = '2026-10-03T00:00:00.000Z'

const source = (overrides: Partial<SearchIndexSource> = {}): SearchIndexSource => ({
  id: 'file-1',
  scope: 'uploads',
  projectId: 'project-1',
  title: 'panel.csv',
  relativePath: 'uploads/panel.csv',
  checksum: 'checksum-1',
  ...overrides
})

const textReader = (
  texts: Record<string, string | undefined>
): ((id: string) => Promise<string | undefined>) => vi.fn(async (id: string) => texts[id])

describe('search index builder (S3-S1b)', () => {
  it('prefers a published checksum over stat data, and refuses to judge without either', () => {
    expect(fingerprintOf(source())).toBe('checksum:checksum-1')
    expect(fingerprintOf(source({ checksum: '', size: 12, modifiedAt: 'm1' }))).toBe('stat:12:m1')
    // A size with no timestamp cannot tell "edited in place to the same length" from "untouched".
    expect(fingerprintOf(source({ checksum: undefined, size: 12 }))).toBeUndefined()
    expect(fingerprintOf(source({ checksum: undefined }))).toBeUndefined()
  })

  it('never re-reads an item that is already indexed under the same fingerprint', async () => {
    const root = makeRoot()
    const sources = [source()]
    const first = textReader({ 'file-1': 'zebrafish ortholog panel' })
    const afterFirst = await runSearchIndexTick(
      { root, readText: first, budget: 10, now: () => NOW },
      sources,
      await readSearchIndex(root)
    )
    expect(first).toHaveBeenCalledTimes(1)
    expect(afterFirst.state.entries.map((entry) => entry.id)).toEqual(['file-1'])

    // The incremental property itself: a second pass over the same listing must not read the file again.
    const second = vi.fn(async () => {
      throw new Error('an unchanged item must not be read')
    })
    const afterSecond = await runSearchIndexTick(
      { root, readText: second, budget: 10, now: () => NOW },
      sources,
      afterFirst.state
    )
    expect(second).not.toHaveBeenCalled()
    expect(afterSecond.disposition).toEqual([{ id: 'file-1', kind: 'unchanged' }])
    rmSync(root, { recursive: true, force: true })
  })

  it('names an item it cannot fingerprint instead of indexing it under a guess', async () => {
    const root = makeRoot()
    const reader = textReader({ 'file-1': 'zebrafish ortholog panel' })
    const result = await runSearchIndexTick(
      { root, readText: reader, budget: 10, now: () => NOW },
      [source({ checksum: undefined })],
      await readSearchIndex(root)
    )

    expect(result.disposition).toEqual([{ id: 'file-1', kind: 'unfingerprintable' }])
    expect(result.state.entries).toEqual([])
    // Not even read: judging whether it changed comes first, so no work is spent on an unjudgeable item.
    expect(reader).not.toHaveBeenCalled()
    rmSync(root, { recursive: true, force: true })
  })

  it('names an unreadable item and leaves it pending rather than writing an empty entry', async () => {
    const root = makeRoot()
    const result = await runSearchIndexTick(
      { root, readText: textReader({}), budget: 10, now: () => NOW },
      [source()],
      await readSearchIndex(root)
    )

    expect(result.disposition).toEqual([{ id: 'file-1', kind: 'unreadable' }])
    // An entry with empty text would match nothing while still reporting the file as indexed.
    expect(result.state.entries).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('bounds a tick to its budget, says so, and finishes the rest on the next tick', async () => {
    const root = makeRoot()
    const sources = [
      source({ id: 'file-1' }),
      source({ id: 'file-2', checksum: 'checksum-2' }),
      source({ id: 'file-3', checksum: 'checksum-3' })
    ]
    const texts = { 'file-1': 'alpha', 'file-2': 'beta', 'file-3': 'gamma' }

    const first = await runSearchIndexTick(
      { root, readText: textReader(texts), budget: 2, now: () => NOW },
      sources,
      await readSearchIndex(root)
    )
    expect(first.truncated).toBe(true)
    expect(summarizeDispositions(first.disposition).indexed).toBe(2)
    expect(first.state.entries.map((entry) => entry.id).sort()).toEqual(['file-1', 'file-2'])

    const second = await runSearchIndexTick(
      { root, readText: textReader(texts), budget: 2, now: () => NOW },
      sources,
      first.state
    )
    expect(second.truncated).toBe(false)
    expect(second.state.entries.map((entry) => entry.id).sort()).toEqual([
      'file-1',
      'file-2',
      'file-3'
    ])
    rmSync(root, { recursive: true, force: true })
  })

  it('reports a cap-refused item as capped rather than as indexed', async () => {
    const root = makeRoot()
    const result = await runSearchIndexTick(
      {
        root,
        readText: textReader({ 'file-1': 'zebrafish '.repeat(400) }),
        budget: 10,
        now: () => NOW,
        maxBytes: 64
      },
      [source()],
      await readSearchIndex(root)
    )

    // The text was read and the write was planned, but the store refused it: saying "indexed" here would
    // send the reader looking for a hit that the index does not hold.
    expect(result.disposition).toEqual([{ id: 'file-1', kind: 'capped' }])
    expect(result.state.entries).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it('drops the entry of an item that no longer appears in the listing', async () => {
    const root = makeRoot()
    const texts = { 'file-1': 'alpha', 'file-2': 'beta' }
    const both = await runSearchIndexTick(
      { root, readText: textReader(texts), budget: 10, now: () => NOW },
      [source({ id: 'file-1' }), source({ id: 'file-2', checksum: 'checksum-2' })],
      await readSearchIndex(root)
    )
    expect(both.state.entries).toHaveLength(2)

    // file-2 is gone from the listing (deleted): its entry must disappear, or queries keep matching a file
    // that is not there any more.
    const after = await runSearchIndexTick(
      { root, readText: textReader(texts), budget: 10, now: () => NOW },
      [source({ id: 'file-1' })],
      both.state
    )
    expect(after.state.entries.map((entry) => entry.id)).toEqual(['file-1'])
    rmSync(root, { recursive: true, force: true })
  })
})
