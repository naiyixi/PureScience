import {
  alignPdfAnnotationCitationsWithScreeningExport,
  buildPdfAnnotationCitation,
  type AnnotationCitationAlignment,
  type AnnotationCitationInput,
  type AnnotationCitationReference
} from '../../../../shared/pdf-annotation-citation'
import type { ScreeningExportScope } from '../../../../shared/references-screening-export'
import type { ProjectFileItem } from '../../../../shared/project-files'
import type { Reference } from '../../../../shared/references'

// Reading the annotation EVIDENCE of a triage export range (文档标注层 A5 接线): the step between "these
// records are in the bibliography" and "here is the markup each of them rests on".
//
// Three decisions are the whole module:
//
//   1. the range is the caller's own `ScreeningExportScope` and nothing else. Every record of the
//      COLLECTION is read — not just the included ones — because a record the range kept out has to be
//      reported as kept out (`reference-not-in-export-range`), and that report cannot be produced by
//      never looking. Alignment then happens once, in the shared module that the annotation chain
//      already owns, so the range is read by one rule rather than filtered twice.
//   2. the annotation reads are per FILE VERSION, addressed the way every other annotation read is: the
//      four identity facts the window has (project, session, artifact, version) and a checksum the MAIN
//      process resolves. The window never names a checksum, and never reads the PDF: the citation is
//      built from what the store holds (A5's 「只读已存文本」), which is what makes it re-findable.
//   3. what cannot be read is NAMED. A record with a PDF that is not in the project's file index, or a
//      read the main process refused, ends up in `gaps` with the reason — never as a record that merely
//      looks like it had nothing to cite.

/** One record whose annotations could not be read at all: the export states this instead of assuming none. */
export type ScreeningExportCitationGap = {
  referenceId: string
  /** The record's title, as the reviewer knows it: a gap has to be attributable to a line of the list. */
  title: string
  reason: 'file-not-in-index' | 'read-failed'
  /** The main process's own message for a refused read; '' for a file the index does not hold. */
  message: string
}

export type ScreeningExportCitationRead = {
  alignment: AnnotationCitationAlignment
  /** Records with a PDF whose annotations could not be read, in collection order. */
  gaps: readonly ScreeningExportCitationGap[]
  /** The records whose annotations were actually read, in collection order. */
  readReferenceIds: readonly string[]
}

// One page of the project file index. The cap below is a loop guard, not a filter: a walk that hit it
// would be reporting a partial picture as a complete one, so it refuses instead.
const FILE_PAGE_LIMIT = 100
const MAX_FILE_PAGES = 400

/**
 * Every file of the project's index, keyed the way a record names its PDF (`ProjectFileItem.id`).
 *
 * The index is walked to its end rather than sampled: an annotation read needs the file's session and its
 * current version, and a record whose file was never reached would look exactly like a record with no
 * annotations. A cursor that does not advance, or an index larger than the guard allows, throws — the
 * caller then writes no file at all, which is the honest outcome of "the evidence could not be read".
 */
const loadProjectFiles = async (projectId: string): Promise<Map<string, ProjectFileItem>> => {
  const files = new Map<string, ProjectFileItem>()
  let cursor: string | undefined
  let pages = 0
  for (;;) {
    const page = await window.api.projectFiles.listFiles({
      projectId,
      collection: { kind: 'all' },
      limit: FILE_PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor })
    })
    for (const item of page.items) files.set(item.id, item)
    if (page.nextCursor === undefined) return files
    if (page.nextCursor === cursor) {
      throw new Error(
        'The project file index did not advance while the annotation evidence was being read, so nothing was exported.'
      )
    }
    cursor = page.nextCursor
    pages += 1
    if (pages >= MAX_FILE_PAGES) {
      throw new Error(
        `The project file index is larger than this export walks (${MAX_FILE_PAGES * FILE_PAGE_LIMIT} files), so the annotation evidence could not be read in full and nothing was exported.`
      )
    }
  }
}

const toCitationReference = (reference: Reference): AnnotationCitationReference => ({
  id: reference.id,
  title: reference.title,
  authors: reference.authors.map((author) => ({ name: author.name })),
  venue: reference.venue,
  year: reference.year,
  doi: reference.doi,
  arxivId: reference.arxivId,
  pmid: reference.pmid,
  pmcid: reference.pmcid
})

export const readScreeningExportCitations = async (input: {
  /** The project whose file index the reads go through. Absent is refused by name, not defaulted. */
  projectId: string | undefined
  /** The range the export may contain — the SAME object the bibliography is built from. */
  scope: ScreeningExportScope
  /** Every record of the collection, so a record outside the range is reported rather than ignored. */
  collectionReferenceIds: readonly string[]
  /** The records of the window's list, by id: where `pdfManagedFileId` and the bibliographic fields live. */
  references: readonly Reference[]
}): Promise<ScreeningExportCitationRead> => {
  const projectId = input.projectId?.trim()
  if (!projectId) {
    throw new Error(
      'Reading the annotation evidence of an export needs the project it belongs to, and none was named, so nothing was exported.'
    )
  }
  const files = await loadProjectFiles(projectId)
  const byReference = new Map(input.references.map((reference) => [reference.id, reference]))
  const citations: AnnotationCitationInput[] = []
  const gaps: ScreeningExportCitationGap[] = []
  const readReferenceIds: string[] = []

  for (const referenceId of input.collectionReferenceIds) {
    const reference = byReference.get(referenceId)
    // A record with no file carries no annotation: an annotation is anchored to a file version, so
    // nothing is being left out by not reading one.
    const fileId = reference?.pdfManagedFileId
    if (!reference || !fileId) continue

    const item = files.get(fileId)
    const versionId = item?.sourceVersionId
    if (!item || !versionId) {
      gaps.push({
        referenceId,
        title: reference.title,
        reason: 'file-not-in-index',
        message: ''
      })
      continue
    }

    try {
      const listed = await window.api.pdfAnnotations.list({
        projectId,
        sessionId: item.sessionId,
        artifactId: item.sourceFileId,
        versionId
      })
      readReferenceIds.push(referenceId)
      for (const view of listed.annotations) {
        const { annotation } = view
        citations.push({
          referenceId,
          // The anchor comes from the ROW, and the state from the read: the citation says which bytes the
          // markup was drawn on even when that is not the version on screen, and the alignment is what
          // decides whether such a markup may be evidence.
          outcome: buildPdfAnnotationCitation({
            annotationId: annotation.id,
            sourceFileId: annotation.sourceFileId,
            versionId: annotation.versionId,
            checksum: annotation.checksum,
            kind: annotation.kind,
            selector: annotation.selector,
            body: annotation.body,
            createdAt: annotation.createdAt,
            anchorState: view.anchorState
          })
        })
      }
    } catch (cause) {
      gaps.push({
        referenceId,
        title: reference.title,
        reason: 'read-failed',
        message: cause instanceof Error ? cause.message : String(cause)
      })
    }
  }

  return {
    alignment: alignPdfAnnotationCitationsWithScreeningExport({
      exportScope: input.scope,
      references: input.references.map(toCitationReference),
      citations
    }),
    gaps,
    readReferenceIds
  }
}
