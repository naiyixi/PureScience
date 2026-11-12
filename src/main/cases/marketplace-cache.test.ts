import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CASE_MARKETPLACE_FORMAT,
  CASE_MARKETPLACE_INDEX_URL,
  type CaseMarketplaceIndex
} from '../../shared/case-marketplace'
import type { CaseMarketplaceFetchResult } from './marketplace'
import {
  CASE_MARKETPLACE_CACHE_FILENAME,
  createCaseMarketplaceReader,
  readCaseMarketplaceCache,
  writeCaseMarketplaceCache
} from './marketplace-cache'

// The failure this file exists for is a reader waiting on a host that will not answer: twenty packaged log lines ended
// at the shelf read's own 20 s deadline, for a document that is 739 bytes. These cases pin the two halves of the
// answer — a saved copy is shown instead of a spinner, and every answer says which of the two it is.

const index = (overrides: Partial<CaseMarketplaceIndex> = {}): CaseMarketplaceIndex => ({
  format: CASE_MARKETPLACE_FORMAT,
  version: 1,
  updatedAt: 1_793_798_339_544,
  cases: [
    {
      id: 'a',
      name: 'A',
      domain: 'general',
      summary: 's',
      author: 'x',
      license: 'MIT',
      bundleUrl: 'https://example.test/a.tar.gz',
      bundleSha256: 'b'.repeat(64),
      fileCount: 1,
      totalBytes: 1,
      publishedAt: 1
    }
  ],
  ...overrides
})

const refusal = (problem: 'unreachable' | 'bad-index'): CaseMarketplaceFetchResult => ({
  ok: false,
  problem,
  detail: problem === 'unreachable' ? 'timed-out after 20000ms' : 'unknown-format'
})

let root = ''
let cacheFile = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'case-market-cache-'))
  cacheFile = join(root, 'cases', CASE_MARKETPLACE_CACHE_FILENAME)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('the saved shelf', () => {
  it('reads back what it wrote, with the stamp of the fetch that produced it', async () => {
    await writeCaseMarketplaceCache(cacheFile, index(), 1_700_000_000_000)
    expect(await readCaseMarketplaceCache(cacheFile)).toEqual({
      index: index(),
      fetchedAt: 1_700_000_000_000
    })
  })

  it('answers nothing when nothing was saved', async () => {
    expect(await readCaseMarketplaceCache(cacheFile)).toBeNull()
  })

  it('refuses text that is not a saved shelf, and removes it', async () => {
    await writeCaseMarketplaceCache(cacheFile, index(), 1_700_000_000_000)
    await writeFile(cacheFile, 'not json', 'utf8')
    expect(await readCaseMarketplaceCache(cacheFile)).toBeNull()
    expect(existsSync(cacheFile)).toBe(false)
  })

  it('re-validates the document: a copy that no longer passes is not shown, and is removed', async () => {
    // A saved document is data from another machine, exactly like the download was.
    const raw = join(root, 'saved.json')
    await writeFile(
      raw,
      JSON.stringify({ fetchedAt: 1, index: { format: CASE_MARKETPLACE_FORMAT, version: 1 } }),
      'utf8'
    )
    expect(await readCaseMarketplaceCache(raw)).toBeNull()
    expect(existsSync(raw)).toBe(false)
  })
})

describe('the shelf read', () => {
  it('answers from the saved copy without asking the host at all', async () => {
    await writeCaseMarketplaceCache(cacheFile, index(), 1_700_000_000_000)
    const fetchIndex = vi.fn(async () => ({ ok: true as const, index: index() }))
    const read = createCaseMarketplaceReader({ cacheFile, fetchIndex, now: () => 2_000 })

    expect(await read({})).toEqual({
      ok: true,
      index: index(),
      source: 'cache',
      fetchedAt: 1_700_000_000_000
    })
    expect(fetchIndex).not.toHaveBeenCalled()
  })

  it('asks the host when the reader asked for a reload, and saves what came back', async () => {
    await writeCaseMarketplaceCache(cacheFile, index({ updatedAt: 1 }), 1_700_000_000_000)
    const fresh = index({ updatedAt: 2 })
    const fetchIndex = vi.fn(async () => ({ ok: true as const, index: fresh }))
    const read = createCaseMarketplaceReader({
      cacheFile,
      fetchIndex,
      now: () => 1_800_000_000_000
    })

    expect(await read({ refresh: true })).toEqual({
      ok: true,
      index: fresh,
      source: 'network',
      fetchedAt: 1_800_000_000_000
    })
    expect(fetchIndex).toHaveBeenCalledWith(CASE_MARKETPLACE_INDEX_URL)
    expect(await readCaseMarketplaceCache(cacheFile)).toEqual({
      index: fresh,
      fetchedAt: 1_800_000_000_000
    })
  })

  it('answers with the saved copy when the reload could not reach the host', async () => {
    await writeCaseMarketplaceCache(cacheFile, index(), 1_700_000_000_000)
    const read = createCaseMarketplaceReader({
      cacheFile,
      fetchIndex: async () => refusal('unreachable'),
      now: () => 1_800_000_000_000
    })

    // The saved list, with its own stamp — not this attempt's, and not an error beside an empty shelf.
    expect(await read({ refresh: true })).toEqual({
      ok: true,
      index: index(),
      source: 'cache',
      fetchedAt: 1_700_000_000_000
    })
  })

  it('carries the refusal when there is nothing saved to fall back to', async () => {
    const read = createCaseMarketplaceReader({
      cacheFile,
      fetchIndex: async () => refusal('unreachable')
    })
    expect(await read({})).toEqual({
      ok: false,
      problem: 'unreachable',
      detail: 'timed-out after 20000ms'
    })
  })

  it('never saves a document the window named itself', async () => {
    const fetchIndex = vi.fn(async () => ({ ok: true as const, index: index() }))
    const read = createCaseMarketplaceReader({ cacheFile, fetchIndex, now: () => 5 })

    expect(await read({ indexUrl: 'https://example.test/other.json' })).toEqual({
      ok: true,
      index: index(),
      source: 'network',
      fetchedAt: 5
    })
    expect(fetchIndex).toHaveBeenCalledWith('https://example.test/other.json')
    // One window's address must not become this machine's saved shelf.
    expect(await readCaseMarketplaceCache(cacheFile)).toBeNull()
  })

  it('writes nothing when the read failed, so a refusal is never mistaken for a saved shelf', async () => {
    const read = createCaseMarketplaceReader({
      cacheFile,
      fetchIndex: async () => refusal('bad-index')
    })
    await read({})
    await expect(readFile(cacheFile, 'utf8')).rejects.toThrow()
  })
})
