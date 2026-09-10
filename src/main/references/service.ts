import type { ReferenceRepository } from './repository'
import type {
  AddReferenceResult,
  CollectionItem,
  CreateReferenceCollectionInput,
  CreateReferenceInput,
  Reference,
  ReferenceCollection
} from '../../shared/references'
import {
  citationKeyFrom,
  normalizeTitleForDedupe,
  referenceIdentity
} from '../../shared/references'

// Bounded snapshot size stored in provenanceJson (never mirrors a full paper).
const MAX_SNAPSHOT_CHARS = 64_000
const MAX_ABSTRACT_CHARS = 8_000
const MAX_TITLE_CHARS = 2_000

// Identifier kinds resolvable through public bibliographic APIs (library add-by-identifier).
export type IdentifierKind = 'doi' | 'pmid' | 'pmcid' | 'arxivId'

export type FetchByIdentifierDeps = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

// Resolves bibliographic metadata for a single identifier from its canonical public API:
//   doi     → OpenAlex works?filter=doi:
//   pmid    → NCBI E-utilities esummary (retmode=json)
//   pmcid   → NCBI E-utilities esummary (id=PMC..., db=pmc)
//   arxivId → arXiv API (export.arxiv.org)
// Each returns a normalized CreateReferenceInput plus a provenance snapshot that pins the exact
// record as fetched — this is what makes later citation verification executable, not decorative.
export const fetchReferenceByIdentifier = async (
  kind: IdentifierKind,
  identifier: string,
  { fetchImpl = fetch, timeoutMs = 20_000 }: FetchByIdentifierDeps = {}
): Promise<CreateReferenceInput | null> => {
  const value = identifier.trim()
  if (!value) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    if (kind === 'doi') {
      const url = `https://api.openalex.org/works?filter=doi:${encodeURIComponent(value)}&per-page=1`
      const response = await fetchImpl(url, { signal: controller.signal })
      if (!response.ok) return null
      const body = (await response.json()) as { results?: Array<Record<string, unknown>> }
      const hit = body.results?.[0]
      if (!hit) return null
      return {
        projectId: '',
        title: String(hit.title ?? '').slice(0, MAX_TITLE_CHARS),
        authors: Array.isArray(hit.authorships)
          ? (hit.authorships as Array<{ author?: { display_name?: string } }>)
              .map((entry) => entry.author?.display_name)
              .filter((name): name is string => Boolean(name))
              .map((name) => ({ name }))
          : [],
        venue:
          typeof (hit.primary_location as { source?: { display_name?: unknown } } | undefined)
            ?.source?.display_name === 'string'
            ? (hit.primary_location as { source: { display_name: string } }).source.display_name
            : undefined,
        year: typeof hit.publication_year === 'number' ? hit.publication_year : undefined,
        doi:
          typeof hit.doi === 'string' ? hit.doi.replace(/^https?:\/\/doi\.org\//i, '') : undefined,
        url: typeof hit.doi === 'string' ? hit.doi : undefined,
        abstractSnippet:
          String(hit.abstract_inverted_index ? '' : '').slice(0, MAX_ABSTRACT_CHARS) || undefined,
        sourceConnector: 'openalex',
        sourceRecordId: typeof hit.id === 'string' ? hit.id : undefined,
        provenance: {
          connector: 'openalex',
          fetchedAt: new Date().toISOString(),
          sourceUrl: url,
          sourceRecordId: typeof hit.id === 'string' ? hit.id : undefined,
          snapshotJson: JSON.stringify(hit).slice(0, MAX_SNAPSHOT_CHARS)
        }
      }
    }
    if (kind === 'pmid' || kind === 'pmcid') {
      const db = kind === 'pmid' ? 'pubmed' : 'pmc'
      const idParam = kind === 'pmid' ? value : `PMC${value.replace(/^PMC/i, '')}`
      const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=${db}&id=${encodeURIComponent(idParam)}&retmode=json`
      const response = await fetchImpl(url, { signal: controller.signal })
      if (!response.ok) return null
      const body = (await response.json()) as {
        result?: { uids?: string[]; [uid: string]: unknown }
      }
      const uid = body.result?.uids?.[0]
      if (!uid) return null
      const record = (body.result ?? {})[uid] as Record<string, unknown> | undefined
      if (!record) return null
      const authors = Array.isArray(record.authors)
        ? (record.authors as Array<{ name?: string }>)
            .map((entry) => entry.name)
            .filter((name): name is string => Boolean(name))
            .map((name) => ({ name }))
        : []
      const iso =
        record.pubdate && typeof record.pubdate === 'string'
          ? Number.parseInt(String(record.pubdate).slice(0, 4), 10)
          : undefined
      return {
        projectId: '',
        title: String(record.title ?? '').slice(0, MAX_TITLE_CHARS),
        authors,
        venue: typeof record.fulljournalname === 'string' ? record.fulljournalname : undefined,
        year: Number.isFinite(iso) ? iso : undefined,
        pmid: kind === 'pmid' ? value : undefined,
        pmcid: kind === 'pmcid' ? value : undefined,
        url: kind === 'pmid' ? `https://pubmed.ncbi.nlm.nih.gov/${value}/` : undefined,
        sourceConnector: 'pubmed',
        sourceRecordId: uid,
        provenance: {
          connector: 'pubmed',
          fetchedAt: new Date().toISOString(),
          sourceUrl: url,
          sourceRecordId: uid,
          snapshotJson: JSON.stringify(record).slice(0, MAX_SNAPSHOT_CHARS)
        }
      }
    }
    // arxivId
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(value)}&max_results=1`
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok) return null
    const text = await response.text()
    const titleMatch = text.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/i)
    if (!titleMatch) return null
    const title = titleMatch[1].replace(/\s+/g, ' ').trim()
    const yearMatch = text.match(/<published>(\d{4})/)
    const authors = [...text.matchAll(/<name>([\s\S]*?)<\/name>/gi)].map((match) =>
      match[1].replace(/\s+/g, ' ').trim()
    )
    const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i)
    return {
      projectId: '',
      title: title.slice(0, MAX_TITLE_CHARS),
      authors: authors.map((name) => ({ name })),
      year: yearMatch ? Number.parseInt(yearMatch[1], 10) : undefined,
      arxivId: value,
      url: `https://arxiv.org/abs/${value}`,
      abstractSnippet: summaryMatch?.[1].replace(/\s+/g, ' ').trim().slice(0, MAX_ABSTRACT_CHARS),
      sourceConnector: 'arxiv',
      sourceRecordId: value,
      provenance: {
        connector: 'arxiv',
        fetchedAt: new Date().toISOString(),
        sourceUrl: url,
        sourceRecordId: value,
        snapshotJson: text.slice(0, MAX_SNAPSHOT_CHARS)
      }
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// A best-effort title/identity match within the project, used to reject obvious duplicates before a
// second copy lands in the library (also the "merge candidates" feed for the batch merge action).
export const findDuplicateCandidates = (
  input: CreateReferenceInput,
  existing: readonly Reference[]
): Reference[] => {
  const identities = new Set(referenceIdentity(input))
  const titleKey = normalizeTitleForDedupe(input.title)
  return existing.filter((candidate) => {
    if (candidate.projectId !== input.projectId) return false
    if (identities.size > 0) {
      const candidateIds = referenceIdentity({
        projectId: input.projectId,
        title: candidate.title,
        doi: candidate.doi,
        pmid: candidate.pmid,
        pmcid: candidate.pmcid,
        arxivId: candidate.arxivId
      })
      if (candidateIds.some((id) => identities.has(id))) return true
    }
    return titleKey.length > 0 && normalizeTitleForDedupe(candidate.title) === titleKey
  })
}

// Domain service over ReferenceRepository: identifier validation, dedupe, citation-key collision
// suffixes, and collection operations.
export class ReferenceService {
  constructor(
    private readonly repository: ReferenceRepository,
    // Optional provenance hook: when present, attaching a PDF records its content fingerprint so a
    // swapped file can be detected later (G2). Absent in lightweight tests/mocks.
    private readonly options: {
      resolvePdfFingerprint?: (projectId: string, managedFileId: string) => Promise<string | null>
    } = {}
  ) {}

  async listReferences(projectId: string): Promise<Reference[]> {
    return this.repository.listReferences(projectId)
  }

  // Adds a record. Duplicate identities/titles resolve to a `duplicate` result (nothing written).
  // citationKey derives from FirstAuthorYear and gains a numeric suffix on collisions.
  async addReference(
    input: CreateReferenceInput,
    options: { allowDuplicate?: boolean } = {}
  ): Promise<AddReferenceResult> {
    if (!input.projectId.trim()) throw new Error('A project is required for a reference.')
    if (!input.title.trim()) throw new Error('A title is required.')

    const existing = await this.repository.listReferences(input.projectId)
    const duplicates = findDuplicateCandidates(input, existing)
    if (!options.allowDuplicate && duplicates.length > 0) {
      return { status: 'duplicate', duplicateOf: duplicates }
    }

    const baseKey = citationKeyFrom(input)
    let citationKey = baseKey
    let suffix = 1
    const usedKeys = new Set(existing.map((record) => record.citationKey))
    while (usedKeys.has(citationKey)) {
      citationKey = `${baseKey}${suffix}`
      suffix += 1
    }

    const reference = await this.repository.createReference({ ...input, citationKey })
    return { status: 'created', reference }
  }

  async deleteReference(id: string): Promise<void> {
    await this.repository.deleteReference(id)
  }

  // Attaches the project-managed PDF that backs page-level annotations for a reference. The
  // renderer only offers files that belong to the active project; existence of the reference is
  // enforced here so a stale id can never silently write into a missing record.
  async attachPdf(
    referenceId: string,
    pdfManagedFileId: string | null,
    pdfContentHash: string | null = null
  ): Promise<Reference> {
    const existing = await this.repository.getReference(referenceId)
    if (!existing) throw new Error('Reference not found.')
    let fingerprint = pdfContentHash
    if (pdfManagedFileId && fingerprint == null && this.options.resolvePdfFingerprint) {
      try {
        fingerprint = await this.options.resolvePdfFingerprint(existing.projectId, pdfManagedFileId)
      } catch {
        // Fingerprinting is provenance sugar: a failure must never block attaching the file.
        fingerprint = null
      }
    }
    const updated = await this.repository.attachPdf(referenceId, pdfManagedFileId, fingerprint)
    if (!updated) throw new Error('Reference not found.')
    return updated
  }

  async detachPdf(referenceId: string): Promise<Reference> {
    return this.attachPdf(referenceId, null)
  }

  async listCollections(projectId: string): Promise<ReferenceCollection[]> {
    return this.repository.listCollections(projectId)
  }

  async createCollection(input: CreateReferenceCollectionInput): Promise<ReferenceCollection> {
    if (!input.projectId.trim()) throw new Error('A project is required for a collection.')
    if (!input.name.trim()) throw new Error('A collection name is required.')
    const trimmed = { ...input, name: input.name.trim() }
    // Readable duplicate-name error before the engine constraint fires.
    const existing = await this.repository.listCollections(input.projectId)
    if (existing.some((collection) => collection.name === trimmed.name)) {
      throw new Error(`A collection named "${trimmed.name}" already exists.`)
    }
    return this.repository.createCollection(trimmed)
  }

  async deleteCollection(id: string): Promise<void> {
    await this.repository.deleteCollection(id)
  }

  async addToCollection(collectionId: string, referenceId: string): Promise<CollectionItem> {
    return this.repository.addToCollection(collectionId, referenceId)
  }

  async removeFromCollection(collectionId: string, referenceId: string): Promise<void> {
    await this.repository.removeFromCollection(collectionId, referenceId)
  }

  // Merges duplicate records into `keeperId`: moves all collection memberships, concatenates notes,
  // prefers the keeper's richer provenance, then deletes the other rows.
  async mergeReferences(keeperId: string, duplicateIds: readonly string[]): Promise<Reference> {
    const keeper = await this.repository.getReference(keeperId)
    if (!keeper) throw new Error(`Keeper reference ${keeperId} not found.`)
    const others: Reference[] = []
    for (const id of duplicateIds) {
      const other = await this.repository.getReference(id)
      if (other && other.id !== keeper.id) others.push(other)
    }

    const mergedNotes = [
      keeper.notes,
      ...others.map((other) => other.notes).filter((note): note is string => Boolean(note))
    ]
      .filter((note): note is string => Boolean(note?.trim()))
      .join('\n\n')

    const keeperProvenance = keeper.provenance
    const richer = others.find(
      (other) =>
        other.provenance !== undefined &&
        (keeperProvenance === undefined ||
          (other.provenance.snapshotJson?.length ?? 0) >
            (keeperProvenance.snapshotJson?.length ?? 0))
    )

    // Moves memberships of duplicates onto the keeper (unique constraint would reject re-adds).
    for (const other of others) {
      const memberships = await this.repository.listMemberships(other.id)
      for (const membership of memberships) {
        await this.repository.addToCollection(membership.collectionId, keeperId, membership.note)
        await this.repository.removeFromCollection(membership.collectionId, other.id)
      }
      await this.repository.deleteReference(other.id)
    }

    if (mergedNotes !== keeper.notes || richer) {
      await this.repository.updateReference(keeperId, {
        notes: mergedNotes || undefined,
        provenance: richer?.provenance
      })
    }
    const updated = await this.repository.getReference(keeperId)
    if (!updated) throw new Error(`Keeper reference ${keeperId} disappeared during merge.`)
    return updated
  }
}
