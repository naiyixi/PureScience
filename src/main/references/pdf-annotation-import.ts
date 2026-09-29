import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { PdfAnnotationImportSourceKind } from '../../shared/pdf-annotations'
import {
  PdfAnnotationImportError,
  mapEmbeddedPdfAnnotation,
  summarizeEmbeddedImport,
  type PdfEmbeddedAnnotationImportReport,
  type PdfImportedPage
} from '../../shared/pdf-annotation-import'
import type { PdfAnnotationRepository } from './pdf-annotation-repository'
import {
  readPdfEmbeddedAnnotations,
  type PdfParsedAnnotations
} from './pdf-embedded-annotation-reader'

// The import channel (文档标注层 A2): a PDF that is already attached to a record, and the markup it
// carries inside itself, become annotations of ours — anchored to that file VERSION, written into the
// A1 store, and recorded with an import receipt. Two properties do the work here:
//
//   * the anchor is checked before anything else. The bytes handed in are hashed, and bytes that do not
//     hash to the checksum the caller named are REFUSED: importing markup onto an anchor that does not
//     describe those bytes would file a reader's highlight under a version it was never drawn on — the
//     one thing the version anchor exists to prevent. The digest of those same bytes is also the
//     idempotency key, so the two questions ("is this the version you say it is?" and "have we imported
//     this payload already?") are answered by the same hash.
//   * nothing is written until everything is known. The file is parsed, every annotation is mapped, and
//     only then does the first write happen — a damaged PDF, or one whose markup cannot be placed,
//     never leaves half an import behind.
//
// And what is NOT imported is named. The report carries the count per kind, and every subtype that was
// left behind with its reason: a file that yields five highlights and three kinds we cannot place says
// exactly that.

export const PDF_ANNOTATION_EMBEDDED_SOURCE_KIND: PdfAnnotationImportSourceKind = 'embedded-pdf'

/** Where the bytes of the version come from. */
export type PdfAnnotationImportPayload = { filePath: string } | { bytes: Uint8Array }

export type PdfAnnotationImportRequest = {
  /** The managed file the PDF is attached to. */
  sourceFileId: string
  /** The immutable version the annotations will be anchored to. */
  versionId: string
  /** That version's content checksum as the files layer recorded it (sha256 hex). */
  checksum: string
  payload: PdfAnnotationImportPayload
  /** Stamped on the annotations and the receipt; defaults to now. */
  importedAt?: number
}

export type PdfAnnotationImportPorts = {
  repository: PdfAnnotationRepository
  /** Defaults to the real pdfjs read (main process). */
  parse?: (bytes: Uint8Array) => Promise<PdfParsedAnnotations>
  /** Defaults to reading the payload's bytes from disk. */
  readBytes?: (payload: PdfAnnotationImportPayload) => Promise<Uint8Array>
}

const readPayloadBytes = async (payload: PdfAnnotationImportPayload): Promise<Uint8Array> =>
  'bytes' in payload ? payload.bytes : new Uint8Array(await readFile(payload.filePath))

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

// Every write here is addressed by (file, version) plus that version's checksum, so all three must be
// present before a byte is read. Refused as one failure: an import that ran "almost" anchored would be
// an annotation nobody can find again.
const requireAnchor = (
  request: PdfAnnotationImportRequest
): {
  sourceFileId: string
  versionId: string
  checksum: string
} => {
  const sourceFileId = (request.sourceFileId ?? '').trim()
  const versionId = (request.versionId ?? '').trim()
  const checksum = (request.checksum ?? '').trim().toLowerCase()
  if (!sourceFileId || !versionId || !checksum) {
    const missing = [
      ...(sourceFileId ? [] : ['sourceFileId']),
      ...(versionId ? [] : ['versionId']),
      ...(checksum ? [] : ['checksum'])
    ].join(', ')
    throw new PdfAnnotationImportError(
      'missing-anchor',
      `An import must be anchored to one file version; ${missing} is missing. Nothing was imported.`
    )
  }
  // Stored lowercase because a sha256 checksum is written lowercase everywhere else in the app, and a
  // case difference would later read back as the anchor having been broken.
  return { sourceFileId, versionId, checksum }
}

/**
 * Imports the annotations a PDF carries into the A1 store, anchored to one file version.
 *
 * Outcomes, all of them explicit in the returned report:
 *   * `imported` — N annotations written of M in the file; the rest are named in `skipped`;
 *   * `no-annotations` — the file carries none. Not a success with zero rows: the answer to "import my
 *     markup" is "this file has no markup", and no receipt is written for it;
 *   * `no-supported-annotations` — the file carries annotations, but not one this build can place; each
 *     subtype is named with its count and reason;
 *   * `unchanged` — this exact payload was already imported into this version (the receipt is the
 *     proof); nothing is re-read and nothing is written twice.
 *
 * Throws `PdfAnnotationImportError` (`missing-anchor` / `checksum-mismatch` / `unreadable-pdf`) instead
 * of a report when the import must not happen at all — in every one of those cases before the first
 * write.
 */
export const importEmbeddedPdfAnnotations = async (
  ports: PdfAnnotationImportPorts,
  request: PdfAnnotationImportRequest
): Promise<PdfEmbeddedAnnotationImportReport> => {
  const { sourceFileId, versionId, checksum } = requireAnchor(request)
  const { repository } = ports
  const parse = ports.parse ?? readPdfEmbeddedAnnotations
  const readBytes = ports.readBytes ?? readPayloadBytes

  const bytes = await readBytes(request.payload)
  const digest = sha256Hex(bytes)

  if (digest !== checksum) {
    throw new PdfAnnotationImportError(
      'checksum-mismatch',
      `These bytes are not version "${versionId}" of file "${sourceFileId}": they hash to ${digest}, while the version's checksum is ${checksum}. Nothing was imported — annotations filed under that anchor would sit on bytes they were never drawn on.`
    )
  }

  // Idempotency, before any parsing: the payload digest is the key, so a second import of the same file
  // into the same version is answered from the receipt and never touches the store again.
  const existing = await repository.getImport({
    sourceKind: PDF_ANNOTATION_EMBEDDED_SOURCE_KIND,
    sourceFileId,
    versionId,
    digest
  })
  if (existing) {
    return {
      sourceKind: PDF_ANNOTATION_EMBEDDED_SOURCE_KIND,
      sourceFileId,
      versionId,
      checksum,
      digest,
      status: 'unchanged',
      imported: 0,
      kinds: [],
      skipped: [],
      pageCount: 0,
      annotationsInFile: 0,
      receipt: existing,
      receiptCreated: false
    }
  }

  const parsed = await parse(bytes)
  const pagesByNumber = new Map<number, PdfImportedPage>(
    parsed.pages.map((page) => [page.number, page])
  )
  const mappings = parsed.annotations.map((annotation) =>
    mapEmbeddedPdfAnnotation(annotation, pagesByNumber.get(annotation.page))
  )
  const summary = summarizeEmbeddedImport(mappings)

  const base = {
    sourceKind: PDF_ANNOTATION_EMBEDDED_SOURCE_KIND,
    sourceFileId,
    versionId,
    checksum,
    digest
  }
  const counts = {
    imported: summary.imported,
    kinds: summary.kinds,
    skipped: summary.skipped,
    pageCount: parsed.pageCount,
    annotationsInFile: parsed.annotations.length
  }

  // The file carried nothing importable. Both of these are reported rather than swallowed: "no
  // annotations at all" and "annotations, none of which this build can place" are different answers,
  // and neither is a success. No receipt is written — a receipt says an import happened, and nothing
  // was imported.
  if (summary.imported === 0) {
    return {
      ...base,
      ...counts,
      status: parsed.annotations.length === 0 ? 'no-annotations' : 'no-supported-annotations',
      receiptCreated: false
    }
  }

  const importedAt = request.importedAt ?? Date.now()

  // The writes come before the receipt, and that order is deliberate: a receipt is a statement that
  // these annotations were imported, so a crash between the two must not leave a receipt claiming an
  // import that only half happened. The other way round is the recoverable error — annotations without
  // their receipt are visible, and deleting them is one call.
  for (const mapping of mappings) {
    if (!mapping.ok) continue
    await repository.createAnnotation({
      sourceFileId,
      versionId,
      checksum,
      kind: mapping.content.kind,
      selector: mapping.content.selector,
      body: mapping.content.body,
      createdAt: importedAt
    })
  }

  const { record, created } = await repository.recordImport({
    sourceKind: PDF_ANNOTATION_EMBEDDED_SOURCE_KIND,
    sourceFileId,
    versionId,
    digest,
    importedAt
  })
  // If two callers raced the same payload, both wrote their annotations and one of them lost the
  // receipt write to the unique index; that error is allowed to surface rather than being dressed up as
  // `unchanged`, because it is not true that nothing was written. The main process is the only writer,
  // and every import is anchored to one version, so nothing in the app produces that race today.

  return { ...base, ...counts, status: 'imported', receipt: record, receiptCreated: created }
}

/**
 * The channel as the app wires it: the real parser, the bytes read off disk. `importEmbeddedPdfAnnotations`
 * is the same code with the parser and the reader injectable, which is how its tests drive it.
 */
export const importPdfEmbeddedAnnotations = (
  repository: PdfAnnotationRepository,
  request: PdfAnnotationImportRequest
): Promise<PdfEmbeddedAnnotationImportReport> =>
  importEmbeddedPdfAnnotations({ repository }, request)
