import {
  clampSearchLimit,
  collectTermMatches,
  splitSearchTerms,
  finalizeSearchResponse,
  GLOBAL_SEARCH_MAX_MESSAGE_CHARS,
  GLOBAL_SEARCH_MAX_SCANNED_SESSIONS,
  GLOBAL_SEARCH_MIN_QUERY_CHARS,
  normalizeSearchQuery,
  resolveSearchScopes,
  scoreSearchHit,
  searchHitsInTimestampRange,
  type GlobalSearchHit,
  type GlobalSearchNote,
  type GlobalSearchRequest,
  type GlobalSearchResponse,
  type GlobalSearchScanReport,
  type GlobalSearchScope
} from '../../shared/global-search'

// Main-process global search.
//
// The corpus is the persisted session files, the project file index and the literature library. Nothing
// is indexed in the background yet, so the scan is explicitly bounded and the response says what it
// looked at: a per-scope cap, a session cap, and notes for anything that was cut. A caller must never be
// able to read "no hits" as "this does not exist anywhere in your work".

export type SearchableSessionMessage = {
  id: string
  role: 'user' | 'agent'
  timestamp?: string
  text: string
  // True when the persisted text was longer than the searchable budget.
  truncated?: boolean
}

export type SearchableSession = {
  sessionId: string
  projectId: string
  projectName?: string
  title: string
  updatedAt: string
}

export type SearchableFile = {
  id: string
  projectId: string
  title: string
  relativePath: string
  timestamp?: string
  // Optional text preview when the index already carries one; never a second full read of the file.
  textPreview?: string
}

export type SearchableReference = {
  id: string
  projectId: string
  title: string
  timestamp?: string
  abstract?: string
  authors?: string[]
  venue?: string
  doi?: string
  year?: number
  arxivId?: string
  pmid?: string
  pmcid?: string
}

export type GlobalSearchPorts = {
  listSessions(): Promise<SearchableSession[]>
  // Keyed by session id: the real implementation already holds the loaded sessions, so the search never
  // re-reads a session file that startup just parsed.
  readSessionMessages(sessionId: string): Promise<SearchableSessionMessage[]>
  listFiles(projectId?: string): Promise<SearchableFile[]>
  listReferences(projectId?: string): Promise<SearchableReference[]>
}

export type GlobalSearchService = {
  query(request: GlobalSearchRequest): Promise<GlobalSearchResponse>
}

const emptyScan = (): GlobalSearchScanReport => ({
  sessions: 0,
  messages: 0,
  files: 0,
  references: 0,
  bounded: false
})

export const createGlobalSearchService = (ports: GlobalSearchPorts): GlobalSearchService => ({
  async query(request) {
    const query = normalizeSearchQuery(request.query)
    const scopes = resolveSearchScopes(request.scopes)
    const appliedLimit = clampSearchLimit(request.limitPerScope)
    const scan = emptyScan()
    const notes: GlobalSearchNote[] = []
    const hits: GlobalSearchHit[] = []
    const range = {
      ...(request.since ? { since: request.since } : {}),
      ...(request.until ? { until: request.until } : {})
    }
    // A multi-term query requires every term: terms narrow a search, they never widen it.
    const terms = splitSearchTerms(query)

    // Too short to search is reported as such: an empty list with no explanation is the failure mode
    // this contract exists to prevent.
    if (query.length < GLOBAL_SEARCH_MIN_QUERY_CHARS) {
      return finalizeSearchResponse({
        query,
        scopes,
        hits: [],
        scan,
        appliedLimit,
        notes: ['query-too-short']
      })
    }

    const inProject = (projectId: string): boolean =>
      request.projectId === undefined || request.projectId === projectId

    if (scopes.includes('sessions') || scopes.includes('messages')) {
      const all = await ports.listSessions()
      const scoped = all.filter((session) => inProject(session.projectId))
      scan.sessions = Math.min(scoped.length, GLOBAL_SEARCH_MAX_SCANNED_SESSIONS)
      if (scoped.length > GLOBAL_SEARCH_MAX_SCANNED_SESSIONS) {
        scan.bounded = true
        notes.push('scan-bounded-by-session-limit')
      }

      for (const session of scoped.slice(0, GLOBAL_SEARCH_MAX_SCANNED_SESSIONS)) {
        if (scopes.includes('sessions') && searchHitsInTimestampRange(session.updatedAt, range)) {
          const matches = collectTermMatches({ text: session.title, terms, field: 'title' })
          if (matches.length > 0) {
            hits.push({
              scope: 'sessions',
              id: session.sessionId,
              projectId: session.projectId,
              title: session.title,
              score: scoreSearchHit({
                matches: matches.length,
                titleMatched: true,
                timestamp: session.updatedAt
              }),
              matches,
              sessionId: session.sessionId,
              ...(session.projectName ? { projectName: session.projectName } : {}),
              timestamp: session.updatedAt
            })
          }
        }

        if (!scopes.includes('messages')) continue

        const messages = await ports.readSessionMessages(session.sessionId)
        for (const [index, message] of messages.entries()) {
          scan.messages += 1
          const text = message.text.slice(0, GLOBAL_SEARCH_MAX_MESSAGE_CHARS)
          if (message.truncated || text.length < message.text.length) {
            if (!notes.includes('message-body-truncated')) notes.push('message-body-truncated')
          }
          if (!searchHitsInTimestampRange(message.timestamp ?? session.updatedAt, range)) continue

          const matches = collectTermMatches({ text, terms, field: 'body' })
          if (matches.length === 0) continue

          hits.push({
            scope: 'messages',
            id: message.id,
            projectId: session.projectId,
            title: session.title,
            score: scoreSearchHit({
              matches: matches.length,
              titleMatched: false,
              timestamp: message.timestamp ?? session.updatedAt
            }),
            matches,
            sessionId: session.sessionId,
            ...(session.projectName ? { projectName: session.projectName } : {}),
            messageIndex: index,
            role: message.role,
            timestamp: message.timestamp ?? session.updatedAt
          })
        }
      }
    }

    if (scopes.includes('files')) {
      const files = await ports.listFiles(request.projectId)
      for (const file of files.filter((entry) => inProject(entry.projectId))) {
        scan.files += 1
        if (!searchHitsInTimestampRange(file.timestamp, range)) continue

        const nameMatches = [
          ...collectTermMatches({ text: file.title, terms, field: 'name' }),
          ...collectTermMatches({ text: file.relativePath, terms, field: 'path' })
        ]
        const previewMatches = file.textPreview
          ? collectTermMatches({
              text: file.textPreview.slice(0, GLOBAL_SEARCH_MAX_MESSAGE_CHARS),
              terms,
              field: 'content'
            })
          : []
        if (nameMatches.length === 0 && previewMatches.length === 0) continue

        hits.push({
          scope: 'files',
          id: file.id,
          projectId: file.projectId,
          title: file.title,
          score: scoreSearchHit({
            matches: nameMatches.length + previewMatches.length,
            titleMatched: nameMatches.length > 0,
            timestamp: file.timestamp
          }),
          matches: [...nameMatches, ...previewMatches],
          relativePath: file.relativePath,
          ...(file.timestamp ? { timestamp: file.timestamp } : {})
        })
      }
    }

    if (scopes.includes('literature')) {
      const references = await ports.listReferences(request.projectId)
      for (const reference of references.filter((entry) => inProject(entry.projectId))) {
        scan.references += 1
        if (!searchHitsInTimestampRange(reference.timestamp, range)) continue

        const titleMatches = collectTermMatches({ text: reference.title, terms, field: 'title' })
        const abstractMatches = reference.abstract
          ? collectTermMatches({
              text: reference.abstract.slice(0, GLOBAL_SEARCH_MAX_MESSAGE_CHARS),
              terms,
              field: 'abstract'
            })
          : []
        const authorMatches = reference.authors
          ? reference.authors.flatMap((author) =>
              collectTermMatches({ text: author, terms, field: 'authors' })
            )
          : []
        const doiMatches = reference.doi
          ? collectTermMatches({ text: reference.doi, terms, field: 'doi' })
          : []
        const matches = [...titleMatches, ...abstractMatches, ...authorMatches, ...doiMatches]
        if (matches.length === 0) continue

        hits.push({
          scope: 'literature',
          id: reference.id,
          projectId: reference.projectId,
          title: reference.title,
          score: scoreSearchHit({
            matches: matches.length,
            titleMatched: titleMatches.length > 0,
            timestamp: reference.timestamp
          }),
          matches,
          ...(reference.venue ? { projectName: reference.venue } : {}),
          ...(reference.timestamp ? { timestamp: reference.timestamp } : {}),
          // Carried with the hit so a citation is built from what was found, never re-fetched.
          citation: {
            authors: reference.authors ?? [],
            ...(reference.year !== undefined ? { year: reference.year } : {}),
            ...(reference.venue ? { venue: reference.venue } : {}),
            ...(reference.doi ? { doi: reference.doi } : {}),
            ...(reference.arxivId ? { arxivId: reference.arxivId } : {}),
            ...(reference.pmid ? { pmid: reference.pmid } : {}),
            ...(reference.pmcid ? { pmcid: reference.pmcid } : {})
          }
        })
      }
    }

    return finalizeSearchResponse({ query, scopes, hits, scan, appliedLimit, notes })
  }
})

export type { GlobalSearchScope }
