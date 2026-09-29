import type { PdfAnnotation } from '../../shared/pdf-annotations'
import { GLOBAL_SEARCH_MAX_SCANNED_ANNOTATIONS } from '../../shared/global-search'
import { pdfAnnotationLocator, pdfAnnotationQuote } from '../../shared/pdf-annotation-citation'
import type { SearchableAnnotation } from './global-search-service'

// The annotation corpus of a project (文档标注层 A5, 需求 1).
//
// What goes into the search index is a question this module answers by construction, and the answer is
// short: THE TEXT THE STORE ALREADY HOLDS. Concretely, the two fields named by
// `GLOBAL_SEARCH_ANNOTATION_INDEXED_FIELDS` — the annotation's own `body` and the passage inside its
// selector (`quote`, captured at write time by A1/A2) — plus the anchor (file version + checksum) and the
// owning file's display name.
//
// What does NOT go in: any PDF byte, any page text, anything a parser produced. This module has no
// parser to call and never receives file paths or bytes: the two ports below take identifiers and hand
// back rows. That is deliberate rather than incidental — "search does not read PDFs" is a property of the
// wiring, so a later change that wanted page text in the index would have to add a port here in the open
// instead of reaching for one that was already lying around.
//
// The bounds are honest in both directions: the anchor list and the annotation read each report when they
// stopped early, and that reaches the response as a note rather than as a quietly smaller corpus.

/** One file version of the project that may carry annotations: the anchor, plus where to say it lives. */
export type AnnotationCorpusAnchor = {
  /** The artifact the annotation is anchored to (A1's `sourceFileId`). */
  sourceFileId: string
  versionId: string
  /** The display name of the file, so a hit names the file rather than an opaque id. */
  fileName: string
  /** The file's own timestamp, when the caller has one. Never invented. */
  timestamp?: string
}

export type AnnotationCorpusSource = {
  /**
   * The project's candidate file versions. A caller that cannot enumerate them answers with an empty list
   * and `bounded: false`; it must not answer with "everything", which would make the project scope a lie.
   */
  listAnchors(request: {
    projectId: string
  }): Promise<{ anchors: readonly AnnotationCorpusAnchor[]; bounded?: boolean }>
  /** The stored annotations of those versions. Reads the annotation store; never a PDF. */
  readAnnotations(request: {
    anchors: readonly { sourceFileId: string; versionId: string }[]
    limit: number
  }): Promise<{ annotations: readonly PdfAnnotation[]; bounded?: boolean }>
}

export type AnnotationCorpusRead = {
  annotations: SearchableAnnotation[]
  // True when either bound was reached: the corpus handed to the search is smaller than the project's.
  bounded: boolean
}

/**
 * Whether a project file could carry annotations at all.
 *
 * Every kind the store accepts (A1) is a markup on a PDF page — a highlight over text, a region, a note —
 * so a file of another format has none to find, and offering it as an anchor would cost a query to learn
 * nothing. Name and MIME are both consulted: a project file's MIME is optional, and a `.pdf` that arrived
 * without one is still a PDF.
 */
export const isAnnotatableProjectFile = (file: { name: string; mimeType?: string }): boolean =>
  file.mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')

export type SearchAnnotationCorpus = {
  list(request: { projectId: string }): Promise<AnnotationCorpusRead>
}

export const createSearchAnnotationCorpus = (
  source: AnnotationCorpusSource
): SearchAnnotationCorpus => ({
  async list({ projectId }) {
    const listed = await source.listAnchors({ projectId })
    if (listed.anchors.length === 0) return { annotations: [], bounded: listed.bounded === true }

    const read = await source.readAnnotations({
      anchors: listed.anchors.map((anchor) => ({
        sourceFileId: anchor.sourceFileId,
        versionId: anchor.versionId
      })),
      limit: GLOBAL_SEARCH_MAX_SCANNED_ANNOTATIONS
    })

    // The display name is looked up by the anchor the row itself carries, not by position: an annotation
    // belongs to the bytes it names, and pairing it with a neighbour's file name would name the wrong file.
    const nameByAnchor = new Map(
      listed.anchors.map(
        (anchor) => [`${anchor.sourceFileId}\0${anchor.versionId}`, anchor] as const
      )
    )

    const annotations: SearchableAnnotation[] = []
    for (const annotation of read.annotations) {
      const anchor = nameByAnchor.get(`${annotation.sourceFileId}\0${annotation.versionId}`)
      if (!anchor) continue
      const locator = pdfAnnotationLocator(annotation.selector)
      annotations.push({
        id: annotation.id,
        projectId,
        sourceFileId: annotation.sourceFileId,
        versionId: annotation.versionId,
        checksum: annotation.checksum,
        kind: annotation.kind,
        body: annotation.body,
        quote: pdfAnnotationQuote(annotation.selector),
        ...(locator.page === undefined ? {} : { page: locator.page }),
        fileName: anchor.fileName,
        createdAt: annotation.createdAt,
        ...(anchor.timestamp ? { timestamp: anchor.timestamp } : {})
      })
    }

    return {
      annotations,
      bounded: listed.bounded === true || read.bounded === true
    }
  }
})
