import { describe, expect, it, vi } from 'vitest'

import {
  GLOBAL_SEARCH_ANNOTATION_INDEXED_FIELDS,
  GLOBAL_SEARCH_MAX_SCANNED_ANNOTATIONS,
  type GlobalSearchRequest
} from '../../shared/global-search'
import {
  createGlobalSearchService,
  type GlobalSearchPorts,
  type SearchableAnnotation,
  type SearchableFile,
  type SearchableReference,
  type SearchableSession,
  type SearchableSessionMessage
} from './global-search-service'

// The annotation scope (A5, 需求 1). What it asserts is the scope's honesty rather than its plumbing:
//
//   * the corpus is the STORED text — the annotation's `body` and the `quote` inside its selector — and a
//     hit names which of the two matched, so the result can be explained;
//   * a hit carries the anchor (file version + checksum) with it, so a citation is built from what the
//     search actually saw;
//   * an empty corpus says so (`annotations-empty`) and a bounded one says so (`annotations-bounded`),
//     because a miss must never read as "that markup does not exist";
//   * the scope stays inside the project it was asked about.

const session = (): SearchableSession => ({
  sessionId: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  updatedAt: '2026-09-13T00:00:00.000Z'
})

const annotation = (overrides: Partial<SearchableAnnotation> = {}): SearchableAnnotation => ({
  id: 'annotation-1',
  projectId: 'project-1',
  sourceFileId: 'artifact-1',
  versionId: 'version-1',
  checksum: 'a'.repeat(64),
  kind: 'highlight',
  body: 'A note about the effect size.',
  quote: 'the effect is large',
  page: 4,
  fileName: 'paper.pdf',
  createdAt: 1,
  timestamp: '2026-09-13T00:02:00.000Z',
  ...overrides
})

const harness = (
  overrides: Partial<GlobalSearchPorts> = {}
): { service: ReturnType<typeof createGlobalSearchService> } => {
  const ports: GlobalSearchPorts = {
    listSessions: vi.fn(async () => [session()]),
    readSessionMessages: vi.fn(async () => [] as SearchableSessionMessage[]),
    listFiles: vi.fn(async () => [] as SearchableFile[]),
    listReferences: vi.fn(async () => [] as SearchableReference[]),
    listAnnotations: vi.fn(async () => [annotation()]),
    ...overrides
  }

  return { service: createGlobalSearchService(ports) }
}

const request = (overrides: Partial<GlobalSearchRequest> = {}): GlobalSearchRequest => ({
  query: 'effect',
  projectId: 'project-1',
  scopes: ['annotations'],
  ...overrides
})

describe('global search — the annotation scope', () => {
  it('names the two stored fields the scope searches', () => {
    // The contract has to SAY what is in the index, because "we only read stored text" is otherwise a claim
    // a reader cannot check. This is that statement, pinned.
    expect([...GLOBAL_SEARCH_ANNOTATION_INDEXED_FIELDS]).toEqual(['body', 'quote'])
  })

  it('matches the quoted passage and says the match came from the quote', async () => {
    const { service } = harness()
    // 'large' appears in the quoted passage only — the note does not carry the word.
    const response = await service.query(request({ query: 'large' }))

    expect(response.hits).toHaveLength(1)
    expect(response.hits[0]).toMatchObject({
      scope: 'annotations',
      id: 'annotation-1',
      title: 'paper.pdf'
    })
    expect(response.hits[0]!.matches.map((match) => match.field)).toEqual(['quote'])
    expect(response.counts.annotations).toBe(1)
    expect(response.scan.annotations).toBe(1)
  })

  it('matches the reader’s own note and says the match came from the body', async () => {
    const { service } = harness()
    // 'size' appears in the note only — the quoted passage does not carry the word.
    const response = await service.query(request({ query: 'size' }))

    expect(response.hits[0]!.matches.map((match) => match.field)).toEqual(['body'])
  })

  it('carries the anchor with the hit, so a citation is built from what the search saw', async () => {
    const { service } = harness()
    const [hit] = (await service.query(request())).hits

    expect(hit!.annotation).toEqual({
      annotationId: 'annotation-1',
      sourceFileId: 'artifact-1',
      versionId: 'version-1',
      checksum: 'a'.repeat(64),
      kind: 'highlight',
      page: 4,
      quote: 'the effect is large'
    })
  })

  it('leaves the page and the quote out of the anchor when the markup has neither', async () => {
    const { service } = harness({
      listAnnotations: vi.fn(async () => [
        annotation({
          id: 'note',
          kind: 'document-note',
          body: 'the effect section needs a rewrite',
          quote: '',
          page: undefined
        })
      ])
    })
    const [hit] = (await service.query(request())).hits

    expect(hit!.annotation).not.toHaveProperty('page')
    expect(hit!.annotation).not.toHaveProperty('quote')
  })

  it('reports an empty corpus rather than letting a miss speak for it', async () => {
    const { service } = harness({ listAnnotations: vi.fn(async () => []) })
    const response = await service.query(request({ query: 'nothing like it' }))

    expect(response.hits).toEqual([])
    expect(response.notes).toContain('annotations-empty')
  })

  it('says so when the corpus stopped at its bound', async () => {
    const many = Array.from({ length: GLOBAL_SEARCH_MAX_SCANNED_ANNOTATIONS + 1 }, (_, index) =>
      annotation({ id: `annotation-${index}` })
    )
    const { service } = harness({ listAnnotations: vi.fn(async () => many) })
    const response = await service.query(request())

    expect(response.scan.annotations).toBe(GLOBAL_SEARCH_MAX_SCANNED_ANNOTATIONS)
    expect(response.notes).toContain('annotations-bounded')
  })

  it('stays inside the project it was asked about', async () => {
    const { service } = harness({
      listAnnotations: vi.fn(async () => [annotation({ projectId: 'project-2' })])
    })
    const response = await service.query(request({ query: 'effect' }))

    expect(response.hits).toEqual([])
    expect(response.scan.annotations).toBe(0)
  })

  it('does not search annotations when the caller asked for another scope', async () => {
    const listAnnotations = vi.fn(async () => [annotation()])
    const { service } = harness({ listAnnotations })
    const response = await service.query(request({ scopes: ['messages'] }))

    expect(response.hits).toEqual([])
    expect(response.counts.annotations).toBe(0)
    expect(listAnnotations).not.toHaveBeenCalled()
  })

  it('drops annotation hits under a sender filter, which they cannot answer', async () => {
    const { service } = harness()
    const response = await service.query(request({ role: 'user' }))

    expect(response.hits).toEqual([])
    expect(response.counts.annotations).toBe(0)
  })

  it('scores a hit by what it found, not by repeating its own text in the title', async () => {
    // The title is the file's name, so a query that matches only the annotation's text does not earn the
    // title bonus. Two hits alike in the body therefore keep the same order however they are titled.
    const { service } = harness({
      listAnnotations: vi.fn(async () => [
        annotation({ id: 'one', fileName: 'a.pdf', body: 'effect' }),
        annotation({ id: 'two', fileName: 'effect.pdf', body: 'effect' })
      ])
    })
    const response = await service.query(request({ query: 'effect' }))

    expect(response.hits.map((hit) => hit.id)).toEqual(['two', 'one'])
    expect(response.hits[0]!.score).toBeGreaterThan(response.hits[1]!.score)
  })
})
