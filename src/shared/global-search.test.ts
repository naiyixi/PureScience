import { describe, expect, it } from 'vitest'

import {
  clampSearchLimit,
  collectMatches,
  finalizeSearchResponse,
  GLOBAL_SEARCH_MAX_RESULTS_PER_SCOPE,
  GLOBAL_SEARCH_MAX_SCANNED_SESSIONS,
  normalizeSearchQuery,
  resolveSearchScopes,
  scoreSearchHit,
  searchHitsInTimestampRange,
  snippetAround,
  type GlobalSearchHit
} from './global-search'

const hit = (overrides: Partial<GlobalSearchHit> = {}): GlobalSearchHit => ({
  scope: 'messages',
  id: 'message-1',
  projectId: 'project-1',
  title: 'cos.png',
  score: 1,
  matches: [{ field: 'body', snippet: '…cos…', offset: 3 }],
  ...overrides
})

describe('query and scope normalization', () => {
  it('trims the query and keeps its literal text', () => {
    expect(normalizeSearchQuery('  sin(x)  ')).toBe('sin(x)')
  })

  it('searches every scope by default and only known scopes when asked', () => {
    expect(resolveSearchScopes(undefined)).toEqual(['sessions', 'messages', 'files', 'literature'])
    expect(resolveSearchScopes([])).toEqual(['sessions', 'messages', 'files', 'literature'])
    expect(resolveSearchScopes(['literature', 'messages'])).toEqual(['messages', 'literature'])
  })
})

describe('collectMatches', () => {
  it('finds literal, case-insensitive occurrences', () => {
    const matches = collectMatches({ text: 'Mean and MEAN again', query: 'mean', field: 'body' })

    expect(matches).toHaveLength(2)
    expect(matches.map((match) => match.offset)).toEqual([0, 9])
  })

  it('collapses overlapping occurrences instead of inflating the hit', () => {
    const matches = collectMatches({ text: 'aaaa', query: 'aa', field: 'body' })

    expect(matches).toHaveLength(2)
    expect(matches.map((match) => match.offset)).toEqual([0, 2])
  })

  it('matches CJK text with no word boundaries', () => {
    const matches = collectMatches({
      text: '该实验重复了三次，重复性稳定。',
      query: '重复',
      field: 'body'
    })

    expect(matches).toHaveLength(2)
  })

  it('bounds the number of matches per hit', () => {
    const matches = collectMatches({
      text: 'x'.repeat(50),
      query: 'x',
      field: 'body',
      maxMatches: 3
    })

    expect(matches).toHaveLength(3)
  })

  it('returns nothing for an empty query', () => {
    expect(collectMatches({ text: 'anything', query: '', field: 'body' })).toEqual([])
  })
})

describe('snippetAround', () => {
  it('marks the text it cut away', () => {
    const text = `${'a'.repeat(300)}needle${'b'.repeat(300)}`
    const snippet = snippetAround(text, 300, 6, 40)

    expect(snippet).toContain('needle')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('does not add ellipses when the whole text is short', () => {
    expect(snippetAround('short text', 0, 5, 40)).toBe('short text')
  })
})

describe('scoreSearchHit', () => {
  it('ranks a title match above a body-only match', () => {
    const titled = scoreSearchHit({
      matches: 1,
      titleMatched: true,
      timestamp: '2026-09-13T00:00:00.000Z'
    })
    const body = scoreSearchHit({
      matches: 1,
      titleMatched: false,
      timestamp: '2026-09-13T00:00:00.000Z'
    })

    expect(titled).toBeGreaterThan(body)
  })

  it('is deterministic for identical inputs', () => {
    const once = scoreSearchHit({ matches: 2, titleMatched: false, timestamp: undefined })
    const twice = scoreSearchHit({ matches: 2, titleMatched: false, timestamp: undefined })

    expect(twice).toBe(once)
  })
})

describe('searchHitsInTimestampRange', () => {
  it('keeps everything when no range is given', () => {
    expect(searchHitsInTimestampRange(undefined, {})).toBe(true)
  })

  it('drops an undated hit once a range is requested', () => {
    expect(searchHitsInTimestampRange(undefined, { since: '2026-09-01T00:00:00.000Z' })).toBe(false)
  })

  it('applies inclusive bounds', () => {
    const since = '2026-09-01T00:00:00.000Z'
    const until = '2026-09-30T00:00:00.000Z'

    expect(searchHitsInTimestampRange(since, { since, until })).toBe(true)
    expect(searchHitsInTimestampRange(until, { since, until })).toBe(true)
    expect(searchHitsInTimestampRange('2026-08-31T23:59:59.000Z', { since, until })).toBe(false)
  })
})

describe('clampSearchLimit', () => {
  it('defaults and clamps to the per-scope maximum', () => {
    expect(clampSearchLimit(undefined)).toBe(GLOBAL_SEARCH_MAX_RESULTS_PER_SCOPE)
    expect(clampSearchLimit(0)).toBe(1)
    expect(clampSearchLimit(10_000)).toBe(GLOBAL_SEARCH_MAX_RESULTS_PER_SCOPE)
    expect(clampSearchLimit(12.7)).toBe(12)
  })
})

describe('finalizeSearchResponse', () => {
  it('reports what it scanned and how many hits each scope has', () => {
    const response = finalizeSearchResponse({
      query: 'sin',
      scopes: ['messages', 'files'],
      hits: [
        hit({ id: 'message-1', scope: 'messages' }),
        hit({ id: 'file-1', scope: 'files', score: 9 })
      ],
      scan: { sessions: 3, messages: 12, files: 4, references: 0, bounded: false },
      appliedLimit: 50,
      notes: []
    })

    expect(response.counts).toEqual({ sessions: 0, messages: 1, files: 1, literature: 0 })
    expect(response.truncated).toBe(false)
    expect(response.scan.sessions).toBe(3)
    expect(response.hits[0].id).toBe('file-1')
  })

  it('caps each scope separately and admits that it capped', () => {
    const response = finalizeSearchResponse({
      query: 'x',
      scopes: ['messages'],
      hits: [
        hit({ id: 'message-1', score: 5 }),
        hit({ id: 'message-2', score: 4 }),
        hit({ id: 'file-1', scope: 'files', score: 3 })
      ],
      scan: { sessions: 1, messages: 3, files: 1, references: 0, bounded: false },
      appliedLimit: 1,
      notes: []
    })

    expect(response.hits.map((entry) => entry.id)).toEqual(['message-1', 'file-1'])
    expect(response.truncated).toBe(true)
    expect(response.counts.messages).toBe(2)
    expect(response.notes).toContain('results-truncated-per-scope')
  })

  it('carries a bounded-scan note through to the caller', () => {
    const response = finalizeSearchResponse({
      query: 'x',
      scopes: ['messages'],
      hits: [],
      scan: {
        sessions: GLOBAL_SEARCH_MAX_SCANNED_SESSIONS,
        messages: 0,
        files: 0,
        references: 0,
        bounded: true
      },
      appliedLimit: 50,
      notes: ['scan-bounded-by-session-limit']
    })

    // An empty result must still say how far the search actually looked.
    expect(response.hits).toEqual([])
    expect(response.notes).toContain('scan-bounded-by-session-limit')
    expect(response.scan.bounded).toBe(true)
  })
})
