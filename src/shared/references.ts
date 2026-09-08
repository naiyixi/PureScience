// Reference-library domain types crossing the main <-> renderer boundary (v1.51).
// The library is project-scoped: every record belongs to exactly one Project row (logical FK —
// tables are pure-additive and keep no relational constraints, matching the runtime-DDL schema).
// Timestamps are epoch milliseconds at the repository boundary.

export type ReferenceSourceConnector = 'openalex' | 'pubmed' | 'arxiv' | 'europepmc' | 'manual'

export type ReferenceAuthor = {
  name: string
  orcid?: string
}

// Capture snapshot attached to every connector-imported record. Feeds the citation-verification
// loop: a citation claims a record + its captured snapshot, so the reviewer can re-fetch and diff.
export type ReferenceProvenance = {
  connector: ReferenceSourceConnector
  fetchedAt: string // ISO
  sourceUrl?: string
  sourceRecordId?: string
  snapshotJson?: string // raw connector payload (bounded)
}

export type Reference = {
  id: string
  projectId: string
  title: string
  authors: ReferenceAuthor[]
  venue: string | undefined
  year: number | undefined
  doi: string | undefined
  pmid: string | undefined
  pmcid: string | undefined
  arxivId: string | undefined
  url: string | undefined
  abstractSnippet: string | undefined
  sourceConnector: ReferenceSourceConnector
  sourceRecordId: string | undefined
  // Auto-generated "FirstAuthorYear" + collision suffix; unique within the project.
  citationKey: string
  provenance: ReferenceProvenance | undefined
  pdfManagedFileId: string | undefined
  notes: string | undefined
  // Collection memberships of this record, populated by list-style reads (undefined on single reads).
  collectionIds?: string[]
  createdAt: number
  updatedAt: number
}

export type ReferenceCollection = {
  id: string
  projectId: string
  name: string
  description: string | undefined
  createdAt: number
  updatedAt: number
}

export type CollectionItem = {
  id: string
  collectionId: string
  referenceId: string
  note: string | undefined
  sortIndex: number
  createdAt: number
}

// Add-form payload for a new library record (UI or connector import path).
export type CreateReferenceInput = {
  projectId: string
  title: string
  authors?: ReferenceAuthor[]
  venue?: string
  year?: number
  doi?: string
  pmid?: string
  pmcid?: string
  arxivId?: string
  url?: string
  abstractSnippet?: string
  sourceConnector?: ReferenceSourceConnector
  sourceRecordId?: string
  provenance?: ReferenceProvenance
  notes?: string
}

export type CreateReferenceCollectionInput = {
  projectId: string
  name: string
  description?: string
}

// Result of an add attempt: either a fresh record or a duplicate-detection hit (nothing written).
export type AddReferenceResult =
  { status: 'created'; reference: Reference } | { status: 'duplicate'; duplicateOf: Reference[] }

// Normalizes a title for duplicate detection: case-fold, strip punctuation/whitespace runs and
// common lead-ins ("The", "A", "An"), and drop trailing periods.
export const normalizeTitleForDedupe = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/^(the|a|an)\s+/u, '')
    .trim()

// Duplicate-identity descriptors checked when adding records: any non-empty match flags a duplicate.
export const referenceIdentity = (input: CreateReferenceInput): string[] =>
  [input.doi, input.pmid, input.pmcid, input.arxivId]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim().toLowerCase())

// Builds a candidate citation key "FirstAuthorYear" from an input; the repository/service appends a
// numeric suffix when the key collides within the project. ASCII-folded for key stability.
export const citationKeyFrom = (input: CreateReferenceInput): string => {
  const firstName = (input.authors?.[0]?.name ?? '').trim()
  const surname = firstName.split(/\s+/).pop() ?? ''
  const latin = surname
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z]/g, '')
  const base = latin || 'Ref'
  return input.year ? `${base}${input.year}` : base
}

// ---- GB/T 7714-2015 (顺序编码制) citation formatting ----
// Practice style used by Chinese journals: CJK author names verbatim (姓前名后), Western names
// rendered surname-first with dotted initials; >3 authors abbreviated with 等 / "et al." keyed to
// the first author's script; journal records tagged [J], identifier-only records [EB/OL] with a
// retrieval date and resolvable locator, and DOI appended at the record end when present.
const CJK_SCRIPT_RE = /[\u3400-\u9fff]/
const hasCjk = (value: string): boolean => CJK_SCRIPT_RE.test(value)

export const gbt7714AuthorName = (raw: string): string => {
  const name = raw.trim()
  if (!name || hasCjk(name)) return name
  const comma = name
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  let surname: string
  let given: string
  if (comma.length >= 2) {
    surname = comma[0]
    given = comma.slice(1).join(' ')
  } else {
    const words = name.split(/\s+/).filter(Boolean)
    if (words.length === 1) return name
    surname = words[words.length - 1]
    given = words.slice(0, -1).join(' ')
  }
  const initials = given
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word[0]}.`)
    .join(' ')
  return initials ? `${surname} ${initials}` : surname
}

export const gbt7714Authors = (authors: readonly { name: string }[]): string => {
  if (authors.length === 0) return ''
  const names = authors.map((author) => gbt7714AuthorName(author.name))
  const first = names.slice(0, 3)
  if (authors.length <= 3) {
    // The call site appends ". " after the author list; drop the dotted-initial trailing dot.
    return first.join(', ').replace(/\.$/, '')
  }
  const ellipsis = hasCjk(names[0]) ? ', 等' : ' et al.'
  return `${first.join(', ')}${ellipsis}`
}

export const gbt7714Locator = (
  reference: Pick<Reference, 'doi' | 'arxivId' | 'pmid' | 'pmcid'>
): string => {
  if (reference.doi?.trim()) return `https://doi.org/${reference.doi.trim()}`
  if (reference.arxivId?.trim()) return `https://arxiv.org/abs/${reference.arxivId.trim()}`
  if (reference.pmid?.trim()) return `https://pubmed.ncbi.nlm.nih.gov/${reference.pmid.trim()}/`
  if (reference.pmcid?.trim())
    return `https://www.ncbi.nlm.nih.gov/pmc/articles/${reference.pmcid.trim()}/`
  return ''
}

export const formatGbt7714 = (
  reference: Pick<
    Reference,
    'title' | 'authors' | 'venue' | 'year' | 'doi' | 'arxivId' | 'pmid' | 'pmcid'
  >,
  options: { retrievedAt?: string } = {}
): string => {
  const authors = gbt7714Authors(reference.authors)
  const title = reference.title.trim()
  const venue = reference.venue?.trim()
  if (venue) {
    const suffix = [venue, reference.year ? String(reference.year) : ''].filter(Boolean).join(', ')
    const doi = reference.doi?.trim() ? ` ${reference.doi.trim()}` : ''
    return `${authors}. ${title}[J]. ${suffix}.${doi}`
  }
  const year = reference.year ? ` ${reference.year}.` : ''
  const retrieved = options.retrievedAt ? ` [${options.retrievedAt}].` : '.'
  const locator = gbt7714Locator(reference)
  const location = locator ? ` ${locator}` : ''
  return `${authors}. ${title}[EB/OL].${year}${retrieved}${location}`
}

export const formatGbt7714List = (
  references: Parameters<typeof formatGbt7714>[0][],
  options: { retrievedAt?: string } = {}
): string =>
  references
    .map((reference, index) => `[${index + 1}] ${formatGbt7714(reference, options)}`)
    .join('\n')
