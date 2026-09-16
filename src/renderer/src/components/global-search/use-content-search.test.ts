// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GlobalSearchResponse } from '../../../../shared/global-search'
import { useContentSearch, type UseContentSearchOptions } from './use-content-search'

// React's act() refuses to run unless the environment opts in to act-aware scheduling.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const renderHook = (
  hook: () => ReturnType<typeof useContentSearch>
): { result: { current: ReturnType<typeof useContentSearch> }; rerender: () => void } => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const result = { current: undefined as unknown as ReturnType<typeof useContentSearch> }

  const HookHarness = (): null => {
    result.current = hook()
    return null
  }

  act(() => {
    root.render(createElement(HookHarness))
  })

  return {
    result,
    rerender: () => act(() => root.render(createElement(HookHarness)))
  }
}

const response = (
  hits: { id: string }[],
  nextCursor?: string,
  counts = { sessions: 0, messages: hits.length, files: 0, literature: 0 }
): GlobalSearchResponse => ({
  schemaVersion: 1,
  query: '注意力',
  scopes: ['sessions', 'messages', 'files', 'literature'],
  hits: hits.map((hit) => ({
    scope: 'messages' as const,
    id: hit.id,
    projectId: 'project-1',
    title: '会话',
    score: 1,
    matches: [{ field: 'body', snippet: '…', offset: 0 }]
  })),
  ...(nextCursor ? { nextCursor } : {}),
  counts,
  truncated: nextCursor !== undefined,
  scan: { sessions: 1, messages: 3, files: 0, references: 0, bounded: false },
  appliedLimit: 5,
  notes: []
})

describe('useContentSearch', () => {
  const query = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    query.mockReset()
    ;(globalThis as { window?: unknown }).window = {
      api: { search: { query } }
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs the query after the debounce and reports the response', async () => {
    query.mockResolvedValue(response([{ id: 'm1' }]))
    const { result } = renderHook(() =>
      useContentSearch({ query: '注意力', enabled: true, debounceMs: 10 })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })

    expect(query).toHaveBeenCalledTimes(1)
    expect(result.current.state.state).toBe('ready')
    expect(result.current.hasMore).toBe(false)
  })

  it('offers more when the response came with a cursor', async () => {
    query.mockResolvedValue(response([{ id: 'm1' }], 'v1:messages=1'))
    const { result } = renderHook(() =>
      useContentSearch({ query: '注意力', enabled: true, debounceMs: 10 })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })

    expect(result.current.hasMore).toBe(true)
  })

  // The point of paging: the second page is appended to the first, asked for with the cursor the search
  // handed back — never re-requested from the beginning.
  it('appends the next page when asked, using the cursor', async () => {
    query
      .mockResolvedValueOnce(response([{ id: 'm1' }], 'v1:messages=1'))
      .mockResolvedValueOnce(response([{ id: 'm2' }]))
    const { result } = renderHook(() =>
      useContentSearch({ query: '注意力', enabled: true, debounceMs: 10 })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })

    await act(async () => {
      result.current.loadMore()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1][0]).toMatchObject({ cursor: 'v1:messages=1' })
    const state = result.current.state
    expect(state.state === 'ready' && state.response.hits.map((hit) => hit.id)).toEqual([
      'm1',
      'm2'
    ])
    expect(result.current.hasMore).toBe(false)
  })

  it('does nothing when there is no cursor', async () => {
    query.mockResolvedValue(response([{ id: 'm1' }]))
    const { result } = renderHook(() =>
      useContentSearch({ query: '注意力', enabled: true, debounceMs: 10 })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })

    await act(async () => {
      result.current.loadMore()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(query).toHaveBeenCalledTimes(1)
  })

  // Filters travel with the query: the pages are pages of what was asked for.
  it('sends the filters with the request', async () => {
    query.mockResolvedValue(response([{ id: 'm1' }]))
    renderHook(() =>
      useContentSearch({
        query: '注意力',
        enabled: true,
        debounceMs: 10,
        filters: { role: 'agent', extensions: ['csv'] }
      })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })

    expect(query.mock.calls[0][0]).toMatchObject({ role: 'agent', extensions: ['csv'] })
  })

  it('re-runs rather than appending when the filters change', async () => {
    query
      .mockResolvedValueOnce(response([{ id: 'm1' }], 'v1:messages=1'))
      .mockResolvedValueOnce(response([{ id: 'm3' }]))
    let filters: UseContentSearchOptions['filters'] = { role: 'user' }
    const { rerender, result } = renderHook(() =>
      useContentSearch({ query: '注意力', enabled: true, debounceMs: 10, filters })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })

    filters = { role: 'agent' }
    rerender()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })

    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1][0]).toMatchObject({ role: 'agent' })
    const state = result.current.state
    expect(state.state === 'ready' && state.response.hits.map((hit) => hit.id)).toEqual(['m3'])
  })
})
