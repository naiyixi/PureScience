import { PdfAnnotationImportError } from '../../shared/pdf-annotation-import'
import { resolvePdfAnnotationAnchorState, type PdfAnnotation } from '../../shared/pdf-annotations'
import type {
  PdfAnnotationAnchor,
  PdfAnnotationAnchorCounts,
  PdfAnnotationAnchorRequest,
  PdfAnnotationCreateRequest,
  PdfAnnotationImportOutcome,
  PdfAnnotationListResult,
  PdfAnnotationReattachRequest,
  PdfAnnotationReattachResult,
  PdfAnnotationRemoveRequest,
  PdfAnnotationRemoveResult,
  PdfAnnotationView
} from '../../shared/pdf-annotation-surface'
import { importPdfEmbeddedAnnotations } from './pdf-annotation-import'
import type { PdfAnnotationRepository } from './pdf-annotation-repository'

// The annotation surface (文档标注层 A3): what the window can do to the store A1 owns, and nothing else.
//
// This layer exists because the renderer is the wrong place to answer three questions, and every one of
// them is a way the reader would be shown something untrue:
//
//   1. WHICH BYTES. The window says which file VERSION it is looking at; the version authority resolves
//      the content checksum and the bytes on disk. A checksum typed by the renderer would describe a
//      file nobody read, and the whole anchor rule is "the annotation belongs to the bytes it was drawn
//      on".
//   2. WHAT THE ANCHOR SAYS NOW. A read answers with every annotation of the file, each labelled
//      against the version on screen. An annotation of an earlier version is returned as
//      `version-changed`, not omitted — the reader is told their markup is on other bytes, and the
//      only way it moves is the explicit `reattach` below.
//   3. WHAT AN IMPORT DID. The import report is A2's own, passed through unscaled: counts per kind, and
//      every subtype left behind with its reason.

/** One file version as the version authority describes it: which version, and the digest of its bytes. */
export type ResolvedPdfAnnotationVersion = {
  versionId: string
  checksum: string
}

/**
 * Turns (project, session, artifact, version) into the version and its content checksum, or answers
 * nothing when that version is not one the store knows.
 *
 * Deliberately separate from `resolveVersionFile` below: the checksum is what addressing an annotation
 * needs, and reading the bytes to get it would read a whole PDF on every list. Absence is an answer
 * rather than an exception, because "the preview carries a version this store has never seen" is a state
 * the reader has to be told about by name.
 */
export type PdfAnnotationVersionResolver = (
  request: PdfAnnotationAnchorRequest
) => Promise<ResolvedPdfAnnotationVersion | undefined>

/** Locates the bytes of one version, verifying they still hash to its content checksum. */
export type PdfAnnotationVersionFileResolver = (
  request: PdfAnnotationAnchorRequest
) => Promise<string>

export type PdfAnnotationServiceDependencies = {
  repository: PdfAnnotationRepository
  resolveVersion: PdfAnnotationVersionResolver
  resolveVersionFile: PdfAnnotationVersionFileResolver
}

// Every request names all four identity facts. A request missing one is refused here rather than being
// resolved against a default: an annotation filed under an invented version is one nobody finds again.
const requireAnchorRequest = (request: PdfAnnotationAnchorRequest): void => {
  const missing = (
    [
      ['projectId', request.projectId],
      ['sessionId', request.sessionId],
      ['artifactId', request.artifactId],
      ['versionId', request.versionId]
    ] as const
  )
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new Error(
      `A PDF annotation request must name the file version it is about; ${missing.join(', ')} is missing.`
    )
  }
}

const compareIds = (left: PdfAnnotation, right: PdfAnnotation): number =>
  left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

export class PdfAnnotationService {
  constructor(private readonly dependencies: PdfAnnotationServiceDependencies) {}

  /**
   * Every annotation of one file, oldest first, each labelled by how its anchor compares to the version
   * on screen.
   *
   * The read is scoped to the FILE and not to the version on purpose: annotations of an earlier version
   * have to come back, named as `version-changed`, or the reader's markup would appear to have vanished
   * the first time the file was rewritten.
   */
  async list(request: PdfAnnotationAnchorRequest): Promise<PdfAnnotationListResult> {
    const { anchor } = await this.resolveAnchor(request)

    const annotatedVersionIds = await this.dependencies.repository.listAnnotatedVersions(
      anchor.sourceFileId
    )
    const annotations: PdfAnnotationView[] = []
    for (const versionId of annotatedVersionIds) {
      const rows = await this.dependencies.repository.listAnnotations({
        sourceFileId: anchor.sourceFileId,
        versionId
      })
      for (const annotation of rows) {
        annotations.push({
          annotation,
          anchorState: resolvePdfAnnotationAnchorState(annotation, {
            versionId: anchor.versionId,
            checksum: anchor.checksum
          })
        })
      }
    }
    annotations.sort((left, right) => compareIds(left.annotation, right.annotation))

    const counts: PdfAnnotationAnchorCounts = {
      current: 0,
      versionChanged: 0,
      checksumMismatch: 0
    }
    for (const view of annotations) {
      if (view.anchorState === 'current') counts.current += 1
      else if (view.anchorState === 'version-changed') counts.versionChanged += 1
      else counts.checksumMismatch += 1
    }

    return { anchor, annotations, counts }
  }

  /**
   * Writes one annotation against the version on screen.
   *
   * The kind/selector pair is checked by the store's own rule and refused with its named reason, so a
   * highlight carrying an area selector never reaches the table to be repaired later.
   */
  async create(request: PdfAnnotationCreateRequest): Promise<PdfAnnotation> {
    const { anchor } = await this.resolveAnchor(request)
    return this.dependencies.repository.createAnnotation({
      sourceFileId: anchor.sourceFileId,
      versionId: anchor.versionId,
      checksum: anchor.checksum,
      kind: request.kind,
      selector: request.selector,
      body: request.body
    })
  }

  async remove(request: PdfAnnotationRemoveRequest): Promise<PdfAnnotationRemoveResult> {
    if (!request.annotationId?.trim()) {
      throw new Error('Removing a PDF annotation needs the annotation id.')
    }
    return { removed: await this.dependencies.repository.deleteAnnotation(request.annotationId) }
  }

  /**
   * Copies ONE annotation onto the version on screen, because the reader asked for that one by name.
   *
   * The source annotation is not touched: it keeps its own version and checksum. This is deliberately
   * the only way markup crosses versions, and it is a write of a second annotation rather than a
   * re-point of the first — so the record of what was drawn on which bytes stays true.
   */
  async reattach(request: PdfAnnotationReattachRequest): Promise<PdfAnnotationReattachResult> {
    if (!request.annotationId?.trim()) {
      throw new Error('Re-anchoring a PDF annotation needs the annotation id.')
    }
    const { anchor } = await this.resolveAnchor(request)

    const source = await this.dependencies.repository.getAnnotation(request.annotationId)
    if (!source) {
      throw new Error(
        `PDF annotation ${request.annotationId} is not in the store, so there is nothing to re-anchor.`
      )
    }
    if (source.sourceFileId !== anchor.sourceFileId) {
      throw new Error(
        `PDF annotation ${source.id} belongs to file ${source.sourceFileId} and cannot be re-anchored onto file ${anchor.sourceFileId}.`
      )
    }
    if (source.versionId === anchor.versionId && source.checksum === anchor.checksum) {
      throw new Error(
        `PDF annotation ${source.id} is already anchored to this file version; re-anchoring it here would store the same markup twice.`
      )
    }

    const annotation = await this.dependencies.repository.createAnnotation({
      sourceFileId: anchor.sourceFileId,
      versionId: anchor.versionId,
      checksum: anchor.checksum,
      kind: source.kind,
      selector: source.selector,
      body: source.body
    })
    return { annotation, source }
  }

  /**
   * Imports the annotations the version's PDF carries inside itself, through the A2 channel.
   *
   * The report is returned as-is, so "imported 3 of 5" and "this file carries no annotations" reach the
   * window in A2's own words. A refusal (a file whose bytes no longer hash to the version's checksum, a
   * damaged PDF, an anchor that cannot be resolved) comes back as a named failure with nothing written.
   */
  async import(request: PdfAnnotationAnchorRequest): Promise<PdfAnnotationImportOutcome> {
    const { anchor } = await this.resolveAnchor(request)
    try {
      // The bytes are located through the version authority, which verifies on the way that they still
      // hash to the version's checksum. A2 checks the same digest again on the bytes it reads, so the
      // two gates are independent rather than one trusting the other.
      const filePath = await this.dependencies.resolveVersionFile(request)
      const report = await importPdfEmbeddedAnnotations(this.dependencies.repository, {
        sourceFileId: anchor.sourceFileId,
        versionId: anchor.versionId,
        checksum: anchor.checksum,
        payload: { filePath }
      })
      return { status: 'report', report }
    } catch (error) {
      if (error instanceof PdfAnnotationImportError) {
        return { status: 'failure', code: error.code, message: error.message }
      }
      throw error
    }
  }

  // The one place a request becomes an anchor. The version id and the checksum both come from the
  // version authority, so the window cannot point an annotation at bytes that were never read — and a
  // version it cannot resolve (a preview built from ids the store has never seen) is refused by name
  // rather than written against a placeholder.
  private async resolveAnchor(
    request: PdfAnnotationAnchorRequest
  ): Promise<{ anchor: PdfAnnotationAnchor; resolved: ResolvedPdfAnnotationVersion }> {
    requireAnchorRequest(request)
    const resolved = await this.dependencies.resolveVersion(request)
    const versionId = (resolved?.versionId ?? '').trim()
    const checksum = (resolved?.checksum ?? '').trim().toLowerCase()
    if (!versionId || !checksum) {
      throw new Error(
        `Version ${request.versionId} of artifact ${request.artifactId} is not one this store knows, so no annotation was stored or read against it.`
      )
    }
    return {
      anchor: { sourceFileId: request.artifactId, versionId, checksum },
      resolved: { versionId, checksum }
    }
  }
}
