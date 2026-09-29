import type {
  PdfAnnotationImportFailureCode,
  PdfEmbeddedAnnotationImportReport
} from './pdf-annotation-import'
import type {
  PdfAnnotation,
  PdfAnnotationAnchorState,
  PdfAnnotationKind,
  PdfAnnotationSelector
} from './pdf-annotations'

// The renderer's view of the annotation store (文档标注层 A3). A1 owns the record and the anchor rule,
// A2 owns the import channel; what lives here is only the SHAPE that crosses the IPC boundary, so the
// window and the main process agree on it in one place instead of on two hand-written copies.
//
// Two decisions are visible in these types, and both of them are about refusing to lose information:
//
//   * the renderer never names a checksum. It says which file version it is looking at (project,
//     session, artifact, version) and the main process resolves the content checksum from the VERSION
//     authority — the same resolver the preview reads through. A renderer-supplied checksum could only
//     be a guess about bytes it has not read.
//   * a read answers with EVERY annotation of the file, each labelled by how its anchor compares to the
//     version on screen (`anchorState`). An annotation that belongs to an earlier version is therefore
//     returned with the named state `version-changed` rather than filtered out, because "the reader drew
//     something here and it is not on these bytes" is a fact the reader has to be told.

/** The four identity facts that address one file version. */
export type PdfAnnotationAnchorRequest = {
  projectId: string
  sessionId: string
  artifactId: string
  versionId: string
}

/** One annotation plus how its anchor compares to the version the reader is looking at. */
export type PdfAnnotationView = {
  annotation: PdfAnnotation
  anchorState: PdfAnnotationAnchorState
}

/** How many annotations fall into each anchor state. The three add up to `annotations.length`. */
export type PdfAnnotationAnchorCounts = {
  current: number
  versionChanged: number
  checksumMismatch: number
}

export type PdfAnnotationAnchor = {
  sourceFileId: string
  versionId: string
  checksum: string
}

export type PdfAnnotationListRequest = PdfAnnotationAnchorRequest

export type PdfAnnotationListResult = {
  /** The version on screen, as the version authority describes it. */
  anchor: PdfAnnotationAnchor
  /** Every annotation of this file, oldest first, each with its own named anchor state. */
  annotations: readonly PdfAnnotationView[]
  counts: PdfAnnotationAnchorCounts
}

export type PdfAnnotationCreateRequest = PdfAnnotationAnchorRequest & {
  kind: string
  selector: unknown
  body?: string
}

export type PdfAnnotationRemoveRequest = {
  annotationId: string
}

export type PdfAnnotationRemoveResult = {
  /** False when the annotation was already gone; the store reports what it removed. */
  removed: boolean
}

/**
 * Copies ONE annotation onto the version on screen, because the reader asked for it by name.
 *
 * This is the explicit half of "nothing is migrated silently": the annotation on the earlier version
 * stays exactly where it is, and a second annotation is written against the current version's checksum.
 * A re-point of the original (the silent version of this) is not offered anywhere.
 */
export type PdfAnnotationReattachRequest = PdfAnnotationAnchorRequest & {
  annotationId: string
}

export type PdfAnnotationReattachResult = {
  /** The annotation as it is now anchored to the version on screen. */
  annotation: PdfAnnotation
  /** The annotation it was copied from, left untouched. */
  source: PdfAnnotation
}

export type PdfAnnotationImportRequest = PdfAnnotationAnchorRequest

/**
 * What an import attempt answers with.
 *
 * `report` is A2's own honest report, passed through unchanged: the counts per kind, and every subtype
 * the file carried that this build could not place, with its reason. `failure` is the other outcome —
 * a refusal that happened before the first write (a broken anchor, bytes that are not the version
 * named, a file the parser refuses) — returned as a value with its named code rather than thrown, so
 * the reader sees the same panel either way.
 */
export type PdfAnnotationImportOutcome =
  | { status: 'report'; report: PdfEmbeddedAnnotationImportReport }
  | { status: 'failure'; code: PdfAnnotationImportFailureCode; message: string }

export type { PdfAnnotationKind, PdfAnnotationSelector }
