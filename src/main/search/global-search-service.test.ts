import { describe, expect, it, vi } from 'vitest'

import {
  GLOBAL_SEARCH_MAX_SCANNED_SESSIONS,
  type GlobalSearchRequest
} from '../../shared/global-search'
import {
  createGlobalSearchService,
  type GlobalSearchPorts,
  type SearchIndexPorts,
  type SearchableFile,
  type SearchableReference,
  type SearchableSession,
  type SearchableSessionMessage
} from './global-search-service'
import type { SearchIndexRecord } from './index-store'

const session = (overrides: Partial<SearchableSession> = {}): SearchableSession => ({
  sessionId: 'session-1',
  projectId: 'project-1',
  projectName: 'proj',
  title: 'Sine plot',
  updatedAt: '2026-09-13T00:00:00.000Z',
  ...overrides
})

const message = (overrides: Partial<SearchableSessionMessage> = {}): SearchableSessionMessage => ({
  id: 'message-2',
  role: 'agent',
  timestamp: '2026-09-13T00:01:00.000Z',
  text: 'I wrote sin(x) into replay_probe.csv',
  ...overrides
})

const harness = (
  overrides: Partial<GlobalSearchPorts> = {}
): {
  service: ReturnType<typeof createGlobalSearchService>
  ports: GlobalSearchPorts
  listSessions: ReturnType<typeof vi.fn>
} => {
  const listSessions = vi.fn(async () => [session()])
  const ports: GlobalSearchPorts = {
    listSessions,
    readSessionMessages: vi.fn(async () => [message()]),
    listFiles: vi.fn(async () => [] as SearchableFile[]),
    listReferences: vi.fn(async () => [] as SearchableReference[]),
    ...overrides
  }

  return { service: createGlobalSearchService(ports), ports, listSessions }
}

const request = (overrides: Partial<GlobalSearchRequest> = {}): GlobalSearchRequest => ({
  query: 'sin',
  ...overrides
})

// S3 (incremental index): the query path must treat the index as ADDITIVE. These cases pin the union and
// the coverage/staleness readout — the two properties the parent plan's acceptance ①/④ rest on.
const indexRecord = (overrides: Partial<SearchIndexRecord> = {}): SearchIndexRecord => ({
  id: 'file-1',
  scope: 'uploads',
  fingerprint: 'fingerprint-1',
  indexedAt: '2026-10-03T00:00:00.000Z',
  bytes: 24,
  projectId: 'project-1',
  title: 'panel.csv',
  relativePath: 'uploads/panel.csv',
  text: 'zebrafish_ortholog_panel',
  ...overrides
})

describe('global search · incremental index (S3)', () => {
  const readIndexWith = (
    records: SearchIndexRecord[],
    extra: { pendingByScope?: Record<string, number>; capped?: boolean } = {}
  ): ((request: { projectId?: string }) => Promise<SearchIndexPorts>) =>
    vi.fn(async () => ({
      present: true,
      records,
      pendingByScope: extra.pendingByScope ?? {},
      capped: extra.capped ?? false
    }))

  it('returns a hit the bounded scan could not produce, and reports the index as current', async () => {
    // The scan read no files at all: without the index this query would honestly return nothing.
    const { service } = harness({
      listSessions: vi.fn(async () => []),
      readSessionMessages: vi.fn(async () => []),
      readIndex: readIndexWith([indexRecord()])
    })

    const response = await service.query(
      request({ query: 'zebrafish_ortholog_panel', scopes: ['uploads'] })
    )

    expect(response.hits).toHaveLength(1)
    expect(response.hits[0]).toMatchObject({
      scope: 'uploads',
      id: 'file-1',
      relativePath: 'uploads/panel.csv'
    })
    expect(response.coverage.uploads).toMatchObject({ indexed: 1, pending: 0, stale: false })
    // A content match came back, so the name-and-path note must not be raised.
    expect(response.notes).not.toContain('files-matched-by-name-and-path')
  })

  it('keeps returning the index hits while reporting staleness, never trading one for the other', async () => {
    const { service } = harness({
      listSessions: vi.fn(async () => []),
      readSessionMessages: vi.fn(async () => []),
      readIndex: readIndexWith([indexRecord()], { pendingByScope: { uploads: 3 } })
    })

    const response = await service.query(request({ query: 'zebrafish', scopes: ['uploads'] }))

    expect(response.hits).toHaveLength(1)
    expect(response.coverage.uploads).toMatchObject({ indexed: 1, pending: 3, stale: true })
  })

  it('names a capped index in the coverage instead of quietly holding fewer entries', async () => {
    const { service } = harness({
      listSessions: vi.fn(async () => []),
      readSessionMessages: vi.fn(async () => []),
      readIndex: readIndexWith([], { capped: true })
    })

    const response = await service.query(request({ query: 'zebrafish', scopes: ['uploads'] }))

    expect(response.hits).toHaveLength(0)
    expect(response.coverage.uploads.capped).toBe(true)
    expect(response.coverage.uploads.indexed).toBe(0)
  })

  it('reports no index facts at all when the app has no index (an honest absence)', async () => {
    const { service } = harness({
      listSessions: vi.fn(async () => []),
      readSessionMessages: vi.fn(async () => [])
    })

    const response = await service.query(request({ query: 'zebrafish', scopes: ['uploads'] }))

    expect(response.coverage.uploads.indexed).toBeUndefined()
    expect(response.coverage.uploads.stale).toBeUndefined()
  })
})

describe('createGlobalSearchService', () => {
  // Found by running the search against real Chinese text: a message whose characters merely all appear
  // scored higher than one containing the phrase, because every part counts as a match. The phrase the
  // reader typed must win.
  it('ranks a phrase hit above one assembled from its parts', async () => {
    const { service } = harness({
      readSessionMessages: vi.fn(async () => [
        message({ id: 'literal', role: 'user', text: '请解释注意力机制的实现' }),
        message({ id: 'parts', role: 'user', text: '本页先讲注意力，再讲力机制' })
      ])
    })

    const response = await service.query({ query: '注意力机制' })

    const messages = response.hits.filter((hit) => hit.scope === 'messages')
    expect(messages.map((hit) => hit.id)).toEqual(['literal', 'parts'])
    expect(messages[0]?.matches.some((match) => match.matchKind === 'literal')).toBe(true)
    expect(messages[1]?.matches.every((match) => match.matchKind === 'segmented')).toBe(true)
  })

  it('refuses a query too short to search, and says why', async () => {
    const { service, listSessions } = harness()
    const response = await service.query(request({ query: 's' }))

    expect(response.hits).toEqual([])
    expect(response.notes).toContain('query-too-short')
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('finds a message body with provenance, not just text', async () => {
    const { service } = harness()
    const response = await service.query(request({ scopes: ['messages'] }))

    expect(response.hits).toHaveLength(1)
    expect(response.hits[0]).toMatchObject({
      scope: 'messages',
      id: 'message-2',
      sessionId: 'session-1',
      messageIndex: 0,
      role: 'agent',
      timestamp: '2026-09-13T00:01:00.000Z'
    })
    expect(response.hits[0].matches[0]).toMatchObject({ field: 'body', offset: 8 })
    expect(response.counts.messages).toBe(1)
  })

  it('ranks a session-title hit above a body-only hit', async () => {
    const { service } = harness({
      readSessionMessages: vi.fn(async () => [message({ text: 'the title says sin too' })])
    })
    const response = await service.query(request({ scopes: ['sessions', 'messages'] }))

    expect(response.hits.map((hit) => hit.scope)).toEqual(['sessions', 'messages'])
  })

  it('reports what it scanned when nothing matched', async () => {
    const { service } = harness()
    const response = await service.query(request({ query: 'nonexistent-term' }))

    expect(response.hits).toEqual([])
    // "Not found" must carry the fact that a search actually happened.
    expect(response.scan).toMatchObject({ sessions: 1, messages: 1, bounded: false })
    expect(response.notes).not.toContain('query-too-short')
  })

  it('matches file names, paths and previews', async () => {
    const { service } = harness({
      listFiles: vi.fn(async () => [
        {
          id: 'file-1',
          projectId: 'project-1',
          title: 'sin_probe.csv',
          relativePath: 'data/sin_probe.csv',
          source: 'upload' as const,
          timestamp: '2026-09-13T00:02:00.000Z'
        },
        {
          id: 'file-2',
          projectId: 'project-1',
          title: 'sin_notes.md',
          relativePath: 'data/sin_notes.md',
          source: 'upload' as const,
          textPreview: 'we measured sin(x) at ten points',
          timestamp: '2026-09-13T00:03:00.000Z'
        }
      ])
    })
    const response = await service.query(request({ scopes: ['uploads'] }))

    expect(response.hits.map((hit) => hit.id).sort()).toEqual(['file-1', 'file-2'])
    expect(response.hits.find((hit) => hit.id === 'file-1')?.relativePath).toBe(
      'data/sin_probe.csv'
    )
  })

  it('searches literature by title, abstract, authors and doi', async () => {
    const { service } = harness({
      listReferences: vi.fn(async () => [
        {
          id: 'ref-1',
          projectId: 'project-1',
          title: 'A study of sin',
          abstract: 'we use sin',
          authors: ['Sin Author'],
          doi: '10.1/sin',
          timestamp: '2026-09-13T00:04:00.000Z'
        }
      ])
    })
    const response = await service.query(request({ scopes: ['literature'], query: 'sin' }))

    expect(response.hits).toHaveLength(1)
    expect(response.hits[0].matches.map((match) => match.field).sort()).toEqual([
      'abstract',
      'authors',
      'doi',
      'title'
    ])
  })

  it('scopes to one project when asked', async () => {
    const { service } = harness({
      listSessions: vi.fn(async () => [
        session(),
        session({ sessionId: 'session-2', projectId: 'project-2', title: 'Other sin' })
      ])
    })
    const response = await service.query(request({ scopes: ['sessions'], projectId: 'project-2' }))

    expect(response.hits.map((hit) => hit.id)).toEqual(['session-2'])
    expect(response.scan.sessions).toBe(1)
  })

  it('applies a date range and dates an undated message by its session', async () => {
    const { service } = harness({
      readSessionMessages: vi.fn(async () => [message({ timestamp: undefined })])
    })
    const response = await service.query(
      request({
        scopes: ['messages'],
        since: '2026-09-01T00:00:00.000Z',
        until: '2026-09-30T00:00:00.000Z'
      })
    )

    // A message without its own timestamp inherits the session's, so a range still places it; the hit
    // reports the date it was judged by.
    expect(response.hits).toHaveLength(1)
    expect(response.hits[0].timestamp).toBe('2026-09-13T00:00:00.000Z')
  })

  it('drops a hit whose date falls outside the range', async () => {
    const { service } = harness({ listSessions: vi.fn(async () => [session()]) })
    const response = await service.query(
      request({ scopes: ['sessions'], since: '2026-10-01T00:00:00.000Z' })
    )

    expect(response.hits).toEqual([])
    expect(response.scan.sessions).toBe(1)
  })

  it('stops at the session bound and admits it stopped early', async () => {
    const many = Array.from({ length: GLOBAL_SEARCH_MAX_SCANNED_SESSIONS + 5 }, (_, index) =>
      session({ sessionId: `session-${index}`, title: `Sine plot ${index}` })
    )
    const readSessionMessages = vi.fn(async () => [] as SearchableSessionMessage[])
    const { service } = harness({
      listSessions: vi.fn(async () => many),
      readSessionMessages
    })
    const response = await service.query(request({ scopes: ['sessions', 'messages'] }))

    expect(response.scan.bounded).toBe(true)
    expect(response.notes).toContain('scan-bounded-by-session-limit')
    expect(response.scan.sessions).toBe(GLOBAL_SEARCH_MAX_SCANNED_SESSIONS)
    expect(readSessionMessages).toHaveBeenCalledTimes(GLOBAL_SEARCH_MAX_SCANNED_SESSIONS)
  })

  it('discloses that a message body was cut before searching it', async () => {
    const { service } = harness({
      readSessionMessages: vi.fn(async () => [message({ truncated: true })])
    })
    const response = await service.query(request({ scopes: ['messages'] }))

    expect(response.notes).toContain('message-body-truncated')
  })

  it('requires every term of a multi-term query', async () => {
    const { service } = harness()
    const both = await service.query(request({ scopes: ['messages'], query: 'sin replay_probe' }))
    const missing = await service.query(request({ scopes: ['messages'], query: 'sin absent-term' }))

    expect(both.hits).toHaveLength(1)
    expect(both.hits[0].matches.map((match) => match.term).sort()).toEqual(['replay_probe', 'sin'])
    // A missing term means no hit at all — the response's counts still say what was scanned.
    expect(missing.hits).toEqual([])
    expect(missing.scan.messages).toBe(1)
  })

  it('says files are matched by name and path when no file text is available', async () => {
    const { service } = harness({
      listFiles: vi.fn(async () => [
        {
          id: 'file-1',
          projectId: 'project-1',
          title: 'deg.csv',
          relativePath: 'out/deg.csv',
          source: 'upload' as const
        }
      ])
    })

    const response = await service.query(
      request({ scopes: ['uploads'], projectId: 'project-1', query: 'sin' })
    )

    // No content provider: the response says so, rather than letting "no hit" read as "not in the file".
    expect(response.notes).toContain('files-matched-by-name-and-path')
  })

  it('searches file content once a provider supplies the text, and drops that note', async () => {
    const { service } = harness({
      listFiles: vi.fn(async () => [
        {
          id: 'file-2',
          projectId: 'project-1',
          title: 'notes.md',
          relativePath: 'notes.md',
          source: 'upload' as const,
          textPreview: 'the sin(x) series was computed here'
        }
      ])
    })

    const response = await service.query(
      request({ scopes: ['uploads'], projectId: 'project-1', query: 'sin' })
    )

    expect(response.notes).not.toContain('files-matched-by-name-and-path')
    expect(response.hits).toHaveLength(1)
    expect(response.hits[0].matches[0].field).toBe('content')
  })

  it('carries citation data on literature hits', async () => {
    const { service } = harness({
      listReferences: vi.fn(async () => [
        {
          id: 'reference-1',
          projectId: 'project-a',
          title: 'Sine tables',
          authors: ['Zhang San'],
          venue: 'Nature Methods',
          year: 2024,
          doi: '10.1000/xyz',
          timestamp: '2026-08-01T00:00:00.000Z'
        }
      ])
    })

    const response = await service.query(request({ scopes: ['literature'], query: 'sine tables' }))

    expect(response.hits).toHaveLength(1)
    expect(response.hits[0].citation).toEqual({
      authors: ['Zhang San'],
      year: 2024,
      venue: 'Nature Methods',
      doi: '10.1000/xyz'
    })
  })

  it('caps each scope and reports the truncation', async () => {
    const many = Array.from({ length: 4 }, (_, index) =>
      session({ sessionId: `session-${index}`, title: `Sine plot ${index}` })
    )
    const { service } = harness({ listSessions: vi.fn(async () => many) })
    const response = await service.query(request({ scopes: ['sessions'], limitPerScope: 2 }))

    expect(response.hits).toHaveLength(2)
    expect(response.counts.sessions).toBe(4)
    expect(response.truncated).toBe(true)
    expect(response.notes).toContain('results-truncated-per-scope')
  })
})
