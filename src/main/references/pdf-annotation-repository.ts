import type { PrismaClient } from '@prisma/client'

import type {
  PdfAnnotation,
  PdfAnnotationImport,
  PdfAnnotationImportSourceKind,
  PdfAnnotationKind,
  PdfAnnotationSelector
} from '../../shared/pdf-annotations'
import {
  isPdfAnnotationImportSourceKind,
  validatePdfAnnotationContent
} from '../../shared/pdf-annotations'

// Storage for PDF annotations (文档标注层 A1). Three invariants are enforced here rather than left to
// callers, because each one is a way an annotation library quietly becomes wrong:
//
//   1. the anchor is the file VERSION — every read and every delete is scoped by (sourceFileId,
//      versionId), and a write refuses to proceed without the version id and its content checksum. A
//      newer version of the same file therefore carries none of the old version's annotations, and
//      nothing is re-pointed behind the reader's back;
//   2. kind and selector shape must agree — a write whose kind and selector disagree is refused with
//      the validator's named reason, and a stored row that disagrees (written outside this layer) is
//      refused on READ too, instead of being relabelled into a kind it is not;
//   3. the import receipt is idempotent and independent — the idempotency key is unique (so importing
//      the same payload into the same version records one receipt), and nothing links a receipt to an
//      annotation, so clearing either leaves the other exactly as it was.
//
// Only the two delegates this repository needs are typed, so it is unit-testable with a lightweight
// mock instead of a real (engine-backed) PrismaClient — the same seam the reference and screening
// repositories use.
export type PdfAnnotationClient = Pick<PrismaClient, 'pdfAnnotation' | 'pdfAnnotationImport'>
type PdfAnnotationClientProvider = () => Promise<PdfAnnotationClient>

// Row shapes as SQLite hands them back, declared explicitly so the mappers can be exercised with plain
// fixtures instead of the engine's inference.
export type StoredPdfAnnotationRow = {
  id: string
  sourceFileId: string
  versionId: string
  checksum: string
  kind: string
  selectorJson: string
  body: string
  createdAt: Date
}
export type StoredPdfAnnotationImportRow = {
  id: string
  sourceKind: string
  sourceFileId: string
  versionId: string
  importedAt: Date
  digest: string
}

const parseSelectorJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

// Row → domain. A row that violates invariant 2 is refused loudly: the annotation library is the one
// place where guessing at an anchor would silently move a highlight onto different bytes.
export const mapPdfAnnotation = (row: StoredPdfAnnotationRow): PdfAnnotation => {
  const selector = parseSelectorJson(row.selectorJson)
  const failure = validatePdfAnnotationContent({
    kind: row.kind,
    selector,
    body: row.body
  })
  if (failure) {
    throw new Error(
      `Stored PDF annotation ${row.id} is inconsistent and cannot be read: ${failure.message}`
    )
  }
  return {
    id: row.id,
    sourceFileId: row.sourceFileId,
    versionId: row.versionId,
    checksum: row.checksum,
    kind: row.kind as PdfAnnotationKind,
    selector: selector as PdfAnnotationSelector,
    body: row.body,
    createdAt: row.createdAt.getTime()
  }
}

export const mapPdfAnnotationImport = (row: StoredPdfAnnotationImportRow): PdfAnnotationImport => {
  if (!isPdfAnnotationImportSourceKind(row.sourceKind)) {
    throw new Error(
      `Stored PDF annotation import ${row.id} names source kind "${row.sourceKind}", which is not one of the known import channels.`
    )
  }
  return {
    id: row.id,
    sourceKind: row.sourceKind,
    sourceFileId: row.sourceFileId,
    versionId: row.versionId,
    digest: row.digest,
    importedAt: row.importedAt.getTime()
  }
}

// The version an annotation belongs to. Named as a type because every operation takes all three: an
// annotation is never addressed by file alone and never by version alone.
export type PdfAnnotationVersionAnchor = {
  sourceFileId: string
  versionId: string
}

export type PdfAnnotationWriteAnchor = PdfAnnotationVersionAnchor & {
  checksum: string
}

export type CreatePdfAnnotationInput = PdfAnnotationWriteAnchor & {
  kind: string
  selector: unknown
  body?: string
  createdAt?: number
}

export type RecordPdfAnnotationImportInput = PdfAnnotationVersionAnchor & {
  sourceKind: string
  digest: string
  importedAt?: number
}

export type ListPdfAnnotationImportsFilter = {
  sourceFileId?: string
  versionId?: string
}

// A write without a version id would produce an annotation that follows the file as it changes — the
// exact behaviour the version anchor exists to prevent — so it is refused rather than defaulted.
const requireWriteAnchor = (anchor: PdfAnnotationWriteAnchor): void => {
  if (!anchor.sourceFileId?.trim()) {
    throw new Error(
      'A PDF annotation must name the source file it belongs to (sourceFileId); an annotation that names no file cannot be found again.'
    )
  }
  if (!anchor.versionId?.trim()) {
    throw new Error(
      'A PDF annotation must name the file version it was drawn on (versionId); without one it would silently follow the file as its bytes change.'
    )
  }
  if (!anchor.checksum?.trim()) {
    throw new Error(
      'A PDF annotation must carry the content checksum of the version it was drawn on; without one a version whose bytes changed cannot be told apart from the version the annotation was written against.'
    )
  }
}

const requireVersionAnchor = (anchor: PdfAnnotationVersionAnchor, what: string): void => {
  if (!anchor.sourceFileId?.trim() || !anchor.versionId?.trim()) {
    throw new Error(
      `${what} is addressed by (sourceFileId, versionId); ${anchor.sourceFileId?.trim() ? 'versionId' : 'sourceFileId'} is missing.`
    )
  }
}

export class PdfAnnotationRepository {
  constructor(private readonly getClient: PdfAnnotationClientProvider) {}

  // --- annotations: written against one version, read against one version ---------------------------------

  // Writes one annotation. The kind/selector pair is checked as a pair: a highlight with an area
  // selector, a document note carrying a page, an unknown kind or a selector written by a newer build
  // are all refused with a named reason, and nothing is stored to be repaired later.
  async createAnnotation(input: CreatePdfAnnotationInput): Promise<PdfAnnotation> {
    const client = await this.getClient()
    requireWriteAnchor(input)

    const failure = validatePdfAnnotationContent({
      kind: input.kind,
      selector: input.selector,
      body: input.body
    })
    if (failure) {
      throw new Error(`PDF annotation refused (${failure.code}): ${failure.message}`)
    }

    const row = await client.pdfAnnotation.create({
      data: {
        sourceFileId: input.sourceFileId.trim(),
        versionId: input.versionId.trim(),
        checksum: input.checksum.trim(),
        kind: input.kind,
        selectorJson: JSON.stringify(input.selector),
        body: input.body ?? '',
        createdAt: new Date(input.createdAt ?? Date.now())
      }
    })
    return mapPdfAnnotation(row as StoredPdfAnnotationRow)
  }

  // Every annotation of one file VERSION, oldest first. `kind` narrows to one kind using the
  // (sourceFileId, versionId, kind) index; the version prefix is what keeps a version switch cheap.
  async listAnnotations(
    anchor: PdfAnnotationVersionAnchor,
    options: { kind?: PdfAnnotationKind } = {}
  ): Promise<PdfAnnotation[]> {
    const client = await this.getClient()
    requireVersionAnchor(anchor, 'A PDF annotation read')
    const rows = await client.pdfAnnotation.findMany({
      where: {
        sourceFileId: anchor.sourceFileId,
        versionId: anchor.versionId,
        ...(options.kind === undefined ? {} : { kind: options.kind })
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
    return rows.map((row) => mapPdfAnnotation(row as StoredPdfAnnotationRow))
  }

  /**
   * The annotations of MANY file versions at once, for a caller that has a set of anchors rather than
   * one (文档标注层 A5: the search corpus of a project).
   *
   * One query rather than one per anchor, for the same reason the version prefix is on every index: a
   * caller holding a project's files should not pay a round-trip per file. The result reports whether the
   * bound was reached — a truncated corpus that did not say so would read as the whole annotation
   * library, which is exactly what a search must never imply.
   *
   * An empty anchor list is answered with nothing and no error: "this project has no annotated file
   * versions" is a fact, not a failure.
   */
  async listAnnotationsForFileVersions(
    anchors: readonly PdfAnnotationVersionAnchor[],
    options: { limit: number }
  ): Promise<{ annotations: PdfAnnotation[]; bounded: boolean }> {
    const client = await this.getClient()
    if (anchors.length === 0) return { annotations: [], bounded: false }
    for (const anchor of anchors) requireVersionAnchor(anchor, 'A PDF annotation search read')

    const limit = Math.max(1, Math.floor(options.limit))
    // One row past the bound: what proves the corpus was larger than what is handed back is a row that
    // exists, not an inference from the count.
    const rows = await client.pdfAnnotation.findMany({
      where: {
        OR: anchors.map((anchor) => ({
          sourceFileId: anchor.sourceFileId,
          versionId: anchor.versionId
        }))
      },
      orderBy: [{ sourceFileId: 'asc' }, { versionId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1
    })

    return {
      annotations: rows
        .slice(0, limit)
        .map((row) => mapPdfAnnotation(row as StoredPdfAnnotationRow)),
      bounded: rows.length > limit
    }
  }

  async countAnnotations(anchor: PdfAnnotationVersionAnchor): Promise<number> {
    const client = await this.getClient()
    requireVersionAnchor(anchor, 'A PDF annotation count')
    return client.pdfAnnotation.count({
      where: { sourceFileId: anchor.sourceFileId, versionId: anchor.versionId }
    })
  }

  async getAnnotation(id: string): Promise<PdfAnnotation | null> {
    const client = await this.getClient()
    const row = await client.pdfAnnotation.findUnique({ where: { id } })
    return row ? mapPdfAnnotation(row as StoredPdfAnnotationRow) : null
  }

  // Which versions of one file carry annotations. This is the version-switch read: after a file moves
  // to a new version it returns the earlier version's id, and the caller can say "these annotations
  // are on version N, not on the one you are looking at" instead of showing nothing or showing the
  // wrong drawings. Deduplicated here rather than in SQL so the query stays a single indexed scan of
  // the (sourceFileId, versionId) prefix.
  async listAnnotatedVersions(sourceFileId: string): Promise<string[]> {
    const client = await this.getClient()
    if (!sourceFileId?.trim()) {
      throw new Error('listAnnotatedVersions needs a sourceFileId.')
    }
    const rows = await client.pdfAnnotation.findMany({
      where: { sourceFileId },
      select: { versionId: true },
      orderBy: { versionId: 'asc' }
    })
    return [...new Set(rows.map((row) => row.versionId))]
  }

  // --- deletion: annotations only, never the receipts that recorded how they got there -------------------

  async deleteAnnotation(id: string): Promise<boolean> {
    const client = await this.getClient()
    const { count } = await client.pdfAnnotation.deleteMany({ where: { id } })
    return count > 0
  }

  // Clears one version's annotations and reports how many it removed. It leaves the import receipts of
  // that same import alone: a receipt says an import happened, which stays true after the annotations
  // are gone.
  async deleteAnnotationsForVersion(anchor: PdfAnnotationVersionAnchor): Promise<number> {
    const client = await this.getClient()
    requireVersionAnchor(anchor, 'A PDF annotation purge')
    const { count } = await client.pdfAnnotation.deleteMany({
      where: { sourceFileId: anchor.sourceFileId, versionId: anchor.versionId }
    })
    return count
  }

  async deleteAnnotationsForFile(sourceFileId: string): Promise<number> {
    const client = await this.getClient()
    if (!sourceFileId?.trim()) throw new Error('deleteAnnotationsForFile needs a sourceFileId.')
    const { count } = await client.pdfAnnotation.deleteMany({ where: { sourceFileId } })
    return count
  }

  async deleteAllAnnotations(): Promise<number> {
    const client = await this.getClient()
    const { count } = await client.pdfAnnotation.deleteMany({})
    return count
  }

  // --- import receipts: idempotent, and alive independently of the annotations ---------------------------

  // Records one import. Importing the same payload (same digest) from the same channel into the same
  // version is not an error and does not stack a second receipt: the existing one is returned with
  // created=false. Two different versions, or two different files, legitimately carry their own
  // receipt even when the payload is byte-identical — which is why the digest is unique per anchor
  // rather than globally. The unique index is the backstop: even if two callers race past the lookup
  // below, the database refuses the duplicate row.
  async recordImport(
    input: RecordPdfAnnotationImportInput
  ): Promise<{ record: PdfAnnotationImport; created: boolean }> {
    const client = await this.getClient()
    requireVersionAnchor(input, 'A PDF annotation import receipt')
    if (!isPdfAnnotationImportSourceKind(input.sourceKind)) {
      throw new Error(
        `PDF annotation import refused (unknown-source-kind): "${input.sourceKind}" is not a known import channel.`
      )
    }
    if (!input.digest?.trim()) {
      throw new Error(
        'A PDF annotation import receipt must carry the digest of the imported payload; without one a repeated import cannot be recognized.'
      )
    }

    const sourceKind: PdfAnnotationImportSourceKind = input.sourceKind
    const key = {
      sourceKind,
      sourceFileId: input.sourceFileId,
      versionId: input.versionId,
      digest: input.digest
    }
    const existing = await client.pdfAnnotationImport.findUnique({
      where: { sourceKind_sourceFileId_versionId_digest: key }
    })
    if (existing) {
      return {
        record: mapPdfAnnotationImport(existing as StoredPdfAnnotationImportRow),
        created: false
      }
    }

    const row = await client.pdfAnnotationImport.create({
      data: { ...key, importedAt: new Date(input.importedAt ?? Date.now()) }
    })
    return { record: mapPdfAnnotationImport(row as StoredPdfAnnotationImportRow), created: true }
  }

  async getImport(input: RecordPdfAnnotationImportInput): Promise<PdfAnnotationImport | null> {
    const client = await this.getClient()
    requireVersionAnchor(input, 'A PDF annotation import receipt')
    // Unlike a write, this read tolerates a channel this build does not know: it cannot store
    // something untrue, and "no receipt from that channel" is the honest answer to the question asked.
    const row = await client.pdfAnnotationImport.findUnique({
      where: {
        sourceKind_sourceFileId_versionId_digest: {
          sourceKind: input.sourceKind as PdfAnnotationImportSourceKind,
          sourceFileId: input.sourceFileId,
          versionId: input.versionId,
          digest: input.digest
        }
      }
    })
    return row ? mapPdfAnnotationImport(row as StoredPdfAnnotationImportRow) : null
  }

  async listImports(filter: ListPdfAnnotationImportsFilter = {}): Promise<PdfAnnotationImport[]> {
    const client = await this.getClient()
    const rows = await client.pdfAnnotationImport.findMany({
      where: {
        ...(filter.sourceFileId === undefined ? {} : { sourceFileId: filter.sourceFileId }),
        ...(filter.versionId === undefined ? {} : { versionId: filter.versionId })
      },
      orderBy: [{ importedAt: 'asc' }, { id: 'asc' }]
    })
    return rows.map((row) => mapPdfAnnotationImport(row as StoredPdfAnnotationImportRow))
  }

  // Drops one receipt and reports whether it existed. The annotations that import brought in are
  // untouched: undoing the bookkeeping is not undoing the annotations.
  async deleteImport(id: string): Promise<boolean> {
    const client = await this.getClient()
    const { count } = await client.pdfAnnotationImport.deleteMany({ where: { id } })
    return count > 0
  }

  async deleteImportsForVersion(anchor: PdfAnnotationVersionAnchor): Promise<number> {
    const client = await this.getClient()
    requireVersionAnchor(anchor, 'A PDF annotation import purge')
    const { count } = await client.pdfAnnotationImport.deleteMany({
      where: { sourceFileId: anchor.sourceFileId, versionId: anchor.versionId }
    })
    return count
  }

  async deleteAllImports(): Promise<number> {
    const client = await this.getClient()
    const { count } = await client.pdfAnnotationImport.deleteMany({})
    return count
  }
}
