import { describe, expect, it, vi } from 'vitest'

import {
  GLOBAL_SEARCH_MAX_SCANNED_SESSIONS,
  type GlobalSearchRequest
} from '../../shared/global-search'
import {
  createGlobalSearchService,
  type GlobalSearchPorts,
  type SearchableFile,
  type SearchableReference,
  type SearchableSession,
  type SearchableSessionMessage
} from './global-search-service'

const session = (overrides: Partial<SearchableSession> = {}): SearchableSession => ({
  sessionId: 'session-1',
  projectId: 'project-1',
  projectName: 'proj',
  title: 'Sine plot',
  updatedAt: '2026-09-13T00:00:00.000Z',
  filePath: '/sessions/project-1/session-1.json',
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

describe('createGlobalSearchService', () => {
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
          timestamp: '2026-09-13T00:02:00.000Z'
        },
        {
          id: 'file-2',
          projectId: 'project-1',
          title: 'sin_notes.md',
          relativePath: 'data/sin_notes.md',
          textPreview: 'we measured sin(x) at ten points',
          timestamp: '2026-09-13T00:03:00.000Z'
        }
      ])
    })
    const response = await service.query(request({ scopes: ['files'] }))

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
