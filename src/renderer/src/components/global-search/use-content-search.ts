import { useEffect, useRef, useState } from 'react'

import {
  GLOBAL_SEARCH_MIN_QUERY_CHARS,
  normalizeSearchQuery,
  type GlobalSearchRequest,
  type GlobalSearchResponse,
  type GlobalSearchScope
} from '../../../../shared/global-search'

// Content search for the command palette: one debounced query into the main-process search command,
// versioned so a slow response for an older query can never overwrite a newer one. Everything the
// response says about its own limits (bounds, notes) is passed through untouched — the palette has to
// show what was scanned, not just what was found.

export const CONTENT_SEARCH_DEBOUNCE_MS = 250

export type ContentSearchState =
  | { state: 'idle' }
  | { state: 'searching' }
  | { state: 'ready'; response: GlobalSearchResponse }
  | { state: 'failed'; message: string }

export type UseContentSearchOptions = {
  query: string
  projectId?: string
  enabled: boolean
  scopes?: GlobalSearchScope[]
  debounceMs?: number
}

export const useContentSearch = ({
  query,
  projectId,
  enabled,
  scopes,
  debounceMs = CONTENT_SEARCH_DEBOUNCE_MS
}: UseContentSearchOptions): ContentSearchState => {
  const [result, setResult] = useState<ContentSearchState>({ state: 'idle' })
  const versionRef = useRef(0)
  const normalized = normalizeSearchQuery(query)
  const searchable = enabled && normalized.length >= GLOBAL_SEARCH_MIN_QUERY_CHARS

  // The search state is owned by this effect on purpose: it is derived from the query and the
  // debounce, and every assignment is guarded by the version counter so a stale response cannot win.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!searchable) {
      versionRef.current += 1
      setResult({ state: 'idle' })
      return
    }

    const version = versionRef.current + 1
    versionRef.current = version
    setResult({ state: 'searching' })

    const timer = setTimeout(() => {
      const request: GlobalSearchRequest = {
        query: normalized,
        ...(projectId ? { projectId } : {}),
        ...(scopes ? { scopes } : {})
      }
      void window.api.search
        .query(request)
        .then((response) => {
          if (versionRef.current !== version) return
          setResult({ state: 'ready', response })
        })
        .catch((error: unknown) => {
          if (versionRef.current !== version) return
          setResult({
            state: 'failed',
            message: error instanceof Error ? error.message : String(error)
          })
        })
    }, debounceMs)

    return () => clearTimeout(timer)
  }, [debounceMs, normalized, projectId, scopes, searchable])
  /* eslint-enable react-hooks/set-state-in-effect */

  return result
}
