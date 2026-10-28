// Citation discovery against OpenAlex (B2): the two directions a reader can walk from a record.
//
// Measured on 2026-10-29 (no key needed, public API):
//   * `GET /works/doi:{doi}` returns the record itself — no `message` wrapper, unlike Crossref.
//   * `GET /works?filter=cites:{id}&per-page=N&page=P` — the works citing it, `meta.count` = the real
//     total. A highly cited paper has 83,700 of them, so a walk MUST be bounded: this module reads at
//     most two pages of 25 and says how many it read.
//   * `GET /works?filter=openalex_id:W1|W2|…` — resolves `referenced_works` ids (the reference
//     direction carries ids only, no titles) in one request per 25.
//   * `language` on the work record is NOT a Chinese-source test (see the shared module's comment).
//
// The three states are the point of the module: `unavailable` (the index could not be read) is never
// reported as `empty` ("nothing cites this work"), because those two lead to opposite decisions.

import {
  chineseSignalsFor,
  countChinese,
  isCitationDirection,
  type CitationCandidate,
  type CitationDirection,
  type CitationDiscoveryResult
} from '../../shared/references-citation-discovery'

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

const OPENALEX_WORKS = 'https://api.openalex.org/works'

/** One page of 25 is the documented cap we self-impose; two pages is the walk's bound. */
export const CITATION_PAGE_SIZE = 25
export const CITATION_MAX_PAGES = 2

type OpenAlexWork = {
  id?: string
  doi?: string | null
  title?: string | null
  display_name?: string | null
  publication_year?: number | null
  language?: string | null
  cited_by_count?: number | null
  referenced_works?: string[] | null
  referenced_works_count?: number | null
  primary_location?: { source?: { language?: string | null } | null } | null
}

type OpenAlexList = {
  meta?: { count?: number | null }
  results?: OpenAlexWork[]
}

const normalizeDoi = (raw: string): string =>
  raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase()

/** A DOI has a shape; anything else is refused before a request is made, so a typo cannot turn into
 *  a 404 that looks like "this work has no citations". */
const DOI_SHAPE = /^10\.\d{4,9}\/\S+$/

const openAlexShortId = (url: string | null | undefined): string => {
  const match = (url ?? '').trim().match(/openalex\.org\/(W\d+)$/)
  return match ? match[1] : ''
}

const doiFromRecord = (raw: string | null | undefined): string | undefined => {
  const value = normalizeDoi(raw ?? '')
  return value.length > 0 ? value : undefined
}

/** One OpenAlex work → one row. `journalLanguage` is read here, before the row forgets it, because
 *  the Chinese-source test needs the journal's own language and the row keeps only the signals. */
const toCandidate = (work: OpenAlexWork): CitationCandidate | null => {
  const id = openAlexShortId(work.id)
  if (!id) return null
  const title = (work.title ?? work.display_name ?? '').trim()
  const doi = doiFromRecord(work.doi)
  const journalLanguage = work.primary_location?.source?.language ?? null
  return {
    openAlexId: id,
    doi,
    title,
    year: typeof work.publication_year === 'number' ? work.publication_year : undefined,
    language: work.language ?? undefined,
    chineseSignals: chineseSignalsFor({ title, doi, journalLanguage }),
    sourceUrl: `https://openalex.org/${id}`
  }
}

const rowsFromList = (payload: unknown): OpenAlexWork[] => {
  const results = (payload as OpenAlexList | null)?.results
  return Array.isArray(results) ? results : []
}

export type DiscoverCitationsInput = {
  referenceId: string
  /** The record's DOI — passed in by the caller from its own store, never from the surface. */
  doi: string
  direction: CitationDirection
  fetchImpl: FetchLike
  now?: () => Date
  pageSize?: number
  maxPages?: number
}

const base = (input: DiscoverCitationsInput): Omit<CitationDiscoveryResult, 'status'> => ({
  direction: input.direction,
  referenceId: input.referenceId,
  doi: normalizeDoi(input.doi),
  total: null,
  examined: 0,
  candidates: [],
  chineseCount: 0,
  sourceUrl: `${OPENALEX_WORKS}/doi:${normalizeDoi(input.doi)}`,
  checkedAt: (input.now?.() ?? new Date()).toISOString(),
  incomplete: false
})

const unavailable = (input: DiscoverCitationsInput, error: string): CitationDiscoveryResult => ({
  ...base(input),
  status: 'unavailable',
  error
})

/** Resolve the DOI to its OpenAlex record. Null when the record is not there (a distinct answer from
 *  "the request failed", and both are distinct from "nothing cites it"). */
const resolveWork = async (
  input: DiscoverCitationsInput
): Promise<{ work: OpenAlexWork; id: string } | { failure: CitationDiscoveryResult }> => {
  const url = `${OPENALEX_WORKS}/doi:${normalizeDoi(input.doi)}`
  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await input.fetchImpl(url, { headers: { accept: 'application/json' } })
  } catch (error) {
    return {
      failure: unavailable(input, `OpenAlex could not be reached: ${(error as Error).message}`)
    }
  }
  if (!response.ok) {
    return {
      failure: unavailable(
        input,
        response.status === 404
          ? 'OpenAlex holds no record for this DOI (HTTP 404) — not the same as “no citations”'
          : `OpenAlex answered HTTP ${response.status}`
      )
    }
  }
  const payload = (await response.json()) as OpenAlexWork | null
  const id = openAlexShortId(payload?.id)
  if (!payload || !id) {
    return { failure: unavailable(input, 'OpenAlex returned no work record for this DOI') }
  }
  return { work: payload, id }
}

/** The works citing this one: paged, bounded, and honest about a page that failed mid-walk. */
const walkCitations = async (
  input: DiscoverCitationsInput,
  workId: string,
  pageSize: number,
  maxPages: number
): Promise<CitationDiscoveryResult> => {
  const result = base(input)
  const candidates: CitationCandidate[] = []
  let total: number | null = null
  let incomplete = false
  let error: string | undefined

  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${OPENALEX_WORKS}?filter=cites:${workId}&per-page=${pageSize}&page=${page}`
    try {
      const response = await input.fetchImpl(url, { headers: { accept: 'application/json' } })
      if (!response.ok) {
        if (page === 1) return unavailable(input, `OpenAlex answered HTTP ${response.status}`)
        incomplete = true
        error = `page ${page} of the citation walk answered HTTP ${response.status}`
        break
      }
      const payload = (await response.json()) as OpenAlexList | null
      if (typeof payload?.meta?.count === 'number') total = payload.meta.count
      const rows = rowsFromList(payload)
      for (const row of rows) {
        const candidate = toCandidate(row)
        if (candidate) candidates.push(candidate)
      }
      // A short page is the end of the set; walking further would only repeat the same answer.
      if (rows.length < pageSize) break
    } catch (failure) {
      if (page === 1) {
        return unavailable(input, `OpenAlex could not be reached: ${(failure as Error).message}`)
      }
      incomplete = true
      error = `page ${page} of the citation walk failed: ${(failure as Error).message}`
      break
    }
  }

  const examined = candidates.length
  return {
    ...result,
    status: examined > 0 ? 'found' : 'empty',
    total,
    examined,
    candidates,
    chineseCount: countChinese(candidates),
    incomplete,
    error
  }
}

/** Whatever this work cites: the ids are on the record, the titles need one resolve per 25. */
const walkReferences = async (
  input: DiscoverCitationsInput,
  work: OpenAlexWork,
  pageSize: number,
  maxPages: number
): Promise<CitationDiscoveryResult> => {
  const result = base(input)
  const ids = (work.referenced_works ?? []).map((url) => openAlexShortId(url)).filter(Boolean)
  const total =
    typeof work.referenced_works_count === 'number' ? work.referenced_works_count : ids.length
  const wanted = ids.slice(0, pageSize * maxPages)
  const candidates: CitationCandidate[] = []
  let incomplete = wanted.length < ids.length
  let error: string | undefined = incomplete
    ? `this work lists ${ids.length} references; the walk reads the first ${wanted.length}`
    : undefined

  for (let start = 0; start < wanted.length; start += pageSize) {
    const batch = wanted.slice(start, start + pageSize)
    const url = `${OPENALEX_WORKS}?filter=openalex_id:${batch.join('|')}&per-page=${pageSize}`
    try {
      const response = await input.fetchImpl(url, { headers: { accept: 'application/json' } })
      if (!response.ok) {
        if (start === 0) return unavailable(input, `OpenAlex answered HTTP ${response.status}`)
        incomplete = true
        error = `batch starting at ${start} answered HTTP ${response.status}`
        break
      }
      for (const row of rowsFromList(await response.json())) {
        const candidate = toCandidate(row)
        if (candidate) candidates.push(candidate)
      }
    } catch (failure) {
      if (start === 0) {
        return unavailable(input, `OpenAlex could not be reached: ${(failure as Error).message}`)
      }
      incomplete = true
      error = `batch starting at ${start} failed: ${(failure as Error).message}`
      break
    }
  }

  return {
    ...result,
    status: candidates.length > 0 ? 'found' : 'empty',
    total,
    examined: candidates.length,
    candidates,
    chineseCount: countChinese(candidates),
    incomplete,
    error
  }
}

export const discoverCitations = async (
  input: DiscoverCitationsInput
): Promise<CitationDiscoveryResult> => {
  if (!isCitationDirection(input.direction)) {
    return unavailable(input, `unknown direction: ${String(input.direction)}`)
  }
  const doi = normalizeDoi(input.doi)
  if (!DOI_SHAPE.test(doi)) {
    return unavailable(input, doi.length === 0 ? 'this record has no DOI' : 'this DOI is malformed')
  }

  const pageSize = Math.min(Math.max(input.pageSize ?? CITATION_PAGE_SIZE, 1), CITATION_PAGE_SIZE)
  const maxPages = Math.min(Math.max(input.maxPages ?? CITATION_MAX_PAGES, 1), CITATION_MAX_PAGES)

  const resolved = await resolveWork(input)
  if ('failure' in resolved) return resolved.failure
  return input.direction === 'citations'
    ? walkCitations(input, resolved.id, pageSize, maxPages)
    : walkReferences(input, resolved.work, pageSize, maxPages)
}
