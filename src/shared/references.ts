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
