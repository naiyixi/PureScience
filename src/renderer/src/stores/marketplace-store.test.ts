import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MarketplaceSnapshot } from '../../../shared/specialist-marketplace'
import { resetMarketplaceStoreForTests, useMarketplaceStore } from './marketplace-store'

const setWindowApi = (value: unknown): void => {
  ;(globalThis as { window?: unknown }).window = value
}

const makeSnapshot = (): MarketplaceSnapshot => ({
  sources: [
    {
      id: 'github-source',
      kind: 'github',
      name: 'Test Source',
      repositoryUrl: 'https://github.com/example/marketplace',
      ref: 'main',
      trust: 'user-approved',
      keyId: 'key',
      keyFingerprint: 'f'.repeat(64),
      removable: true
    }
  ],
  specialists: [],
  failures: []
})

describe('marketplace store', () => {
  beforeEach(() => {
    resetMarketplaceStoreForTests()
  })

  it('starts empty and not refreshing', () => {
    expect(useMarketplaceStore.getState().snapshot).toBeUndefined()
    expect(useMarketplaceStore.getState().isRefreshing).toBe(false)
    expect(useMarketplaceStore.getState().lastRefreshFailed).toBe(false)
  })

  it('stores a successful snapshot and clears the failure flag', async () => {
    setWindowApi({
      api: {
        specialist: {
          marketplaceList: vi.fn().mockResolvedValue(makeSnapshot())
        }
      }
    })
    await useMarketplaceStore.getState().refresh()
    const state = useMarketplaceStore.getState()
    expect(state.snapshot?.sources[0]?.name).toBe('Test Source')
    expect(state.isRefreshing).toBe(false)
    expect(state.lastRefreshFailed).toBe(false)
  })

  it('keeps the previous snapshot and marks the refresh failed on error', async () => {
    setWindowApi({
      api: {
        specialist: {
          marketplaceList: vi
            .fn()
            .mockResolvedValueOnce(makeSnapshot())
            .mockRejectedValueOnce(new Error('network'))
        }
      }
    })
    await useMarketplaceStore.getState().refresh()
    await useMarketplaceStore.getState().refresh()
    const state = useMarketplaceStore.getState()
    expect(state.snapshot?.sources[0]?.name).toBe('Test Source')
    expect(state.lastRefreshFailed).toBe(true)
  })

  it('ignores stale responses when a newer refresh superseded them', async () => {
    let resolveFirst: (value: MarketplaceSnapshot) => void = () => undefined
    setWindowApi({
      api: {
        specialist: {
          marketplaceList: vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise<MarketplaceSnapshot>((resolve) => {
                  resolveFirst = resolve
                })
            )
            .mockResolvedValueOnce(makeSnapshot())
        }
      }
    })
    const first = useMarketplaceStore.getState().refresh()
    const second = useMarketplaceStore.getState().refresh()
    await second
    resolveFirst(makeSnapshot())
    await first
    // The stale first response must not flip the store back to refreshing.
    expect(useMarketplaceStore.getState().isRefreshing).toBe(false)
  })

  it('fails closed when the Electron bridge is unavailable', async () => {
    delete (globalThis as { window?: unknown }).window
    await useMarketplaceStore.getState().refresh()
    expect(useMarketplaceStore.getState().lastRefreshFailed).toBe(true)
  })
})
