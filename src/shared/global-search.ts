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
  // Per-scope cap; clamped to GLOBAL_SEARCH_MAX_RESULTS_PER_SCOPE.
  limitPerScope?: number
}

export type GlobalSearchMatch = {
  field: string
  snippet: string
  // Character offset of the match inside the searchable text (not inside the snippet).
  offset: number
  // Which term of the query matched, when the query carried more than one.
  term?: string
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

export type GlobalSearchResponse = {
  schemaVersion: typeof GLOBAL_SEARCH_SCHEMA_VERSION
  query: string
  scopes: GlobalSearchScope[]
  hits: GlobalSearchHit[]
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
    const matches = collectMatches({ text, query: term, field, maxMatches: maxMatchesPerTerm })
    if (matches.length === 0) return []

    collected.push(...matches.map((match) => ({ ...match, term })))
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

// Sorts every scope together, then trims each scope to the applied limit and reports whether anything
// was dropped, so a caller never mistakes a capped list for the whole corpus.
export const finalizeSearchResponse = ({
  query,
  scopes,
  hits,
  scan,
  appliedLimit,
  notes
}: {
  query: string
  scopes: GlobalSearchScope[]
  hits: GlobalSearchHit[]
  scan: GlobalSearchScanReport
  appliedLimit: number
  notes: GlobalSearchNote[]
}): GlobalSearchResponse => {
  const counts = GLOBAL_SEARCH_SCOPES.reduce(
    (accumulator, scope) => {
      accumulator[scope] = hits.filter((hit) => hit.scope === scope).length

      return accumulator
    },
    { sessions: 0, messages: 0, files: 0, literature: 0 } as Record<GlobalSearchScope, number>
  )

  const sorted = [...hits].sort(
    (left, right) => right.score - left.score || left.id.localeCompare(right.id)
  )
  const perScope = new Map<GlobalSearchScope, number>()
  const limited = sorted.filter((hit) => {
    const seen = (perScope.get(hit.scope) ?? 0) + 1
    perScope.set(hit.scope, seen)

    return seen <= appliedLimit
  })
  const truncated = limited.length < sorted.length

  return {
    schemaVersion: GLOBAL_SEARCH_SCHEMA_VERSION,
    query,
    scopes,
    hits: limited,
    counts,
    truncated,
    scan,
    appliedLimit,
    notes: truncated ? [...new Set([...notes, 'results-truncated-per-scope' as const])] : notes
  }
}
