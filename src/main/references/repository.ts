import type { PrismaClient } from '@prisma/client'

import type {
  CollectionItem,
  CreateReferenceCollectionInput,
  CreateReferenceInput,
  Reference,
  ReferenceAuthor,
  ReferenceCollection,
  ReferenceProvenance
} from '../../shared/references'
// Only the delegates this repository needs; typing to the subset keeps it unit-testable with a
// lightweight mock instead of a real (engine-backed) PrismaClient.
export type ReferenceClient = Pick<
  PrismaClient,
  'reference' | 'referenceCollection' | 'collectionItem'
>
type ReferenceClientProvider = () => Promise<ReferenceClient>

const parseJson = <T>(value: string | null): T | undefined => {
  if (value === null) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

const asAuthors = (value: string): ReferenceAuthor[] => {
  const parsed = parseJson<ReferenceAuthor[]>(value)
  return Array.isArray(parsed) ? parsed : []
}

const mapReference = (row: {
  id: string
  projectId: string
  title: string
  authorsJson: string
  venue: string | null
  year: number | null
  doi: string | null
  pmid: string | null
  pmcid: string | null
  arxivId: string | null
  url: string | null
  abstractSnippet: string | null
  sourceConnector: string
  sourceRecordId: string | null
  citationKey: string
  provenanceJson: string | null
  pdfManagedFileId: string | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
}): Reference => ({
  id: row.id,
  projectId: row.projectId,
  title: row.title,
  authors: asAuthors(row.authorsJson),
  venue: row.venue ?? undefined,
  year: row.year ?? undefined,
  doi: row.doi ?? undefined,
  pmid: row.pmid ?? undefined,
  pmcid: row.pmcid ?? undefined,
  arxivId: row.arxivId ?? undefined,
  url: row.url ?? undefined,
  abstractSnippet: row.abstractSnippet ?? undefined,
  sourceConnector: (row.sourceConnector as Reference['sourceConnector']) ?? 'manual',
  sourceRecordId: row.sourceRecordId ?? undefined,
  citationKey: row.citationKey,
  provenance: parseJson<ReferenceProvenance>(row.provenanceJson),
  pdfManagedFileId: row.pdfManagedFileId ?? undefined,
  notes: row.notes ?? undefined,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime()
})

const mapCollection = (row: {
  id: string
  projectId: string
  name: string
  description: string | null
  createdAt: Date
  updatedAt: Date
}): ReferenceCollection => ({
  id: row.id,
  projectId: row.projectId,
  name: row.name,
  description: row.description ?? undefined,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime()
})

const mapItem = (row: {
  id: string
  collectionId: string
  referenceId: string
  note: string | null
  sortIndex: number
  createdAt: Date
}): CollectionItem => ({
  id: row.id,
  collectionId: row.collectionId,
  referenceId: row.referenceId,
  note: row.note ?? undefined,
  sortIndex: row.sortIndex,
  createdAt: row.createdAt.getTime()
})

// Serializes the reference payload for storage. Empty JSON arrays serialize as '[]' (never null).
const serializeAuthors = (authors: ReferenceAuthor[] | undefined): string =>
  JSON.stringify(authors ?? [])

export const referenceColumns = {
  projectId: true,
  title: true,
  authorsJson: true,
  venue: true,
  year: true,
  doi: true,
  pmid: true,
  pmcid: true,
  arxivId: true,
  url: true,
  abstractSnippet: true,
  sourceConnector: true,
  sourceRecordId: true,
  citationKey: true,
  provenanceJson: true,
  pdfManagedFileId: true,
  notes: true,
  createdAt: true,
  updatedAt: true
} as const

// Owns Reference-library reads/writes (v1.51). The client is resolved lazily per call so
// schema-ensure failures can recover (same pattern as ComputeHostRepository).
export class ReferenceRepository {
  constructor(private readonly getClient: ReferenceClientProvider) {}

  async listReferences(projectId: string): Promise<Reference[]> {
    const client = await this.getClient()
    const rows = await client.reference.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' }
    })
    const references = rows.map(mapReference)
    if (references.length === 0) return references
    // Attach collection memberships in one extra query so the renderer can filter by collection
    // without an extra IPC surface.
    const items = await client.collectionItem.findMany({
      where: { referenceId: { in: references.map((reference) => reference.id) } }
    })
    const byReference = new Map<string, string[]>()
    for (const item of items) {
      const list = byReference.get(item.referenceId) ?? []
      list.push(item.collectionId)
      byReference.set(item.referenceId, list)
    }
    return references.map((reference) => {
      const collectionIds = byReference.get(reference.id)
      return collectionIds === undefined ? reference : { ...reference, collectionIds }
    })
  }

  async listReferencesByCollection(collectionId: string): Promise<Reference[]> {
    const client = await this.getClient()
    const items = await client.collectionItem.findMany({
      where: { collectionId },
      orderBy: { sortIndex: 'asc' }
    })
    if (items.length === 0) return []
    const rows = await client.reference.findMany({
      where: { id: { in: items.map((item) => item.referenceId) } }
    })
    const byId = new Map(rows.map((row) => [row.id, row]))
    return items
      .map((item) => byId.get(item.referenceId))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map(mapReference)
  }

  async getReference(id: string): Promise<Reference | null> {
    const client = await this.getClient()
    const row = await client.reference.findUnique({ where: { id } })
    return row ? mapReference(row) : null
  }

  // Creates a record. Callers generate the citationKey (service handles collision suffixes and
  // duplicate identity checks before calling). Duplicate key / identity surfaces as the raw
  // unique-constraint error from the engine — callers map it to a readable message.
  async createReference(input: CreateReferenceInput & { citationKey: string }): Promise<Reference> {
    const client = await this.getClient()
    const row = await client.reference.create({
      data: {
        projectId: input.projectId,
        title: input.title.trim(),
        authorsJson: serializeAuthors(input.authors),
        venue: input.venue?.trim() || null,
        year: input.year ?? null,
        doi: input.doi?.trim() || null,
        pmid: input.pmid?.trim() || null,
        pmcid: input.pmcid?.trim() || null,
        arxivId: input.arxivId?.trim() || null,
        url: input.url?.trim() || null,
        abstractSnippet: input.abstractSnippet ?? null,
        sourceConnector: input.sourceConnector ?? 'manual',
        sourceRecordId: input.sourceRecordId?.trim() || null,
        citationKey: input.citationKey,
        provenanceJson: input.provenance ? JSON.stringify(input.provenance) : null,
        notes: input.notes ?? null
      }
    })
    return mapReference(row)
  }

  async deleteReference(id: string): Promise<void> {
    const client = await this.getClient()
    // Remove membership rows first; the reference row itself has no FK constraints.
    await client.collectionItem.deleteMany({ where: { referenceId: id } })
    await client.reference.delete({ where: { id } })
  }

  async listCollections(projectId: string): Promise<ReferenceCollection[]> {
    const client = await this.getClient()
    const rows = await client.referenceCollection.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(mapCollection)
  }

  async createCollection(input: CreateReferenceCollectionInput): Promise<ReferenceCollection> {
    const client = await this.getClient()
    const row = await client.referenceCollection.create({
      data: {
        projectId: input.projectId,
        name: input.name.trim(),
        description: input.description?.trim() || null
      }
    })
    return mapCollection(row)
  }

  async deleteCollection(id: string): Promise<void> {
    const client = await this.getClient()
    await client.collectionItem.deleteMany({ where: { collectionId: id } })
    await client.referenceCollection.delete({ where: { id } })
  }

  async addToCollection(
    collectionId: string,
    referenceId: string,
    note?: string
  ): Promise<CollectionItem> {
    const client = await this.getClient()
    const existing = await client.collectionItem.findUnique({
      where: { collectionId_referenceId: { collectionId, referenceId } }
    })
    if (existing) return mapItem(existing)
    const maxRow = await client.collectionItem.findFirst({
      where: { collectionId },
      orderBy: { sortIndex: 'desc' }
    })
    const row = await client.collectionItem.create({
      data: {
        collectionId,
        referenceId,
        note: note ?? null,
        sortIndex: (maxRow?.sortIndex ?? -1) + 1
      }
    })
    return mapItem(row)
  }

  async removeFromCollection(collectionId: string, referenceId: string): Promise<void> {
    const client = await this.getClient()
    await client.collectionItem.deleteMany({ where: { collectionId, referenceId } })
  }

  // Enumerates the memberships of one reference across collections (merge support).
  async listMemberships(
    referenceId: string
  ): Promise<Array<{ collectionId: string; note: string | undefined }>> {
    const client = await this.getClient()
    const rows = await client.collectionItem.findMany({
      where: { referenceId },
      orderBy: { sortIndex: 'asc' }
    })
    return rows.map((row) => ({ collectionId: row.collectionId, note: row.note ?? undefined }))
  }

  // Updates notes and/or provenance on a record (merge support). Undefined values are left intact.
  async updateReference(
    id: string,
    changes: { notes?: string; provenance?: ReferenceProvenance }
  ): Promise<void> {
    const client = await this.getClient()
    await client.reference.update({
      where: { id },
      data: {
        ...(changes.notes !== undefined ? { notes: changes.notes } : {}),
        ...(changes.provenance !== undefined
          ? { provenanceJson: JSON.stringify(changes.provenance) }
          : {})
      }
    })
  }
}

export { mapReference }
