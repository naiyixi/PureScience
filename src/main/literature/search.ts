// Literature retrieval that works without a DOM, so an external MCP client can call it.
//
// Three sources, each read through its own public endpoint and normalized into one record shape:
//   - PubMed (NCBI E-utilities): esearch for ids, esummary for the record, efetch for the abstract text.
//   - arXiv (Atom export): preprints, which have no DOI but do have an arXiv id.
//   - Crossref (REST): DOI metadata, which is how a China-hosted reader usually arrives (a DOI on a paper).
//
// Rules kept from the rest of this codebase:
//   1. Nothing is invented. A record without a year has no year; a DOI is only a DOI when it starts with `10.`
//      (MEDLINE puts publisher item ids in the same tags — `88/4/401M [pii]` — and storing that as a DOI means
//      every later click 404s).
//   2. Every record carries where it came from and what was actually read (`Abstract` vs `Metadata only`), so a
//      citation built on it can say so instead of implying a full text was consulted.
//   3. A failing source does not fail the search: it is reported in `errors`, and the records from the sources
//      that answered are returned.

import { tagText, tagTexts } from './xml-fields'

export type LiteratureSource = 'pubmed' | 'arxiv' | 'crossref'

export type LiteratureRecord = {
  source: LiteratureSource
  title: string
  authors: string[]
  year: number | undefined
  venue: string | undefined
  volume: string | undefined
  issue: string | undefined
  pages: string | undefined
  doi: string | undefined
  pmid: string | undefined
  pmcid: string | undefined
  arxivId: string | undefined
  url: string
  abstract: string | undefined
  /** What was actually read: the abstract text, or only the bibliographic record. */
  read: 'Abstract' | 'Metadata only'
}

export type LiteratureSearchResult = {
  query: string
  records: LiteratureRecord[]
  errors: Array<{ source: LiteratureSource; message: string }>
}

const NCBI = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const ARXIV = 'https://export.arxiv.org/api/query'
const CROSSREF = 'https://api.crossref.org/works'

const DOI_PREFIX = /^10\.\S+$/u

export const asDoi = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const trimmed = value
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//iu, '')
    .replace(/^doi:\s*/iu, '')
    .replace(/\s*\[doi\]\s*$/iu, '')
    .trim()
  return DOI_PREFIX.test(trimmed) ? trimmed : undefined
}

const yearOf = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const match = /(1[5-9]\d{2}|20\d{2})/u.exec(value)
  if (match?.[1] === undefined) return undefined
  const year = Number(match[1])
  return Number.isFinite(year) ? year : undefined
}

const clean = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const trimmed = value.replace(/\s+/gu, ' ').trim()
  return trimmed === '' ? undefined : trimmed
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<unknown>
}>

const request = async (
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; body: string }> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    return { ok: response.ok, status: response.status, body: await response.text() }
  } finally {
    clearTimeout(timer)
  }
}

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

// ── PubMed ────────────────────────────────────────────────────────────────────────────────────────────────

type EsummaryDoc = {
  title?: string
  pubdate?: string
  fulljournalname?: string
  source?: string
  volume?: string
  issue?: string
  pages?: string
  authors?: Array<{ name?: string }>
  articleids?: Array<{ idtype?: string; value?: string }>
}

export const parsePubMedSummary = (body: string): LiteratureRecord[] => {
  const parsed = parseJson(body) as { result?: Record<string, unknown> } | undefined
  const result = parsed?.result
  if (result === undefined) return []
  const uids = Array.isArray(result.uids) ? (result.uids as string[]) : []

  const records: LiteratureRecord[] = []
  for (const uid of uids) {
    const doc = result[uid] as EsummaryDoc | undefined
    if (doc === undefined) continue
    const title = clean(doc.title)
    if (title === undefined) continue
    const ids = doc.articleids ?? []
    const doi = asDoi(ids.find((entry) => entry.idtype === 'doi')?.value)
    const pmcid = ids.find((entry) => entry.idtype === 'pmc')?.value

    records.push({
      source: 'pubmed',
      title,
      authors: (doc.authors ?? [])
        .map((author) => clean(author.name))
        .filter((name): name is string => name !== undefined),
      year: yearOf(doc.pubdate),
      venue: clean(doc.fulljournalname) ?? clean(doc.source),
      volume: clean(doc.volume),
      issue: clean(doc.issue),
      pages: clean(doc.pages),
      doi,
      pmid: uid,
      pmcid,
      arxivId: undefined,
      url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
      abstract: undefined,
      read: 'Metadata only'
    })
  }
  return records
}

/**
 * Abstract text per PMID from an `efetch … retmode=xml` response.
 *
 * Why XML and not the pretty `rettype=abstract&retmode=text` view: that view prints a human-readable citation
 * block and then the abstract as untagged paragraphs — there is no field marker to key on, so a parser either
 * guesses where the abstract starts or silently returns nothing (measured: every record came back
 * `Metadata only`). The XML has `<AbstractText Label="METHODS">`, which is both findable and better cited.
 */
export const parsePubMedXmlAbstracts = (xml: string): Map<string, string> => {
  const abstracts = new Map<string, string>()
  for (const article of xml.split(/<PubmedArticle>/u).slice(1)) {
    const pmid = tagText(article, 'PMID')
    if (pmid === undefined) continue
    const sections: string[] = []
    for (const match of article.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/gu)) {
      const label = /Label="([^"]*)"/u.exec(match[1] ?? '')?.[1]
      const text = clean((match[2] ?? '').replace(/<[^>]+>/gu, ' '))
      if (text === undefined) continue
      sections.push(label === undefined || label === '' ? text : `${label}: ${text}`)
    }
    const joined = clean(sections.join(' '))
    if (joined !== undefined) abstracts.set(pmid, joined)
  }
  return abstracts
}

export const searchPubMed = async (
  query: string,
  limit: number,
  fetchImpl: FetchLike,
  timeoutMs = 20_000
): Promise<LiteratureRecord[]> => {
  const search = await request(
    fetchImpl,
    `${NCBI}/esearch.fcgi?db=pubmed&retmode=json&retmax=${limit}&term=${encodeURIComponent(query)}`,
    timeoutMs
  )
  if (!search.ok) throw new Error(`PubMed search answered ${search.status}`)
  const ids =
    (parseJson(search.body) as { esearchresult?: { idlist?: string[] } } | undefined)?.esearchresult
      ?.idlist ?? []
  if (ids.length === 0) return []

  const summary = await request(
    fetchImpl,
    `${NCBI}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`,
    timeoutMs
  )
  if (!summary.ok) throw new Error(`PubMed summary answered ${summary.status}`)
  const records = parsePubMedSummary(summary.body)
  if (records.length === 0) return records

  // Abstracts are a second round trip; a failure here leaves the records as metadata rather than losing them.
  try {
    const fetched = await request(
      fetchImpl,
      `${NCBI}/efetch.fcgi?db=pubmed&retmode=xml&id=${records.map((record) => record.pmid).join(',')}`,
      timeoutMs
    )
    if (fetched.ok) {
      const abstracts = parsePubMedXmlAbstracts(fetched.body)
      for (const record of records) {
        const abstract = record.pmid === undefined ? undefined : abstracts.get(record.pmid)
        if (abstract !== undefined) {
          record.abstract = abstract
          record.read = 'Abstract'
        }
      }
    }
  } catch {
    // Keep the metadata we already have.
  }
  return records
}

// ── arXiv ─────────────────────────────────────────────────────────────────────────────────────────────────

export const parseArxivFeed = (xml: string): LiteratureRecord[] => {
  const entries = xml.split(/<entry>/u).slice(1)
  const records: LiteratureRecord[] = []
  for (const entry of entries) {
    const title = clean(tagText(entry, 'title'))
    if (title === undefined) continue
    const idUrl = clean(tagText(entry, 'id'))
    const arxivId = idUrl?.replace(/^https?:\/\/arxiv\.org\/abs\//u, '') ?? undefined
    const authors = tagTexts(entry, 'name')
      .map((name) => clean(name))
      .filter((name): name is string => name !== undefined)
    const doi = asDoi(tagText(entry, 'doi'))
    records.push({
      source: 'arxiv',
      title,
      authors,
      year: yearOf(tagText(entry, 'published')),
      venue: 'arXiv',
      volume: undefined,
      issue: undefined,
      pages: undefined,
      doi,
      pmid: undefined,
      pmcid: undefined,
      arxivId,
      url:
        idUrl ?? (arxivId === undefined ? 'https://arxiv.org' : `https://arxiv.org/abs/${arxivId}`),
      abstract: clean(tagText(entry, 'summary')),
      read: clean(tagText(entry, 'summary')) === undefined ? 'Metadata only' : 'Abstract'
    })
  }
  return records
}

/** One arXiv id → its record. `id_list` is the endpoint's lookup parameter; a search query cannot express an id. */
export const lookupArxivId = async (
  arxivId: string,
  fetchImpl: FetchLike,
  timeoutMs = 20_000
): Promise<LiteratureRecord | undefined> => {
  const response = await request(
    fetchImpl,
    `${ARXIV}?id_list=${encodeURIComponent(arxivId)}`,
    timeoutMs
  )
  if (!response.ok) throw new Error(`arXiv answered ${response.status} for ${arxivId}`)
  const records = parseArxivFeed(response.body)
  return records.find((record) => record.arxivId?.startsWith(arxivId)) ?? records[0]
}

export const searchArxiv = async (
  query: string,
  limit: number,
  fetchImpl: FetchLike,
  timeoutMs = 20_000
): Promise<LiteratureRecord[]> => {
  const response = await request(
    fetchImpl,
    `${ARXIV}?search_query=${encodeURIComponent(`all:${query}`)}&start=0&max_results=${limit}`,
    timeoutMs
  )
  if (!response.ok) throw new Error(`arXiv answered ${response.status}`)
  return parseArxivFeed(response.body)
}

// ── Crossref ─────────────────────────────────────────────────────────────────────────────────────────────

type CrossrefWork = {
  DOI?: string
  title?: string[]
  author?: Array<{ given?: string; family?: string; name?: string }>
  issued?: { 'date-parts'?: number[][] }
  'container-title'?: string[]
  volume?: string
  issue?: string
  page?: string
  abstract?: string
  type?: string
  URL?: string
}

export const crossrefWorkToRecord = (work: CrossrefWork): LiteratureRecord | undefined => {
  const title = clean(work.title?.[0])
  if (title === undefined) return undefined
  const doi = asDoi(work.DOI)
  const authors = (work.author ?? [])
    .map((author) => clean(author.name ?? [author.given, author.family].filter(Boolean).join(' ')))
    .filter((name): name is string => name !== undefined)
  const year = work.issued?.['date-parts']?.[0]?.[0]
  // Crossref prefixes abstracts with JATS markup; the tags go, the text stays.
  const abstract = clean(work.abstract?.replace(/<[^>]+>/gu, ' '))

  return {
    source: 'crossref',
    title,
    authors,
    year: typeof year === 'number' ? year : undefined,
    venue: clean(work['container-title']?.[0]),
    volume: clean(work.volume),
    issue: clean(work.issue),
    pages: clean(work.page),
    doi,
    pmid: undefined,
    pmcid: undefined,
    arxivId: undefined,
    url: doi === undefined ? `https://doi.org/${work.DOI ?? ''}` : `https://doi.org/${doi}`,
    abstract,
    read: abstract === undefined ? 'Metadata only' : 'Abstract'
  }
}

export const lookupDoi = async (
  doi: string,
  fetchImpl: FetchLike,
  timeoutMs = 20_000
): Promise<LiteratureRecord | undefined> => {
  const normalized = asDoi(doi)
  if (normalized === undefined) return undefined
  const response = await request(
    fetchImpl,
    `${CROSSREF}/${encodeURIComponent(normalized)}`,
    timeoutMs
  )
  if (!response.ok) throw new Error(`Crossref answered ${response.status} for ${normalized}`)
  const parsed = parseJson(response.body) as { message?: CrossrefWork } | undefined
  return parsed?.message === undefined ? undefined : crossrefWorkToRecord(parsed.message)
}

// ── one search across sources ────────────────────────────────────────────────────────────────────────────

export type LiteratureSearchInput = {
  query: string
  sources?: LiteratureSource[]
  limit?: number
  fetchImpl?: FetchLike
  timeoutMs?: number
}

export const searchLiterature = async (
  input: LiteratureSearchInput
): Promise<LiteratureSearchResult> => {
  const query = input.query.trim()
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50))
  const sources = input.sources ?? ['pubmed', 'arxiv']
  const fetchImpl = input.fetchImpl ?? (fetch as unknown as FetchLike)
  const records: LiteratureRecord[] = []
  const errors: LiteratureSearchResult['errors'] = []

  // A DOI query is a lookup, not a search: sending `10.1056/...` to a full-text index returns noise.
  const doi = asDoi(query)
  if (doi !== undefined) {
    try {
      const record = await lookupDoi(doi, fetchImpl, input.timeoutMs)
      if (record !== undefined) records.push(record)
    } catch (error) {
      errors.push({
        source: 'crossref',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  } else {
    const runners: Array<[LiteratureSource, () => Promise<LiteratureRecord[]>]> = []
    if (sources.includes('pubmed'))
      runners.push(['pubmed', () => searchPubMed(query, limit, fetchImpl, input.timeoutMs)])
    if (sources.includes('arxiv'))
      runners.push(['arxiv', () => searchArxiv(query, limit, fetchImpl, input.timeoutMs)])

    const settled = await Promise.allSettled(runners.map(([, run]) => run()))
    settled.forEach((outcome, index) => {
      const source = runners[index]?.[0]
      if (source === undefined) return
      if (outcome.status === 'fulfilled') records.push(...outcome.value)
      else
        errors.push({
          source,
          message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        })
    })
  }

  // One work can arrive twice (a preprint indexed in both). The DOI is the identity when there is one.
  const seen = new Set<string>()
  const deduped = records.filter((record) => {
    const key =
      record.doi !== undefined
        ? `doi:${record.doi.toLowerCase()}`
        : `title:${record.title.toLowerCase().replace(/\s+/gu, '')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return { query, records: deduped.slice(0, limit * Math.max(1, sources.length)), errors }
}

/** The citation a caller can paste, built only from fields the record actually has. */
export const formatCitation = (record: LiteratureRecord): string => {
  const authors =
    record.authors.length === 0
      ? undefined
      : record.authors.length > 3
        ? `${record.authors.slice(0, 3).join(', ')}, et al`
        : record.authors.join(', ')
  const parts = [
    authors,
    record.title,
    record.venue,
    record.year === undefined ? undefined : String(record.year),
    record.volume === undefined
      ? undefined
      : `${record.volume}${record.issue === undefined ? '' : `(${record.issue})`}`,
    record.pages,
    record.doi === undefined ? undefined : `doi:${record.doi}`
  ].filter((part): part is string => part !== undefined && part !== '')
  return `${parts.join('. ')}.`
}
