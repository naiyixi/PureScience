// Tests for the renderer memory store: lazy load on first open, authoritative-cache replacement on
// write, and failure isolation (load errors leave the panel able to retry; save errors re-throw so
// the panel can surface them without corrupting the cache).

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useMemoryStore } from './memory-store'

const memoryFixture = {
  enabled: true,
  categories: [{ id: 'about-you', name: 'About you', createdAt: 1000 }],
  notes: [
    {
      id: 'note-1',
      categoryId: 'about-you',
      text: 'Prefers concise answers',
      createdAt: 1001,
      updatedAt: 1002
    }
  ]
}

describe('memory store', () => {
  beforeEach(() => {
    useMemoryStore.setState({ memory: undefined, isLoading: false })
  })

  it('loads memory from main and caches it', async () => {
    const getMemory = vi.fn().mockResolvedValue(memoryFixture)
    vi.stubGlobal('window', { api: { settings: { getMemory } } })

    const loaded = await useMemoryStore.getState().loadMemory()

    expect(getMemory).toHaveBeenCalledOnce()
    expect(loaded).toEqual(memoryFixture)
    expect(useMemoryStore.getState().memory).toEqual(memoryFixture)
    expect(useMemoryStore.getState().isLoading).toBe(false)

    vi.unstubAllGlobals()
  })

  it('clears the loading flag on a failed load and keeps memory undefined', async () => {
    const getMemory = vi.fn().mockRejectedValue(new Error('db locked'))
    vi.stubGlobal('window', { api: { settings: { getMemory } } })

    await useMemoryStore.getState().loadMemory()

    expect(useMemoryStore.getState().memory).toBeUndefined()
    expect(useMemoryStore.getState().isLoading).toBe(false)

    vi.unstubAllGlobals()
  })

  it('replaces the cache with the sanitized persisted shape on save', async () => {
    const setMemory = vi.fn().mockResolvedValue({
      ...memoryFixture,
      notes: []
    })
    vi.stubGlobal('window', { api: { settings: { setMemory } } })

    await useMemoryStore.getState().updateMemory(memoryFixture)

    expect(setMemory).toHaveBeenCalledWith(memoryFixture)
    expect(useMemoryStore.getState().memory).toEqual({ ...memoryFixture, notes: [] })

    vi.unstubAllGlobals()
  })

  it('re-throws on a failed save and leaves the cache untouched', async () => {
    const setMemory = vi.fn().mockRejectedValue(new Error('disk full'))
    vi.stubGlobal('window', { api: { settings: { setMemory } } })

    useMemoryStore.setState({ memory: memoryFixture })

    await expect(
      useMemoryStore.getState().updateMemory({ ...memoryFixture, enabled: false })
    ).rejects.toThrow('disk full')
    expect(useMemoryStore.getState().memory).toEqual(memoryFixture)

    vi.unstubAllGlobals()
  })
})
