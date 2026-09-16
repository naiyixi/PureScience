// Global search contract: one query across sessions, message bodies, uploaded/generated files and the
// literature library.
//
// Two rules carry the honesty of a search result, and both live here rather than in a surface:
//   * "not found" must never be presented as "does not exist" — every response reports what it scanned,
//     the bounds it applied, and whether it stopped early;
//   * every hit carries provenance (which session, which message, which turn), so a result can be
//     audited instead of trusted, and a caller can jump to the evidence rather than to a snippet.
//
// Matching is deliberately literal (case-insensitive substring). No stemming, no fuzzy expansion, no
// model guessing: a hit either contains the query or it does not.

export const GLOBAL_SEARCH_SCHEMA_VERSION = 1

// Bounds. A search that stops early says so (`truncated`, `scan-bounded`) instead of returning a
// smaller result set that reads like a complete one.
export const GLOBAL_SEARCH_MAX_RESULTS_PER_SCOPE = 100
export const GLOBAL_SEARCH_MAX_MATCHES_PER_HIT = 5
export const GLOBAL_SEARCH_MAX_SCANNED_SESSIONS = 400
export const GLOBAL_SEARCH_MAX_MESSAGE_CHARS = 20_000
export const GLOBAL_SEARCH_SNIPPET_CHARS = 160
export const GLOBAL_SEARCH_MIN_QUERY_CHARS = 2

export type GlobalSearchScope = 'sessions' | 'messages' | 'files' | 'literature'

export const GLOBAL_SEARCH_SCOPES: readonly GlobalSearchScope[] = [
  'sessions',
  'messages',
  'files',
  'literature'
]

export type GlobalSearchRequest = {
  query: string
  // Undefined means every scope.
  scopes?: GlobalSearchScope[]
  // Undefined means every project.
  projectId?: string
  // Inclusive ISO-8601 bounds on the hit's own timestamp.
  since?: string
  until?: string
  // Per-scope cap; clamped to GLOBAL_SEARCH_MAX_RESULTS_PER_SCOPE. It is also the page size when a
  // cursor is supplied, so the two cannot disagree about how much was asked for.
  limitPerScope?: number
  // Who said it. Applies to message hits; the other scopes carry no sender.
  role?: 'user' | 'agent'
  // File formats, lowercase and without the dot. Applies to file hits.
  extensions?: string[]
  // Literature record types the caller will accept.
  referenceTypes?: ReferenceTypeFilter[]
  // Opaque cursor from a previous response. Absent starts at the first page.
  cursor?: string
}

export type ReferenceTypeFilter = 'doi' | 'arxiv' | 'pmid' | 'pmcid'

export type GlobalSearchMatch = {
  field: string
  snippet: string
  // Character offset of the match inside the searchable text (not inside the snippet).
  offset: number
  // Which term of the query matched, when the query carried more than one.
  term?: string
  // `literal` when the text contains the term as typed; `segmented` when a CJK term with no literal
  // occurrence was resolved by its parts. The distinction is what keeps "the phrase is in there" and
  // "the pieces are in there" from looking the same.
  matchKind?: 'literal' | 'segmented'
}

export type GlobalSearchCitation = {
  authors: string[]
  year?: number
  venue?: string
  doi?: string
  arxivId?: string
  pmid?: string
  pmcid?: string
}

export type GlobalSearchHit = {
  scope: GlobalSearchScope
  id: string
  projectId: string
  title: string
  score: number
  matches: GlobalSearchMatch[]
  // Provenance: enough to open the exact source, not just the containing document.
  sessionId?: string
  projectName?: string
  messageId?: string
  messageIndex?: number
  role?: 'user' | 'agent'
  timestamp?: string
  relativePath?: string
  // Present on literature hits: everything a GB/T 7714 citation needs, carried with the hit so a
  // citation is built from the record the search actually found rather than re-fetched later.
  citation?: GlobalSearchCitation
}

export type GlobalSearchScanReport = {
  sessions: number
  messages: number
  files: number
  references: number
  // True when a scan bound stopped the walk before the corpus was exhausted.
  bounded: boolean
}

export const GLOBAL_SEARCH_MAX_FILE_TEXT_BYTES = 256 * 1024

// Which files are worth reading during a search. A binary file read as text would produce matches that
// are not text at all, so anything not on this list is matched by name and path only.
const SEARCHABLE_TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'rst',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'log',
  'tex',
  'bib',
  'html',
  'htm',
  'xml',
  'css',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'r',
  'rmd',
  'qmd',
  'ipynb',
  'sh',
  'bash',
  'zsh',
  'sql',
  'c',
  'h',
  'cpp',
  'hpp',
  'java',
  'go',
  'rs',
  'rb',
  'php',
  'swift',
  'kt',
  'm',
  'jl'
])

export const isSearchableTextFile = (name: string): boolean => {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return false

  return SEARCHABLE_TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

export type GlobalSearchNote =
  | 'query-too-short'
  | 'scan-bounded-by-session-limit'
  | 'message-body-truncated'
  | 'results-truncated-per-scope'
  | 'no-project-scope'
  // Files are matched by name and path only: no file text is read during a search, and saying so keeps
  // "no hit" from reading as "the text is not in that file".
  | 'files-matched-by-name-and-path'
  // A content scan stopped at its budget: more files exist than were read, and the rest were matched by
  // name and path only.
  | 'file-content-scan-bounded'
  // The file listing itself stopped at its own bound: the project holds more files than were listed, so
  // a miss here does not mean the file is absent from the project.
  | 'file-list-bounded'
  // A cursor that could not be read: the search started from the beginning and says so, rather than
  // serving a first page as if it were a later one.
  | 'cursor-invalid'
  // A term with no literal occurrence was resolved by its parts (see collectTermMatches), so the hit is
  // real but the reader should know the phrase itself is not in the text.
  | 'matched-by-term-parts'

export type GlobalSearchResponse = {
  schemaVersion: typeof GLOBAL_SEARCH_SCHEMA_VERSION
  query: string
  scopes: GlobalSearchScope[]
  hits: GlobalSearchHit[]
  /** Present when more hits exist for at least one scope; hand it back to continue from here. */
  nextCursor?: string
  // Hits per scope after filtering, before the per-scope cap.
  counts: Record<GlobalSearchScope, number>
  truncated: boolean
  scan: GlobalSearchScanReport
  appliedLimit: number
  notes: GlobalSearchNote[]
}

export const normalizeSearchQuery = (query: string): string => query.trim()

export const resolveSearchScopes = (
  scopes: readonly GlobalSearchScope[] | undefined
): GlobalSearchScope[] => {
  if (!scopes || scopes.length === 0) return [...GLOBAL_SEARCH_SCOPES]

  return GLOBAL_SEARCH_SCOPES.filter((scope) => scopes.includes(scope))
}

// NFKC folds fullwidth forms and compatibility characters (so a fullwidth query finds its ASCII text
// and vice versa — a CJK-IME entry would otherwise miss silently); lowercasing plus the Greek
// final-sigma fold keeps 'Σ'/'ς'/'σ' searching as one letter.
export const normalizeSearchText = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u03c2/gu, '\u03c3')

// Maps folded-text indices back to the original text, grapheme by grapheme, for the rare case where
// normalization changed the length ('ﬁ' → 'fi', fullwidth → ASCII, combining accents). Without this the
// offsets would point into the folded string and every snippet would be shifted.
const graphemeIndexMap = (text: string): { starts: number[]; ends: number[] } => {
  const starts: number[] = []
  const ends: number[] = []
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

  for (const { segment, index } of segmenter.segment(text)) {
    const folded = normalizeSearchText(segment)
    for (let position = 0; position < folded.length; position += 1) {
      starts.push(index)
      ends.push(index + segment.length)
    }
  }

  return { starts, ends }
}

// Finds literal occurrences of the query and returns bounded snippets around each. Matching happens on
// NFKC-folded text; the offsets and snippets always refer to the ORIGINAL text. Overlapping matches are
// collapsed so one occurrence cannot inflate a hit's score.
export const collectMatches = ({
  text,
  query,
  field,
  maxMatches = GLOBAL_SEARCH_MAX_MATCHES_PER_HIT
}: {
  text: string
  query: string
  field: string
  maxMatches?: number
}): GlobalSearchMatch[] => {
  const needle = normalizeSearchText(query)
  if (needle.length === 0) return []

  const folded = normalizeSearchText(text)
  const unchanged = folded.length === text.length
  const map = unchanged ? undefined : graphemeIndexMap(text)

  const matches: GlobalSearchMatch[] = []
  let from = 0
  while (matches.length < maxMatches) {
    const index = folded.indexOf(needle, from)
    if (index === -1) break

    const end = index + needle.length
    const offset = map ? (map.starts[index] ?? 0) : index
    const matchLength = map ? (map.ends[end - 1] ?? offset) - offset : needle.length

    matches.push({ field, snippet: snippetAround(text, offset, matchLength), offset })
    from = end
  }

  return matches
}

// Terms a query is made of. Whitespace and the punctuation people actually type between keywords
// split them; nothing else does — so a CJK phrase with no separator stays one literal term rather than
// being guessed apart, which keeps every match explainable (it either contains the term or it does not).
const TERM_SEPARATOR = /[\s,，、;；/|]+/u

export const splitSearchTerms = (query: string): string[] =>
  normalizeSearchQuery(query)
    .split(TERM_SEPARATOR)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)

// Every term must appear for a document to match: a two-term query narrows, it never widens. Each
// returned match names the term that produced it and an empty result means one or more terms were
// missing — which is what makes "no hits" a statement about all the terms, not about the last one.
const CJK_ONLY = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+$/u

/**
 * A CJK term is written without spaces, so "the text contains this phrase" is the only rule literal
 * matching can apply — and it misses every paraphrase that shares its terms. These two-character parts
 * are the terms a Chinese reader would recognise inside the phrase; requiring all of them is what keeps
 * this conjunctive (narrowing, explainable) instead of a fuzzy guess.
 */
export const cjkPartsOf = (term: string): string[] => {
  if (term.length < 2 || !CJK_ONLY.test(term)) return []
  return Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2))
}

export const collectTermMatches = ({
  text,
  terms,
  field,
  maxMatchesPerTerm = GLOBAL_SEARCH_MAX_MATCHES_PER_HIT
}: {
  text: string
  terms: readonly string[]
  field: string
  maxMatchesPerTerm?: number
}): GlobalSearchMatch[] => {
  if (terms.length === 0) return []

  const collected: GlobalSearchMatch[] = []
  for (const term of terms) {
    const literal = collectMatches({ text, query: term, field, maxMatches: maxMatchesPerTerm })
    if (literal.length > 0) {
      collected.push(...literal.map((match) => ({ ...match, term, matchKind: 'literal' as const })))
      continue
    }

    // No literal occurrence: for a Chinese term, accept it when every one of its parts is present. Every
    // part must be there — a single shared two-character overlap is not a match.
    const parts = cjkPartsOf(term)
    if (parts.length === 0) return []
    const partMatches: GlobalSearchMatch[] = []
    for (const part of parts) {
      const matches = collectMatches({ text, query: part, field, maxMatches: 1 })
      if (matches.length === 0) return []
      partMatches.push(
        ...matches.map((match) => ({ ...match, term, matchKind: 'segmented' as const }))
      )
    }
    collected.push(...partMatches)
  }

  return collected.slice(0, GLOBAL_SEARCH_MAX_MATCHES_PER_HIT)
}

export const snippetAround = (
  text: string,
  offset: number,
  queryLength: number,
  width = GLOBAL_SEARCH_SNIPPET_CHARS
): string => {
  const padding = Math.max(0, Math.floor((width - queryLength) / 2))
  const start = Math.max(0, offset - padding)
  const end = Math.min(text.length, start + width)
  const slice = text.slice(start, end).replace(/\s+/gu, ' ').trim()

  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`
}

// How strongly a term matches a title, strongest first: the whole title is the term (3), the title
// starts with it (2), the title contains it somewhere (1), not at all (0). Deterministic and
// explainable — no hidden model score.
export type TitleMatchRank = 0 | 1 | 2 | 3

export const searchTitleRank = (title: string, terms: readonly string[]): TitleMatchRank => {
  const foldedTitle = normalizeSearchText(title).trim()
  if (foldedTitle.length === 0 || terms.length === 0) return 0

  let best: TitleMatchRank = 0
  for (const term of terms) {
    const foldedTerm = normalizeSearchText(term)
    if (foldedTerm.length === 0) continue

    const rank: TitleMatchRank =
      foldedTitle === foldedTerm
        ? 3
        : foldedTitle.startsWith(foldedTerm)
          ? 2
          : foldedTitle.includes(foldedTerm)
            ? 1
            : 0
    if (rank > best) best = rank
  }

  return best
}

// Ranking is deterministic and explainable: more matches rank higher, a closer title match outranks a
// farther one, and newer hits break ties. No hidden model score.
// A title that IS the term is worth four body matches; containing it is worth the old single point of
// credit, so today's ordering survives for the common case.
const TITLE_RANK_BONUS: Record<TitleMatchRank, number> = { 0: 0, 1: 4, 2: 6, 3: 8 }

export const scoreSearchHit = ({
  matches,
  titleRank,
  timestamp
}: {
  matches: number
  titleRank: TitleMatchRank
  timestamp?: string
}): number => {
  const matchScore = Math.min(matches, GLOBAL_SEARCH_MAX_MATCHES_PER_HIT) * 2
  const titleBonus = TITLE_RANK_BONUS[titleRank]
  const recency = timestamp ? Math.min(Date.parse(timestamp) / 1e13, 1) : 0

  return matchScore + titleBonus + recency
}

export const searchHitsInTimestampRange = (
  timestamp: string | undefined,
  { since, until }: { since?: string; until?: string }
): boolean => {
  if (!since && !until) return true
  if (!timestamp) return false

  const value = Date.parse(timestamp)
  if (Number.isNaN(value)) return false
  if (since && value < Date.parse(since)) return false
  if (until && value > Date.parse(until)) return false

  return true
}

export const clampSearchLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) return GLOBAL_SEARCH_MAX_RESULTS_PER_SCOPE

  return Math.max(1, Math.min(Math.floor(limit), GLOBAL_SEARCH_MAX_RESULTS_PER_SCOPE))
}

const SEARCH_CURSOR_PREFIX = 'v1'

/** Where each scope had got to. Compact and opaque: a caller holds it, never builds it. */
export const encodeSearchCursor = (offsets: Partial<Record<GlobalSearchScope, number>>): string =>
  `${SEARCH_CURSOR_PREFIX}:${GLOBAL_SEARCH_SCOPES.filter((scope) => (offsets[scope] ?? 0) > 0)
    .map((scope) => `${scope}=${offsets[scope]}`)
    .join(',')}`

/** An unreadable cursor restarts at the first page and says so, rather than serving page one as page two. */
export const decodeSearchCursor = (
  cursor: string | undefined
): { offsets: Record<GlobalSearchScope, number>; invalid: boolean } => {
  const zero = { sessions: 0, messages: 0, files: 0, literature: 0 } as Record<
    GlobalSearchScope,
    number
  >
  if (!cursor) return { offsets: zero, invalid: false }

  const separator = cursor.indexOf(':')
  if (separator === -1 || cursor.slice(0, separator) !== SEARCH_CURSOR_PREFIX) {
    return { offsets: zero, invalid: true }
  }
  const offsets = { ...zero }
  const body = cursor.slice(separator + 1)
  for (const part of body.split(',').filter((candidate) => candidate.length > 0)) {
    const [scope, value] = part.split('=')
    if (!GLOBAL_SEARCH_SCOPES.includes(scope as GlobalSearchScope)) {
      return { offsets: zero, invalid: true }
    }
    const parsed = Number.parseInt(value ?? '', 10)
    if (!Number.isFinite(parsed) || parsed < 0) return { offsets: zero, invalid: true }
    offsets[scope as GlobalSearchScope] = parsed
  }
  return { offsets, invalid: false }
}

export type GlobalSearchHitFilters = {
  role?: 'user' | 'agent'
  extensions?: readonly string[]
  referenceTypes?: readonly ReferenceTypeFilter[]
}

const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf('.')
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return dot > slash + 1 ? path.slice(dot + 1).toLowerCase() : ''
}

const referenceTypesOf = (hit: GlobalSearchHit): ReferenceTypeFilter[] => {
  const citation = hit.citation
  if (!citation) return []
  const types: ReferenceTypeFilter[] = []
  if (citation.doi) types.push('doi')
  if (citation.arxivId) types.push('arxiv')
  if (citation.pmid) types.push('pmid')
  if (citation.pmcid) types.push('pmcid')
  return types
}

/**
 * Filters are applied before anything is counted or paged. A count that included hits the caller asked
 * not to see would be a count of something else, and a page of eight would arrive with two of them
 * removed — which is how "no more results" ends up being wrong.
 *
 * A filter that names a property only one scope has (a sender, a format, a record type) also drops the
 * scopes that cannot have it: asking for one person's messages is not a request for the file list.
 */
export const searchHitMatchesFilters = (
  hit: GlobalSearchHit,
  filters: GlobalSearchHitFilters
): boolean => {
  if (filters.role) {
    if (hit.scope !== 'messages') return false
    if (hit.role !== filters.role) return false
  }
  if (filters.extensions?.length) {
    if (hit.scope !== 'files') return false
    const extension = extensionOf(hit.relativePath ?? hit.title)
    if (
      !filters.extensions.map((value) => value.toLowerCase().replace(/^\./, '')).includes(extension)
    ) {
      return false
    }
  }
  if (filters.referenceTypes?.length) {
    if (hit.scope !== 'literature') return false
    const types = referenceTypesOf(hit)
    if (!types.some((type) => filters.referenceTypes!.includes(type))) return false
  }
  return true
}

// Sorts every scope together, then serves each scope its page and reports whether anything was left,
// so a caller never mistakes a capped list for the whole corpus and never loses the rest of it either.
export const finalizeSearchResponse = ({
  query,
  scopes,
  hits,
  scan,
  appliedLimit,
  notes,
  cursor,
  filters
}: {
  query: string
  scopes: GlobalSearchScope[]
  hits: GlobalSearchHit[]
  scan: GlobalSearchScanReport
  appliedLimit: number
  notes: GlobalSearchNote[]
  cursor?: string
  filters?: GlobalSearchHitFilters
}): GlobalSearchResponse => {
  const { offsets, invalid } = decodeSearchCursor(cursor)
  const filtered = filters ? hits.filter((hit) => searchHitMatchesFilters(hit, filters)) : hits

  const counts = GLOBAL_SEARCH_SCOPES.reduce(
    (accumulator, scope) => {
      accumulator[scope] = filtered.filter((hit) => hit.scope === scope).length

      return accumulator
    },
    { sessions: 0, messages: 0, files: 0, literature: 0 } as Record<GlobalSearchScope, number>
  )

  const sorted = [...filtered].sort(
    (left, right) => right.score - left.score || left.id.localeCompare(right.id)
  )
  const seenPerScope = new Map<GlobalSearchScope, number>()
  const servedPerScope = new Map<GlobalSearchScope, number>()
  const page: GlobalSearchHit[] = []
  let moreBeyondPage = false

  for (const hit of sorted) {
    const seen = (seenPerScope.get(hit.scope) ?? 0) + 1
    seenPerScope.set(hit.scope, seen)
    if (seen <= (offsets[hit.scope] ?? 0)) continue

    const served = (servedPerScope.get(hit.scope) ?? 0) + 1
    if (served > appliedLimit) {
      moreBeyondPage = true
      continue
    }
    servedPerScope.set(hit.scope, served)
    page.push(hit)
  }

  const nextCursor = moreBeyondPage
    ? encodeSearchCursor(
        GLOBAL_SEARCH_SCOPES.reduce<Partial<Record<GlobalSearchScope, number>>>(
          (accumulator, scope) => {
            const total = (offsets[scope] ?? 0) + (servedPerScope.get(scope) ?? 0)
            if (total > 0) accumulator[scope] = total
            return accumulator
          },
          {}
        )
      )
    : undefined

  const nextNotes: GlobalSearchNote[] = [...notes]
  if (invalid) nextNotes.push('cursor-invalid')
  if (moreBeyondPage) nextNotes.push('results-truncated-per-scope')
  if (filtered.some((hit) => hit.matches.some((match) => match.matchKind === 'segmented'))) {
    nextNotes.push('matched-by-term-parts')
  }

  return {
    schemaVersion: GLOBAL_SEARCH_SCHEMA_VERSION,
    query,
    scopes,
    hits: page,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    counts,
    // "There is more than this page shows" — the one thing a reader must not have to infer.
    truncated: moreBeyondPage,
    scan,
    appliedLimit,
    notes: [...new Set(nextNotes)]
  }
}
