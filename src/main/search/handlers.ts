import type {
  GlobalSearchRequest,
  GlobalSearchResponse,
  GlobalSearchScope
} from '../../shared/global-search'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { SearchEvidenceRequest, SearchEvidenceResponse } from '../../shared/search-evidence'
import {
  createGlobalSearchService,
  type SearchableFile,
  type SearchableReference,
  type SearchableSession,
  type SearchableSessionMessage
} from './global-search-service'
import { createSearchEvidenceService } from './search-evidence'

// Wiring for the global search command: the search service itself is pure plan/matching logic, and these
// ports are the only place that touches the app's own stores.

export type SearchHandlerPorts = {
  // Every persisted session with its messages, as the startup path already loaded them. Bounded by the
  // caller (session scan limit), never re-read per query file by file.
  loadSessions(): Promise<PersistedChatSession[]>
  listFiles(request: {
    projectId: string
  }): Promise<Array<{ id: string; title: string; relativePath: string; timestamp?: string }>>
  listReferences(projectId: string): Promise<
    Array<{
      id: string
      title: string
      abstract?: string
      authors?: string[]
      venue?: string
      doi?: string
      year?: number
      arxivId?: string
      pmid?: string
      pmcid?: string
      createdAt?: string
    }>
  >
}

export type SearchHandlers = {
  query(request: GlobalSearchRequest): Promise<GlobalSearchResponse>
  evidence(request: SearchEvidenceRequest): Promise<SearchEvidenceResponse>
}

// Persisted sessions carry epoch-millisecond timestamps; the search contract speaks ISO-8601.
const toIso = (value: number | undefined): string | undefined => {
  if (value === undefined || !Number.isFinite(value)) return undefined

  return new Date(value).toISOString()
}

const toSearchableSession = (session: PersistedChatSession): SearchableSession => {
  const updatedAt = toIso(session.updatedAt ?? session.createdAt)

  return {
    sessionId: session.id,
    projectId: session.projectId,
    title: session.title ?? session.id,
    updatedAt: updatedAt ?? new Date(0).toISOString()
  }
}

// A persisted message has no timestamp of its own: it is dated by its session, which is what a caller
// implicitly assumes when filtering by date. The fallback is deliberate, not an accident.
export const toSearchableMessages = (session: PersistedChatSession): SearchableSessionMessage[] => {
  const timestamp = toIso(session.updatedAt ?? session.createdAt)

  return (session.messages ?? []).map((message) => ({
    id: message.id,
    role: message.role === 'user' ? 'user' : 'agent',
    text: message.content ?? '',
    ...(timestamp ? { timestamp } : {})
  }))
}

export const createSearchHandlers = (ports: SearchHandlerPorts): SearchHandlers => ({
  async query(request) {
    const sessions = await ports.loadSessions()
    const messagesBySession = new Map(
      sessions.map((session) => [session.id, toSearchableMessages(session)] as const)
    )
    // Files and literature live per project; without a project the response says so through its notes
    // rather than quietly returning nothing.
    const projectId = request.projectId
    const scopes: GlobalSearchScope[] = request.scopes ?? [
      'sessions',
      'messages',
      'files',
      'literature'
    ]
    const files: SearchableFile[] =
      projectId && scopes.includes('files')
        ? (await ports.listFiles({ projectId })).map((file) => ({
            id: file.id,
            projectId,
            title: file.title,
            relativePath: file.relativePath,
            ...(file.timestamp ? { timestamp: file.timestamp } : {})
          }))
        : []
    const references: SearchableReference[] =
      projectId && scopes.includes('literature')
        ? (await ports.listReferences(projectId)).map((reference) => ({
            id: reference.id,
            projectId,
            title: reference.title,
            ...(reference.abstract ? { abstract: reference.abstract } : {}),
            ...(reference.authors ? { authors: reference.authors } : {}),
            ...(reference.venue ? { venue: reference.venue } : {}),
            ...(reference.doi ? { doi: reference.doi } : {}),
            ...(reference.year !== undefined ? { year: reference.year } : {}),
            ...(reference.arxivId ? { arxivId: reference.arxivId } : {}),
            ...(reference.pmid ? { pmid: reference.pmid } : {}),
            ...(reference.pmcid ? { pmcid: reference.pmcid } : {}),
            ...(reference.createdAt ? { timestamp: reference.createdAt } : {})
          }))
        : []

    const service = createGlobalSearchService({
      listSessions: async () => sessions.map(toSearchableSession),
      readSessionMessages: async (sessionId) => messagesBySession.get(sessionId) ?? [],
      listFiles: async () => files,
      listReferences: async () => references
    })
    const response = await service.query(request)

    // A project-less query cannot reach files or literature; say it instead of implying they were
    // searched and came back empty.
    const needsProject = !projectId && (scopes.includes('files') || scopes.includes('literature'))
    return needsProject
      ? { ...response, notes: [...new Set([...response.notes, 'no-project-scope' as const])] }
      : response
  },

  async evidence(request) {
    // The evidence service reads the block from the same loaded sessions the search reads, so a
    // fingerprint always describes what is stored right now rather than a stale search-side copy.
    const sessions = await ports.loadSessions()
    const messagesBySession = new Map(
      sessions.map((session) => [session.id, toSearchableMessages(session)] as const)
    )
    const service = createSearchEvidenceService({
      readSessionMessages: async (sessionId) => messagesBySession.get(sessionId) ?? []
    })

    return service.handle(request)
  }
})
