import { validatePdfAnnotationContent } from './pdf-annotations'
import { formatGbt7714 } from './references'
import type {
  PdfAnnotationAnchorState,
  PdfAnnotationKind,
  PdfAnnotationRect,
  PdfAnnotationSelector,
  PdfAnnotationValidationFailure
} from './pdf-annotations'
import type { ScreeningExportScope, ScreeningExportScopeKind } from './references-screening-export'

// A PDF annotation as a CITATION (文档标注层 A5, 红线 4).
//
// The line this module draws is the difference between "a highlight exists" and "a claim can be checked".
// A citation built here carries the four facts that make a markup passage attributable and re-findable:
//
//   * WHICH BYTES — `sourceFileId` + `versionId` + `checksum`. The same anchor the annotation is stored
//     under, restated, so a reader holding the citation can tell whether the file it names is still the
//     file the markup was drawn on. Nothing here resolves the version: a caller that has the version on
//     hand passes its `anchorState`, and a markup on other bytes is reported as such rather than cited as
//     if it were on these.
//   * WHERE — the 1-based page and the normalized rectangles the markup covers. Normalized for the same
//     reason the store uses normalized boxes: a rectangle that survives zoom survives being pasted into a
//     report.
//   * WHAT IT MARKS — `quote`, the passage the markup covers, as the store captured it at write time.
//   * WHAT WAS SAID — `body`, the reader's own note.
//
// The second half of the module answers the other half of the red line: exporting a bibliography must
// align with the triage decision that selected the records, and it must not invent a second notion of
// "which records are in". So the annotation side of the export range consumes the SAME
// `ScreeningExportScope` the screening export consumes (`includedReferenceIds`) — one range, two readers.
// A record the effective verdict kept out keeps its annotations out too, and the reason travels with it.
//
// Pure and renderer-safe: it imports the closed vocabularies and the GB/T 7714 formatter, and nothing else.

/** The citation record's own schema version. Bumping it is a breaking change to the shape a reader holds. */
export const PDF_ANNOTATION_CITATION_SCHEMA_VERSION = 1

export const PDF_ANNOTATION_CITATION_MAX_QUOTE_CHARS = 2_000
export const PDF_ANNOTATION_CITATION_MAX_BODY_CHARS = 8_000

/** Where a markup sits on its file version: the page and the boxes it covers. */
export type PdfAnnotationLocator = {
  /** 1-based page; absent for a note attached to the document as a whole. */
  page?: number
  /** The normalized rectangles the markup covers. Empty for the kinds that carry none. */
  rects: readonly PdfAnnotationRect[]
}

/**
 * The page and the boxes of one selector, read from the selector's own shape.
 *
 * Deliberately total: every selector shape answers, and the shapes that have no page or no rectangle say
 * so with an absent page and an empty list rather than a placeholder page nobody could check.
 */
export const pdfAnnotationLocator = (selector: PdfAnnotationSelector): PdfAnnotationLocator => {
  if (selector.shape === 'text-range') return { page: selector.page, rects: selector.rects }
  if (selector.shape === 'area') return { page: selector.page, rects: [selector.rect] }
  if (selector.shape === 'page-note') {
    return {
      page: selector.page,
      ...(selector.anchorRect ? { rects: [selector.anchorRect] } : { rects: [] })
    }
  }
  return { rects: [] }
}

/** The passage a markup covers, or '' for the kinds that cover no passage (an area, a note). */
export const pdfAnnotationQuote = (selector: PdfAnnotationSelector): string =>
  selector.shape === 'text-range' ? selector.quote : ''

export type PdfAnnotationCitationRecord = {
  schemaVersion: typeof PDF_ANNOTATION_CITATION_SCHEMA_VERSION
  annotationId: string
  kind: PdfAnnotationKind
  /** The anchor, entire — the three facts that decide which bytes the markup belongs to. */
  anchor: {
    sourceFileId: string
    versionId: string
    checksum: string
  }
  /** How that anchor compares to the version the caller was holding. Never assumed to be `current`. */
  anchorState: PdfAnnotationAnchorState
  /** 1-based page, absent for a document-wide note. */
  page?: number
  /** The normalized rectangles the markup covers; empty when it covers none. */
  rects: readonly PdfAnnotationRect[]
  /** The passage the markup marks, exactly as the store captured it. '' for the kinds that quote none. */
  quote: string
  /** The reader's own text. '' when the markup carries none (a bare highlight). */
  body: string
  createdAt: number
}

export type PdfAnnotationCitationOutcome =
  | { status: 'record'; record: PdfAnnotationCitationRecord }
  | {
      status: 'refused'
      annotationId: string
      code: PdfAnnotationValidationFailure['code']
      message: string
    }

export type PdfAnnotationCitationInput = {
  annotationId: string
  sourceFileId: string
  versionId: string
  checksum: string
  kind: string
  selector: unknown
  body: string
  createdAt: number
  /** How the annotation's anchor compares to the version on hand. Supplied, never guessed. */
  anchorState: PdfAnnotationAnchorState
}

/**
 * Builds the citation record for one stored annotation.
 *
 * A record that disagrees with its own kind/selector rule is REFUSED by name rather than cited: a
 * citation is a claim about a passage, and one built from a row nobody could read would attribute a
 * quotation to bytes it may not belong to. The validator is the same one the store writes through, so
 * there is no second opinion about what a well-formed annotation is.
 */
export const buildPdfAnnotationCitation = (
  input: PdfAnnotationCitationInput
): PdfAnnotationCitationOutcome => {
  const failure = validatePdfAnnotationCitationInput(input)
  if (failure) {
    return {
      status: 'refused',
      annotationId: input.annotationId,
      code: failure.code,
      message: failure.message
    }
  }

  const selector = input.selector as PdfAnnotationSelector
  const locator = pdfAnnotationLocator(selector)
  const quote = pdfAnnotationQuote(selector)

  return {
    status: 'record',
    record: {
      schemaVersion: PDF_ANNOTATION_CITATION_SCHEMA_VERSION,
      annotationId: input.annotationId,
      kind: input.kind as PdfAnnotationKind,
      anchor: {
        sourceFileId: input.sourceFileId,
        versionId: input.versionId,
        checksum: input.checksum
      },
      anchorState: input.anchorState,
      ...(locator.page === undefined ? {} : { page: locator.page }),
      rects: locator.rects,
      // Both texts are bounded: a citation is a pointer to a passage, and one that pasted a whole page
      // into a bibliography would stop being a pointer.
      quote: quote.slice(0, PDF_ANNOTATION_CITATION_MAX_QUOTE_CHARS),
      body: input.body.slice(0, PDF_ANNOTATION_CITATION_MAX_BODY_CHARS),
      createdAt: input.createdAt
    }
  }
}

// Kept as its own step so the refusal path is one call rather than a chain of early returns the record
// builder could grow out of step with.
const validatePdfAnnotationCitationInput = (
  input: PdfAnnotationCitationInput
): PdfAnnotationValidationFailure | undefined =>
  validatePdfAnnotationContent({
    kind: input.kind,
    selector: input.selector,
    body: input.body
  })

// --- one pasteable line -----------------------------------------------------------------------------

export type PdfAnnotationCitationLabels = {
  header: string
  file: string
  version: string
  checksum: string
  page: string
  region: string
  quote: string
  note: string
  anchorState: string
}

/** One rectangle, in the normalized space the store uses. Printed at three decimals: enough to point. */
export const formatPdfAnnotationRect = (rect: PdfAnnotationRect): string =>
  `${rect.x.toFixed(3)} ${rect.y.toFixed(3)} ${rect.width.toFixed(3)} ${rect.height.toFixed(3)}`

/**
 * One citation as text. Labels come from the UI language; identifiers, the checksum and the coordinates do
 * not translate, because the point of the line is that someone else can check it against the same bytes.
 */
export const formatPdfAnnotationCitation = (
  record: PdfAnnotationCitationRecord,
  labels: PdfAnnotationCitationLabels
): string =>
  [
    `${labels.header}: ${record.annotationId} (${record.kind})`,
    `${labels.file}: ${record.anchor.sourceFileId}`,
    `${labels.version}: ${record.anchor.versionId}`,
    `${labels.checksum}: sha256:${record.anchor.checksum}`,
    `${labels.anchorState}: ${record.anchorState}`,
    // A document-wide note has no page and no box; saying so beats printing a confident "page 0".
    ...(record.page === undefined ? [] : [`${labels.page}: ${record.page}`]),
    ...(record.rects.length === 0
      ? []
      : record.rects.map(
          (rect, index) => `${labels.region} ${index + 1}: ${formatPdfAnnotationRect(rect)}`
        )),
    ...(record.quote ? [`${labels.quote}: ${record.quote}`] : []),
    ...(record.body ? [`${labels.note}: ${record.body}`] : [])
  ].join('\n')

// --- the export range, read by the annotation chain --------------------------------------------------

/**
 * The bibliographic facts a GB/T 7714 line needs. A structural subset of the library's own `Reference`,
 * declared narrowly so this module does not depend on the whole record shape.
 */
export type AnnotationCitationReference = {
  id: string
  title: string
  authors: readonly { name: string }[]
  venue?: string | undefined
  year?: number | undefined
  doi?: string | undefined
  arxivId?: string | undefined
  pmid?: string | undefined
  pmcid?: string | undefined
}

/** Why one annotation is not evidence for anything the export may contain. Always named. */
export type AnnotationCitationMisalignmentReason =
  // The file's record exists, but the export range excludes it (a reviewer excluded it, or the model's
  // verdict stood). The record's annotations leave with it — this is the alignment, not a failure.
  | 'reference-not-in-export-range'
  // The annotation's file is not attached to any record the caller supplied. It is not evidence for a
  // bibliography entry because it is not on a bibliography entry's file.
  | 'reference-unknown'
  // The markup is not on the bytes the file version now carries. It is named rather than silently placed
  // on the current version, which is the same rule the store and the panel follow.
  | 'anchor-not-current'
  // The stored row disagreed with its own kind/selector rule, so no citation could be built from it.
  | 'annotation-refused'

export type AnnotationCitationAlignmentEntry = {
  referenceId: string
  /** The GB/T 7714 line for the record, built from the reference the caller supplied. */
  citation: string
  /** The annotations of that record's file that are evidence for it, oldest first. */
  annotations: readonly PdfAnnotationCitationRecord[]
}

export type AnnotationCitationAlignment = {
  /** The range this alignment was computed against, restated so a receipt cannot be read without it. */
  scope: {
    kind: ScreeningExportScopeKind
    collectionId: string
    ruleRevision: number | null
  }
  /**
   * One entry per EXPORTABLE record that has evidence, in the range's own order
   * (`includedReferenceIds`). A record with no annotated file is absent — a bibliography entry with an
   * empty evidence list would read as "there was nothing to cite", which is a different statement.
   */
  entries: readonly AnnotationCitationAlignmentEntry[]
  notAligned: readonly { annotationId: string; reason: AnnotationCitationMisalignmentReason }[]
  counts: {
    exportableReferences: number
    referencesWithEvidence: number
    alignedAnnotations: number
    notAlignedAnnotations: number
  }
}

export type AnnotationCitationInput = {
  /** One annotation's citation, or its named refusal, paired with the record its file belongs to. */
  referenceId: string | null
  outcome: PdfAnnotationCitationOutcome
}

export type AlignAnnotationCitationsInput = {
  exportScope: ScreeningExportScope
  references: readonly AnnotationCitationReference[]
  citations: readonly AnnotationCitationInput[]
}

const gbt7714Of = (reference: AnnotationCitationReference, retrievedAt?: string): string =>
  formatGbt7714(
    {
      title: reference.title,
      authors: [...reference.authors],
      venue: reference.venue,
      year: reference.year,
      doi: reference.doi,
      arxivId: reference.arxivId,
      pmid: reference.pmid,
      pmcid: reference.pmcid
    },
    retrievedAt === undefined ? {} : { retrievedAt }
  )

/**
 * Aligns annotation citations with the records a triage export may contain.
 *
 * There is no second "collection" here and no second verdict: the range is the caller's own
 * `ScreeningExportScope`, the exportable set is its `includedReferenceIds`, and every annotation whose
 * record is outside it is reported with the reason it stayed out. That is what makes
 * 「引文链能看到关联标注」 and 「导出只含入选文献」 two statements about the same range rather than two
 * independent filters that could drift apart.
 */
export const alignPdfAnnotationCitationsWithScreeningExport = (
  input: AlignAnnotationCitationsInput
): AnnotationCitationAlignment => {
  const exportable = new Set(input.exportScope.includedReferenceIds)
  const byReference = new Map<string, AnnotationCitationReference>()
  for (const reference of input.references) byReference.set(reference.id, reference)

  const collected = new Map<string, PdfAnnotationCitationRecord[]>()
  const notAligned: { annotationId: string; reason: AnnotationCitationMisalignmentReason }[] = []

  for (const entry of input.citations) {
    if (entry.outcome.status === 'refused') {
      notAligned.push({ annotationId: entry.outcome.annotationId, reason: 'annotation-refused' })
      continue
    }
    const { record } = entry.outcome
    const referenceId = entry.referenceId
    if (!referenceId || !byReference.has(referenceId)) {
      notAligned.push({ annotationId: record.annotationId, reason: 'reference-unknown' })
      continue
    }
    // The export range is read through the record, before the anchor: a record the triage kept out stays
    // out whatever its markup looks like, and the reason says which of the two rules decided.
    if (!exportable.has(referenceId)) {
      notAligned.push({
        annotationId: record.annotationId,
        reason: 'reference-not-in-export-range'
      })
      continue
    }
    if (record.anchorState !== 'current') {
      notAligned.push({ annotationId: record.annotationId, reason: 'anchor-not-current' })
      continue
    }
    const existing = collected.get(referenceId)
    if (existing) existing.push(record)
    else collected.set(referenceId, [record])
  }

  // The range's order, not the citations' — two runs over the same range produce the same bibliography.
  const entries: AnnotationCitationAlignmentEntry[] = []
  for (const referenceId of input.exportScope.includedReferenceIds) {
    const annotations = collected.get(referenceId)
    if (!annotations || annotations.length === 0) continue
    const reference = byReference.get(referenceId)
    // A record the range names but the caller did not supply produces no entry: no citation can be printed
    // for a record whose bibliographic fields are not on hand. It is visible in the counts rather than
    // papered over — `referencesWithEvidence` then reads below `exportableReferences`, which is the honest
    // difference between "this record has no evidence" and "this record was not on hand".
    if (!reference) continue
    entries.push({
      referenceId,
      citation: gbt7714Of(reference),
      annotations: [...annotations].sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          (left.annotationId < right.annotationId
            ? -1
            : left.annotationId > right.annotationId
              ? 1
              : 0)
      )
    })
  }

  const alignedAnnotations = entries.reduce((total, entry) => total + entry.annotations.length, 0)
  return {
    scope: {
      kind: input.exportScope.kind,
      collectionId: input.exportScope.collectionId,
      ruleRevision: input.exportScope.ruleRevision
    },
    entries,
    notAligned,
    counts: {
      exportableReferences: exportable.size,
      referencesWithEvidence: entries.length,
      alignedAnnotations,
      notAlignedAnnotations: notAligned.length
    }
  }
}

/**
 * One pasteable block for the whole alignment: each exportable record's GB/T 7714 line followed by the
 * annotations that are evidence for it. Labels come from the UI language; the citation and the anchors do
 * not translate.
 */
export const formatAnnotationCitationAlignment = (
  alignment: AnnotationCitationAlignment,
  labels: {
    header: string
    scope: string
    evidenceCount: string
    annotationHeader: string
    citationLabels: PdfAnnotationCitationLabels
    notAligned: string
    reasonLabels: Record<AnnotationCitationMisalignmentReason, string>
  }
): string => {
  const lines = [
    `${labels.header}: ${alignment.scope.collectionId} (${alignment.scope.kind}, ${labels.scope} r${
      alignment.scope.ruleRevision ?? '-'
    })`,
    `${labels.evidenceCount}: ${alignment.counts.alignedAnnotations}`,
    ''
  ]

  for (const entry of alignment.entries) {
    lines.push(entry.citation)
    for (const record of entry.annotations) {
      lines.push(`${labels.annotationHeader}: ${record.annotationId} (${record.kind})`)
      lines.push(formatPdfAnnotationCitation(record, labels.citationLabels))
    }
    lines.push('')
  }

  if (alignment.notAligned.length > 0) {
    lines.push(`${labels.notAligned}: ${alignment.notAligned.length}`)
    for (const entry of alignment.notAligned) {
      lines.push(`  ${entry.annotationId}: ${labels.reasonLabels[entry.reason]}`)
    }
  }

  return lines.join('\n')
}
