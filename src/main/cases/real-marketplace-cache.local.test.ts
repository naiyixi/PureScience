import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CASE_MARKETPLACE_INDEX_URL } from '../../shared/case-marketplace'
import { fetchCaseMarketplaceIndex } from './marketplace'
import { createCaseMarketplaceReader, readCaseMarketplaceCache } from './marketplace-cache'

// Real machine, real network, real host.
//
// Run explicitly: VITEST_LOCAL=1 npx vitest run src/main/cases/real-marketplace-cache.local.test.ts
//
// Two claims are checked against the live index rather than a fixture: the document is small enough that a 20 s
// deadline buys nothing, and once it has been read the shelf answers from this machine without touching the network
// at all. Nothing here is a mock except the second read's fetcher, which exists to fail loudly if it is ever called.

describe('the shelf against the live index', () => {
  it('reads it once, then answers from the saved copy with no network call', async () => {
    const started = Date.now()
    const live = await fetchCaseMarketplaceIndex(CASE_MARKETPLACE_INDEX_URL)
    const elapsed = Date.now() - started
    // The measurement that motivates the saved copy: an index of a few hundred bytes, and a deadline of 20,000 ms.
    console.log(
      `[shelf] live read: ok=${String(live.ok)} ms=${String(elapsed)} cases=${
        live.ok ? String(live.index.cases.length) : '0'
      } ${live.ok ? '' : `problem=${live.problem} detail=${String(live.detail)}`}`
    )
    expect(live.ok).toBe(true)
    if (!live.ok) return

    const root = await mkdtemp(join(tmpdir(), 'case-market-live-'))
    try {
      const cacheFile = join(root, 'cases', 'marketplace-index.json')
      const readOnce = createCaseMarketplaceReader({ cacheFile })
      const first = await readOnce({ refresh: true })
      expect(first).toMatchObject({ ok: true, source: 'network' })

      // Second read: the fetcher cannot be reached, and must not be.
      const readAgain = createCaseMarketplaceReader({
        cacheFile,
        fetchIndex: async () => {
          throw new Error('the saved copy must answer without the network')
        }
      })
      const second = await readAgain({})
      expect(second).toMatchObject({ ok: true, source: 'cache' })
      if (second.ok && first.ok) {
        expect(second.index.cases.length).toBe(first.index.cases.length)
        expect(second.fetchedAt).toBe(first.fetchedAt)
      }
      const saved = await readCaseMarketplaceCache(cacheFile)
      console.log(
        `[shelf] saved copy: fetchedAt=${String(saved?.fetchedAt)} cases=${String(
          saved?.index.cases.length
        )}`
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
