import { describe, expect, it } from 'vitest'

import {
  collectTermMatches,
  decodeSearchCursor,
  encodeSearchCursor,
  finalizeSearchResponse,
  searchHitMatchesFilters,
  type GlobalSearchHit,
  type GlobalSearchScanReport
} from './global-search'

const hit = (overrides: Partial<GlobalSearchHit> = {}): GlobalSearchHit => ({
  scope: 'messages',
  id: 'message-1',
  projectId: 'project-1',
  title: '会话',
  score: 10,
  matches: [{ field: 'body', snippet: '…', offset: 0 }],
  ...overrides
})

const scan: GlobalSearchScanReport = {
  sessions: 1,
  messages: 3,
  files: 2,
  references: 1,
  bounded: false
}

const finalize = (
  hits: GlobalSearchHit[],
  overrides: Partial<Parameters<typeof finalizeSearchResponse>[0]> = {}
): ReturnType<typeof finalizeSearchResponse> =>
  finalizeSearchResponse({
    query: 'cos',
    scopes: ['sessions', 'messages', 'files', 'literature'],
    hits,
    scan,
    appliedLimit: 2,
    notes: [],
    ...overrides
  })

describe('global search — cursor pagination', () => {
  const messages = [
    hit({ id: 'm1', score: 30 }),
    hit({ id: 'm2', score: 20 }),
    hit({ id: 'm3', score: 10 })
  ]

  it('serves a page per scope and offers a cursor when more remains', () => {
    const first = finalize(messages)

    expect(first.hits.map((entry) => entry.id)).toEqual(['m1', 'm2'])
    expect(first.truncated).toBe(true)
    expect(first.nextCursor).toBeDefined()
  })

  it('continues from the cursor without repeating a hit', () => {
    const first = finalize(messages)
    const second = finalize(messages, { cursor: first.nextCursor })

    expect(second.hits.map((entry) => entry.id)).toEqual(['m3'])
    expect(second.nextCursor).toBeUndefined()
    expect(second.truncated).toBe(false)
  })

  // Each scope pages on its own, so a scope with one hit must not be skipped because another has many.
  it('keeps one offset per scope', () => {
    const mixed = [
      hit({ id: 'm1', score: 40 }),
      hit({ id: 'm2', score: 30 }),
      hit({ id: 'm3', score: 20 }),
      hit({ id: 'f1', scope: 'files', score: 10, relativePath: 'results/table.csv' })
    ]
    const first = finalize(mixed, { appliedLimit: 2 })
    const second = finalize(mixed, { appliedLimit: 2, cursor: first.nextCursor })

    expect(first.hits.map((entry) => entry.id)).toEqual(['m1', 'm2', 'f1'])
    expect(second.hits.map((entry) => entry.id)).toEqual(['m3'])
  })

  it('round-trips a cursor it produced', () => {
    const cursor = encodeSearchCursor({ messages: 4, files: 2 })

    expect(decodeSearchCursor(cursor)).toEqual({
      offsets: { sessions: 0, messages: 4, files: 2, literature: 0 },
      invalid: false
    })
  })

  // A cursor that cannot be read must not serve page one as if it were page two.
  it('restarts and says so when a cursor is unreadable', () => {
    for (const cursor of ['nonsense', 'v1:unknown=3', 'v1:messages=-1', 'v2:messages=2']) {
      const response = finalize(messages, { cursor })

      expect(response.hits.map((entry) => entry.id)).toEqual(['m1', 'm2'])
      expect(response.notes).toContain('cursor-invalid')
    }
  })

  it('reports the same counts on every page', () => {
    const first = finalize(messages)
    const second = finalize(messages, { cursor: first.nextCursor })

    expect(first.counts.messages).toBe(3)
    expect(second.counts.messages).toBe(3)
  })
})

describe('global search — filters applied before pagination', () => {
  const mixed = [
    hit({ id: 'user-1', role: 'user', score: 30 }),
    hit({ id: 'agent-1', role: 'agent', score: 25 }),
    hit({ id: 'user-2', role: 'user', score: 20 })
  ]

  it('fills the page with hits that already satisfy the sender filter', () => {
    const response = finalize(mixed, { appliedLimit: 2, filters: { role: 'user' } })

    expect(response.hits.map((entry) => entry.id)).toEqual(['user-1', 'user-2'])
    expect(response.counts.messages).toBe(2)
    expect(response.nextCursor).toBeUndefined()
    expect(response.truncated).toBe(false)
  })

  // A sender filter is a statement about messages: a file list cannot satisfy it.
  it('drops scopes that cannot carry the filtered property', () => {
    const withFile = [...mixed, hit({ id: 'f1', scope: 'files', score: 60, relativePath: 'a.csv' })]
    const response = finalize(withFile, { filters: { role: 'user' } })

    expect(response.hits.map((entry) => entry.id)).toEqual(['user-1', 'user-2'])
    expect(response.counts.files).toBe(0)
  })

  it('filters files by format', () => {
    const files = [
      hit({ id: 'f1', scope: 'files', score: 30, relativePath: 'results/table.csv' }),
      hit({ id: 'f2', scope: 'files', score: 20, relativePath: 'figures/plot.PNG' }),
      hit({ id: 'f3', scope: 'files', score: 10, relativePath: 'README.md' })
    ]
    const response = finalize(files, { filters: { extensions: ['csv', '.png'] } })

    expect(response.hits.map((entry) => entry.id)).toEqual(['f1', 'f2'])
  })

  it('filters literature by record type', () => {
    const references = [
      hit({ id: 'l1', scope: 'literature', score: 30, citation: { authors: [], doi: '10.1/x' } }),
      hit({
        id: 'l2',
        scope: 'literature',
        score: 20,
        citation: { authors: [], arxivId: '2401.1' }
      }),
      hit({ id: 'l3', scope: 'literature', score: 10, citation: { authors: [] } })
    ]

    expect(
      finalize(references, { filters: { referenceTypes: ['arxiv'] } }).hits.map((h) => h.id)
    ).toEqual(['l2'])
    expect(
      finalize(references, { filters: { referenceTypes: ['doi', 'pmid'] } }).hits.map((h) => h.id)
    ).toEqual(['l1'])
  })

  it('matches a hit against the filters it declares', () => {
    expect(
      searchHitMatchesFilters(hit({ role: 'agent', scope: 'messages' }), { role: 'agent' })
    ).toBe(true)
    expect(
      searchHitMatchesFilters(hit({ role: 'user', scope: 'messages' }), { role: 'agent' })
    ).toBe(false)
    expect(
      searchHitMatchesFilters(hit({ scope: 'files', relativePath: 'a.csv' }), {
        extensions: ['csv']
      })
    ).toBe(true)
    expect(
      searchHitMatchesFilters(hit({ scope: 'files', relativePath: 'a' }), { extensions: ['csv'] })
    ).toBe(false)
    expect(searchHitMatchesFilters(hit({ scope: 'messages' }), {})).toBe(true)
  })
})

describe('global search — a Chinese term with no literal occurrence', () => {
  // The phrase is not in the text, but every part of it is: that is the recall a Chinese query needs,
  // and requiring all the parts is what keeps it from matching on a single shared pair of characters.
  it('matches on the term’s parts when every part is present', () => {
    const matches = collectTermMatches({
      // The bigrams of 注意力机制 are 注意 · 意力 · 力机 · 机制; this text has them all and the phrase
      // itself nowhere, which is exactly the case literal matching cannot reach.
      text: '本页先讲注意力，再讲力机制',
      terms: ['注意力机制'],
      field: 'body'
    })

    expect(matches.length).toBeGreaterThan(0)
    expect(matches.every((match) => match.matchKind === 'segmented')).toBe(true)
    expect(matches.every((match) => match.term === '注意力机制')).toBe(true)
  })

  it('refuses when only some of the parts are present', () => {
    // 力机 is missing, so the term is not satisfied by parts — one shared pair of characters is not a match.
    expect(
      collectTermMatches({
        text: '本文讨论注意力与机制的实现',
        terms: ['注意力机制'],
        field: 'body'
      })
    ).toEqual([])
  })

  it('keeps a literal occurrence literal', () => {
    const matches = collectTermMatches({
      text: '注意力机制的定义',
      terms: ['注意力机制'],
      field: 'body'
    })

    expect(matches.every((match) => match.matchKind === 'literal')).toBe(true)
  })

  it('surfaces that a hit matched by parts, not by the phrase', () => {
    const response = finalize(
      [
        hit({
          id: 'seg',
          matches: [
            { field: 'body', snippet: '…', offset: 0, term: '注意力机制', matchKind: 'segmented' }
          ]
        })
      ],
      { notes: [] }
    )

    expect(response.notes).toContain('matched-by-term-parts')
  })

  it('does not attempt part matching for a latin term', () => {
    expect(
      collectTermMatches({ text: 'retrieval', terms: ['retrieval-augmented'], field: 'body' })
    ).toEqual([])
  })
})
