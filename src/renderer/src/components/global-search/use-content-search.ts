import { useCallback, useEffect, useRef, useState } from 'react'

import {
  GLOBAL_SEARCH_MIN_QUERY_CHARS,
  normalizeSearchQuery,
  type GlobalSearchHitFilters,
  type GlobalSearchRequest,
  type GlobalSearchResponse,
  type GlobalSearchScope
} from '../../../../shared/global-search'

// Content search for the command palette: one debounced query into the main-process search command,
// versioned so a slow response for an older query can never overwrite a newer one. Everything the
// response says about its own limits (bounds, notes) is passed through untouched — the palette has to
// show what was scanned, not just what was found.
//
// Paging is the same deal: the response says whether there is more and hands back a cursor. The hook
// accumulates the pages the reader asked for and never pretends the first page was everything.

export const CONTENT_SEARCH_DEBOUNCE_MS = 250

export type ContentSearchState =
  | { state: 'idle' }
  | { state: 'searching' }
  | { state: 'ready'; response: GlobalSearchResponse }
  | { state: 'failed'; message: string }

export type ContentSearchResult = {
  state: ContentSearchState
  /** Fetches the next page and appends it. A no-op while one is in flight or when there is no cursor. */
  loadMore: () => void
  loadingMore: boolean
  /** True when the last response offered a cursor. */
  hasMore: boolean
}

export type UseContentSearchOptions = {
  query: string
  projectId?: string
  enabled: boolean
  scopes?: GlobalSearchScope[]
  /** Applied before paging, by the search itself: the pages are pages of what was asked for. */
  filters?: GlobalSearchHitFilters
  debounceMs?: number
}

export const useContentSearch = ({
  query,
  projectId,
  enabled,
  scopes,
  filters,
  debounceMs = CONTENT_SEARCH_DEBOUNCE_MS
}: UseContentSearchOptions): ContentSearchResult => {
  const [state, setState] = useState<ContentSearchState>({ state: 'idle' })
  const [loadingMore, setLoadingMore] = useState(false)
  const versionRef = useRef(0)
  const normalized = normalizeSearchQuery(query)
  const searchable = enabled && normalized.length >= GLOBAL_SEARCH_MIN_QUERY_CHARS

  // The filters are compared by value: a caller that rebuilds the object every render must not restart
  // the search, and a caller that changes one must.
  const filterKey = JSON.stringify(filters ?? null)
  const scopeKey = JSON.stringify(scopes ?? null)

  // Built explicitly rather than spread: the filter shape carries readonly arrays and the request takes
  // plain ones, and a copy keeps the caller's object out of the request that goes over IPC.
  const filterRequest = useCallback((): Pick<
    GlobalSearchRequest,
    'role' | 'extensions' | 'referenceTypes'
  > => {
    return {
      ...(filters?.role ? { role: filters.role } : {}),
      ...(filters?.extensions?.length ? { extensions: [...filters.extensions] } : {}),
      ...(filters?.referenceTypes?.length ? { referenceTypes: [...filters.referenceTypes] } : {})
    }
    // Keyed by value: see the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  // The search state is owned by this effect on purpose: it is derived from the query and the
  // debounce, and every assignment is guarded by the version counter so a stale response cannot win.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!searchable) {
      versionRef.current += 1
      setState({ state: 'idle' })
      setLoadingMore(false)
      return
    }

    const version = versionRef.current + 1
    versionRef.current = version
    setState({ state: 'searching' })
    setLoadingMore(false)

    const timer = setTimeout(() => {
      const request: GlobalSearchRequest = {
        query: normalized,
        ...(projectId ? { projectId } : {}),
        ...(scopes ? { scopes } : {}),
        ...filterRequest()
      }
      void window.api.search
        .query(request)
        .then((response) => {
          if (versionRef.current !== version) return
          setState({ state: 'ready', response })
        })
        .catch((error: unknown) => {
          if (versionRef.current !== version) return
          setState({
            state: 'failed',
            message: error instanceof Error ? error.message : String(error)
          })
        })
    }, debounceMs)

    return () => clearTimeout(timer)
    // `scopeKey`/`filterKey` are comparisons by value on purpose: a caller that rebuilds the arrays each
    // render must not restart the search, and one that changes a value must.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounceMs, normalized, projectId, scopeKey, filterKey, searchable])
  /* eslint-enable react-hooks/set-state-in-effect */

  const loadMore = useCallback(() => {
    const cursor = state.state === 'ready' ? state.response.nextCursor : undefined
    if (!cursor || loadingMore) return

    const version = versionRef.current
    setLoadingMore(true)
    const request: GlobalSearchRequest = {
      query: normalized,
      cursor,
      ...(projectId ? { projectId } : {}),
      ...(scopes ? { scopes } : {}),
      ...filterRequest()
    }
    void window.api.search
      .query(request)
      .then((response) => {
        // A response for a query that has since changed is dropped rather than appended to the new one.
        if (versionRef.current !== version) return
        setState((current) =>
          current.state === 'ready'
            ? {
                state: 'ready',
                response: {
                  ...response,
                  hits: [...current.response.hits, ...response.hits]
                }
              }
            : current
        )
      })
      .catch(() => undefined)
      .finally(() => {
        if (versionRef.current === version) setLoadingMore(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, loadingMore, normalized, projectId, scopeKey, filterKey, filterRequest])

  return {
    state,
    loadMore,
    loadingMore,
    hasMore: state.state === 'ready' && state.response.nextCursor !== undefined
  }
}
