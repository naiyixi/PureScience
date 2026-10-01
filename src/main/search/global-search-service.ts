import {
  clampSearchLimit,
  collectTermMatches,
  splitSearchTerms,
  finalizeSearchResponse,
  GLOBAL_SEARCH_SCOPES,
  isFileSearchScope,
  searchTitleRank,
  GLOBAL_SEARCH_MAX_MESSAGE_CHARS,
  GLOBAL_SEARCH_MAX_SCANNED_SESSIONS,
  GLOBAL_SEARCH_MIN_QUERY_CHARS,
  isGlobalSearchOrdering,
  normalizeSearchQuery,
  resolveSearchScopes,
  scoreSearchHit,
  searchHitsInTimestampRange,
  GLOBAL_SEARCH_MAX_SCANNED_ANNOTATIONS,
  type GlobalSearchHit,
  type GlobalSearchHitFilters,
  type GlobalSearchNote,
  type GlobalSearchRequest,
  type GlobalSearchResponse,
  type GlobalSearchScanReport,
  type GlobalSearchScope,
  type GlobalSearchScopeCoverage
} from '../../shared/global-search'
import type { PdfAnnotationKind } from '../../shared/pdf-annotations'

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
  // Which corpus this file belongs to. The two file scopes search different origins, so the port has to
  // say which one a file came from: guessing from a path would turn "generated" into "uploaded" the day
  // a workspace folder is renamed.
  source: 'artifact' | 'upload'
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

/**
 * One stored annotation, as the search sees it.
 *
 * The two texts are the ones the STORE already holds (A1's `body` and the `quote` inside the selector),
 * handed over as-is. Nothing here reads a PDF: the corpus for this scope is text that was already
 * persisted when the annotation was written or imported, which is what lets a search answer without a
 * parser and without a file. `fileName` is the owning file's display name, supplied by the caller that
 * listed the project's files, so a hit can name where the markup lives without the search opening it.
 */
export type SearchableAnnotation = {
  id: string
  projectId: string
  sourceFileId: string
  versionId: string
  checksum: string
  kind: PdfAnnotationKind
  body: string
  quote: string
  page?: number
  fileName: string
  createdAt: number
  timestamp?: string
}

export type GlobalSearchPorts = {
  listSessions(): Promise<SearchableSession[]>
  // Keyed by session id: the real implementation already holds the loaded sessions, so the search never
  // re-reads a session file that startup just parsed.
  readSessionMessages(sessionId: string): Promise<SearchableSessionMessage[]>
  listFiles(projectId?: string): Promise<SearchableFile[]>
  listReferences(projectId?: string): Promise<SearchableReference[]>
  // Optional: without it the annotation scope is empty and the response says the corpus was empty
  // (`annotations-empty`) rather than leaving the reader to conclude the markup does not exist.
  listAnnotations?(projectId?: string): Promise<SearchableAnnotation[]>
}

export type GlobalSearchService = {
  query(request: GlobalSearchRequest): Promise<GlobalSearchResponse>
}

const emptyScan = (): GlobalSearchScanReport => ({
  sessions: 0,
  messages: 0,
  uploads: 0,
  artifacts: 0,
  references: 0,
  annotations: 0,
  bounded: false
})

const emptyCoverage = (): Record<GlobalSearchScope, GlobalSearchScopeCoverage> =>
  GLOBAL_SEARCH_SCOPES.reduce(
    (accumulator, scope) => {
      accumulator[scope] = { considered: 0, contentRead: 0, bounded: false }
      return accumulator
    },
    {} as Record<GlobalSearchScope, GlobalSearchScopeCoverage>
  )

/**
 * Counts matches for ranking, weighting the two kinds differently. A text that contains the phrase the
 * reader typed is a stronger answer than one that merely contains all of its parts — without this, a
 * parts-based match scores higher (every part matches) and a phrase hit sinks below a paraphrase.
 */
const LITERAL_WEIGHT = 1
const SEGMENTED_WEIGHT = 0.5

export const weightedMatchCount = (
  matches: readonly { term?: string; matchKind?: 'literal' | 'segmented' }[]
): number => {
  // One credit per term, at the strength of its best kind. Counting occurrences instead would let a
  // paraphrase win: a term resolved by three parts matches three times, and the phrase it stands in for
  // matches once.
  const bestKindPerTerm = new Map<string, 'literal' | 'segmented'>()
  matches.forEach((match, index) => {
    const key = match.term ?? `#${index}`
    const kind = match.matchKind ?? 'literal'
    if (kind === 'literal' || !bestKindPerTerm.has(key)) bestKindPerTerm.set(key, kind)
  })

  return [...bestKindPerTerm.values()].reduce(
    (total, kind) => total + (kind === 'segmented' ? SEGMENTED_WEIGHT : LITERAL_WEIGHT),
    0
  )
}

const hitFiltersOf = (request: GlobalSearchRequest): GlobalSearchHitFilters | undefined => {
  const { role, extensions, referenceTypes } = request
  if (!role && !extensions?.length && !referenceTypes?.length) return undefined
  return {
    ...(role ? { role } : {}),
    ...(extensions?.length ? { extensions } : {}),
    ...(referenceTypes?.length ? { referenceTypes } : {})
  }
}

export const createGlobalSearchService = (ports: GlobalSearchPorts): GlobalSearchService => ({
  async query(request) {
    const query = normalizeSearchQuery(request.query)
    const scopes = resolveSearchScopes(request.scopes)
    // An unknown ordering is not guessed at: it falls back to the documented default, and the response
    // reports which order the page is actually in.
    const orderBy = isGlobalSearchOrdering(request.orderBy) ? request.orderBy : undefined
    const appliedLimit = clampSearchLimit(request.limitPerScope)
    const scan = emptyScan()
    const coverage = emptyCoverage()
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
        orderBy,
        scopes,
        hits: [],
        scan,
        coverage: emptyCoverage(),
        appliedLimit,
        notes: ['query-too-short'],
        // The cursor and the filters are still read, so the response can say a cursor was unreadable even
        // when the query itself was too short to run.
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        filters: hitFiltersOf(request)
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
                matches: weightedMatchCount(matches),
                titleRank: searchTitleRank(session.title, terms),
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
              matches: weightedMatchCount(matches),
              // A message hit is scored on the body; the session title is context, not the match.
              titleRank: 0,
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

    const fileScopesRequested = new Set<GlobalSearchScope>(scopes.filter(isFileSearchScope))
    if (fileScopesRequested.size > 0) {
      const files = await ports.listFiles(request.projectId)
      // Whether any file of a given origin carried searchable text. When none does, that scope's hits are
      // name-and-path matches only, and the response says so instead of letting "no hit" read as "that
      // text is not there".
      const sawTextByScope = new Map<GlobalSearchScope, boolean>()
      const originScope = (file: SearchableFile): GlobalSearchScope =>
        file.source === 'upload' ? 'uploads' : 'artifacts'
      for (const file of files.filter((entry) => inProject(entry.projectId))) {
        const scope = originScope(file)
        // A file whose origin was not requested is not part of this search at all: it is neither a hit
        // nor something this response covered, so it is left out of both.
        if (!fileScopesRequested.has(scope)) continue
        if (scope === 'uploads') scan.uploads += 1
        else scan.artifacts += 1
        coverage[scope].considered += 1
        if (file.textPreview) coverage[scope].contentRead += 1
        if (!searchHitsInTimestampRange(file.timestamp, range)) continue

        if (file.textPreview) sawTextByScope.set(scope, true)
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
          scope,
          id: file.id,
          projectId: file.projectId,
          title: file.title,
          score: scoreSearchHit({
            matches: nameMatches.length + previewMatches.length,
            titleRank: searchTitleRank(file.title, terms),
            timestamp: file.timestamp
          }),
          matches: [...nameMatches, ...previewMatches],
          relativePath: file.relativePath,
          ...(file.timestamp ? { timestamp: file.timestamp } : {})
        })
      }

      // Self-healing honesty, now per origin: it appears only for a scope that was searched, had items,
      // and produced no content match at all — so "nothing in the generated files" and "nothing in your
      // uploads" are never conflated.
      for (const scope of fileScopesRequested) {
        if (coverage[scope].considered > 0 && !sawTextByScope.get(scope)) {
          notes.push('files-matched-by-name-and-path')
        }
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
            titleRank: searchTitleRank(reference.title, terms),
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

    // The annotation scope. Its corpus is the two texts the annotation store already holds — the
    // annotation's own body and the passage its selector quotes — and nothing else: no PDF is opened, no
    // page is parsed, and no text is extracted here. `GLOBAL_SEARCH_ANNOTATION_INDEXED_FIELDS` names
    // exactly which fields those are, so "what is in the index" is a fact a caller can read rather than
    // infer from a hit happening to appear.
    if (scopes.includes('annotations')) {
      const listAnnotations = ports.listAnnotations
      const all = listAnnotations ? await listAnnotations(request.projectId) : []
      const scoped = all.filter((annotation) => inProject(annotation.projectId))
      scan.annotations = Math.min(scoped.length, GLOBAL_SEARCH_MAX_SCANNED_ANNOTATIONS)
      if (scoped.length > GLOBAL_SEARCH_MAX_SCANNED_ANNOTATIONS) notes.push('annotations-bounded')
      // An empty corpus is stated, not left to read as "the phrase is not in your markup".
      if (listAnnotations && scoped.length === 0) notes.push('annotations-empty')

      for (const annotation of scoped.slice(0, GLOBAL_SEARCH_MAX_SCANNED_ANNOTATIONS)) {
        if (!searchHitsInTimestampRange(annotation.timestamp, range)) continue

        // Both stored texts are searched, and each match names the field it came from, so "the note says
        // this" and "the highlighted passage says this" are distinguishable in the result.
        const matches = [
          ...(annotation.body
            ? collectTermMatches({ text: annotation.body, terms, field: 'body' })
            : []),
          ...(annotation.quote
            ? collectTermMatches({ text: annotation.quote, terms, field: 'quote' })
            : [])
        ]
        if (matches.length === 0) continue

        hits.push({
          scope: 'annotations',
          id: annotation.id,
          projectId: annotation.projectId,
          // The file the markup is on is what a reader recognises; the annotation's own text is in the
          // matches, so the title does not double-count it (see weightedMatchCount).
          title: annotation.fileName,
          score: scoreSearchHit({
            matches: weightedMatchCount(matches),
            titleRank: searchTitleRank(annotation.fileName, terms),
            timestamp: annotation.timestamp
          }),
          matches,
          ...(annotation.timestamp ? { timestamp: annotation.timestamp } : {}),
          // Carried with the hit so a citation is built from the anchor the store holds.
          annotation: {
            annotationId: annotation.id,
            sourceFileId: annotation.sourceFileId,
            versionId: annotation.versionId,
            checksum: annotation.checksum,
            kind: annotation.kind,
            ...(annotation.page === undefined ? {} : { page: annotation.page }),
            ...(annotation.quote ? { quote: annotation.quote } : {})
          }
        })
      }
    }

    // Classes without a bound of their own take the walk-level flag: a session cap that cut the walk
    // short is also what makes the message corpus a slice.
    coverage.sessions.considered = scan.sessions
    coverage.sessions.bounded = scan.bounded
    coverage.messages.considered = scan.messages
    coverage.literature.considered = scan.references
    coverage.annotations.considered = scan.annotations

    return finalizeSearchResponse({
      query,
      orderBy,
      scopes,
      hits,
      scan,
      coverage,
      appliedLimit,
      notes,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      filters: hitFiltersOf(request)
    })
  }
})

export type { GlobalSearchScope }
