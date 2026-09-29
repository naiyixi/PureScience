import { isBookmarkRect, type BookmarkRect } from './bookmark'

// PDF annotations (文档标注层 A1): a markup, a region or a note anchored to ONE immutable file version.
//
// Two rules define this module, and both are enforced here rather than at each call site:
//
//   1. The anchor is `(sourceFileId, versionId, checksum)` — the annotation belongs to the exact bytes
//      it was drawn on, not to a session and not to "the file with that name". A newer version of the
//      same file therefore carries NONE of the earlier version's annotations: nothing is migrated
//      silently, and the two ways an anchor can stop matching are named states
//      (see `resolvePdfAnnotationAnchorState`), not a quiet re-point.
//   2. `kind` and the selector's SHAPE must agree. Each kind has exactly one shape, the shape decides
//      which anchor fields exist, and a selector that does not match its kind is REFUSED with a named
//      reason that says which field disagreed. It is never stored and repaired on read, and never
//      silently downgraded to whatever shape happens to parse.
//
// Values here are machine names. Human copy lives with the renderer, so this module stays
// renderer-safe: its only import is the normalized page rectangle the PDF surfaces already use.

export const PDF_ANNOTATION_KINDS = [
  'highlight', // 高亮: a text range marked as important
  'underline', // 下划线
  'squiggly', // 波浪线
  'strikethrough', // 删除线
  'area', // 区域框: a rectangle on a page, drawn rather than selected from text
  'page-note', // 页面便签: a note attached to one page
  'document-note' // 全文便签: a note attached to the document as a whole
] as const
export type PdfAnnotationKind = (typeof PDF_ANNOTATION_KINDS)[number]

// The selector envelope version. Bumping it is a breaking change to the anchor vocabulary: a reader
// that does not understand the version refuses the selector instead of guessing at its fields.
export const PDF_ANNOTATION_SELECTOR_VERSION = 1

export const PDF_ANNOTATION_SELECTOR_SHAPES = [
  'text-range', // page + the rectangles a text selection covers + the quoted text
  'area', // page + one rectangle
  'page-note', // page (+ an optional point of reference on it)
  'document-note' // nothing beyond the document itself
] as const
export type PdfAnnotationSelectorShape = (typeof PDF_ANNOTATION_SELECTOR_SHAPES)[number]

// The one shape each kind uses. Written as a total record, so adding a kind without deciding its shape
// is a compile error rather than a selector that nothing validates.
export const PDF_ANNOTATION_KIND_SHAPES: Readonly<
  Record<PdfAnnotationKind, PdfAnnotationSelectorShape>
> = {
  highlight: 'text-range',
  underline: 'text-range',
  squiggly: 'text-range',
  strikethrough: 'text-range',
  area: 'area',
  'page-note': 'page-note',
  'document-note': 'document-note'
}

// The same normalized 0..1 page box a region bookmark uses, with the same validator: a rectangle that
// survives zoom, DPI and a resized window is already solved next door, and a second definition of it
// would be a second thing to keep true.
export type PdfAnnotationRect = BookmarkRect

export type PdfAnnotationTextRangeSelector = {
  version: typeof PDF_ANNOTATION_SELECTOR_VERSION
  shape: 'text-range'
  page: number
  rects: readonly PdfAnnotationRect[]
  quote: string
}

export type PdfAnnotationAreaSelector = {
  version: typeof PDF_ANNOTATION_SELECTOR_VERSION
  shape: 'area'
  page: number
  rect: PdfAnnotationRect
}

export type PdfAnnotationPageNoteSelector = {
  version: typeof PDF_ANNOTATION_SELECTOR_VERSION
  shape: 'page-note'
  page: number
  // Where on the page the note was written, when the reader placed it somewhere specific.
  anchorRect?: PdfAnnotationRect
}

export type PdfAnnotationDocumentNoteSelector = {
  version: typeof PDF_ANNOTATION_SELECTOR_VERSION
  shape: 'document-note'
}

export type PdfAnnotationSelector =
  | PdfAnnotationTextRangeSelector
  | PdfAnnotationAreaSelector
  | PdfAnnotationPageNoteSelector
  | PdfAnnotationDocumentNoteSelector

export type PdfAnnotation = {
  id: string
  sourceFileId: string
  versionId: string
  checksum: string
  kind: PdfAnnotationKind
  selector: PdfAnnotationSelector
  body: string
  createdAt: number
}

// The kinds of input an annotation can be created from: the kind and the selector arrive separately,
// so the pair is checked together rather than assumed to have been assembled correctly.
export type PdfAnnotationContentInput = {
  kind: string
  selector: unknown
  body?: string
}

export type PdfAnnotationValidationFailure = {
  code:
    | 'unknown-kind'
    | 'missing-selector'
    | 'unsupported-selector-version'
    | 'unknown-selector-shape'
    | 'selector-shape-mismatch'
    | 'selector-shape-invalid'
    | 'empty-note-body'
  message: string
}

export const isPdfAnnotationKind = (value: string): value is PdfAnnotationKind =>
  (PDF_ANNOTATION_KINDS as readonly string[]).includes(value)

export const isPdfAnnotationSelectorShape = (value: string): value is PdfAnnotationSelectorShape =>
  (PDF_ANNOTATION_SELECTOR_SHAPES as readonly string[]).includes(value)

// Anchor fields that belong to exactly one shape. `page` is deliberately absent — a text range, an area
// and a page note all carry one — so it is not by itself evidence of a disagreement.
const SHAPE_EXCLUSIVE_FIELDS: Readonly<Record<string, PdfAnnotationSelectorShape>> = {
  rects: 'text-range',
  quote: 'text-range',
  rect: 'area',
  anchorRect: 'page-note'
}

const kindList = PDF_ANNOTATION_KINDS.join(', ')
const shapeList = PDF_ANNOTATION_SELECTOR_SHAPES.join(', ')

const describeValue = (value: unknown): string =>
  value === undefined
    ? 'nothing'
    : value === null
      ? 'null'
      : typeof value === 'string'
        ? `"${value}"`
        : typeof value === 'object'
          ? Array.isArray(value)
            ? 'an array'
            : 'an object'
          : String(value)

const isPositivePage = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1

// One place where a selector's own fields are checked against the shape it declares. Each failure names
// the kind, the shape and the field, because "invalid selector" is not something a caller can act on.
const validateShapeFields = (
  kind: PdfAnnotationKind,
  shape: PdfAnnotationSelectorShape,
  selector: Record<string, unknown>
): PdfAnnotationValidationFailure | undefined => {
  const where = `kind "${kind}" (selector shape "${shape}")`

  for (const [field, owner] of Object.entries(SHAPE_EXCLUSIVE_FIELDS)) {
    if (owner === shape) continue
    if (selector[field] === undefined) continue
    return {
      code: 'selector-shape-invalid',
      message: `${where} carries "${field}", which belongs to selector shape "${owner}".`
    }
  }

  if (shape === 'document-note') {
    if (selector.page !== undefined) {
      return {
        code: 'selector-shape-invalid',
        message: `A "document-note" selector has no page, but the selector carries page ${describeValue(selector.page)}.`
      }
    }
    return undefined
  }

  if (!isPositivePage(selector.page)) {
    return {
      code: 'selector-shape-invalid',
      message: `${where} needs "page" to be a 1-based integer, got ${describeValue(selector.page)}.`
    }
  }

  if (shape === 'text-range') {
    const rects = selector.rects
    if (!Array.isArray(rects) || rects.length === 0) {
      return {
        code: 'selector-shape-invalid',
        message: `${where} needs "rects" to be a non-empty array of normalized rectangles, got ${describeValue(rects)}.`
      }
    }
    const badIndex = rects.findIndex((rect) => !isBookmarkRect(rect))
    if (badIndex >= 0) {
      return {
        code: 'selector-shape-invalid',
        message: `${where} needs every entry of "rects" to be a normalized rectangle (0..1, non-zero size); entry ${badIndex} is ${describeValue(rects[badIndex])}.`
      }
    }
    if (typeof selector.quote !== 'string' || selector.quote.trim() === '') {
      return {
        code: 'selector-shape-invalid',
        message: `${where} needs "quote" to be the passage it marks, got ${describeValue(selector.quote)}.`
      }
    }
    return undefined
  }

  if (shape === 'page-note') {
    if (selector.anchorRect !== undefined && !isBookmarkRect(selector.anchorRect)) {
      return {
        code: 'selector-shape-invalid',
        message: `${where} needs "anchorRect", when the note is placed on the page, to be one normalized rectangle (0..1, non-zero size), got ${describeValue(selector.anchorRect)}.`
      }
    }
    return undefined
  }

  if (!isBookmarkRect(selector.rect)) {
    return {
      code: 'selector-shape-invalid',
      message: `${where} needs "rect" to be one normalized rectangle (0..1, non-zero size), got ${describeValue(selector.rect)}.`
    }
  }
  return undefined
}

// The consistency rule, entire. Returns undefined when the kind and the selector agree, and a named
// failure when they do not — callers refuse the write on a failure instead of repairing it.
export const validatePdfAnnotationContent = (
  input: PdfAnnotationContentInput
): PdfAnnotationValidationFailure | undefined => {
  if (!isPdfAnnotationKind(input.kind)) {
    return {
      code: 'unknown-kind',
      message: `Unknown PDF annotation kind ${describeValue(input.kind)}; it must be one of ${kindList}.`
    }
  }
  const kind = input.kind

  const selector = input.selector
  if (typeof selector !== 'object' || selector === null || Array.isArray(selector)) {
    return {
      code: 'missing-selector',
      message: `A PDF annotation needs a selector object; got ${describeValue(selector)}.`
    }
  }
  const fields = selector as Record<string, unknown>

  if (fields.version !== PDF_ANNOTATION_SELECTOR_VERSION) {
    return {
      code: 'unsupported-selector-version',
      message: `This build reads PDF annotation selector version ${PDF_ANNOTATION_SELECTOR_VERSION}, but the selector declares version ${describeValue(fields.version)}; the annotation was refused rather than read with guessed fields.`
    }
  }

  const shape = fields.shape
  if (typeof shape !== 'string' || !isPdfAnnotationSelectorShape(shape)) {
    return {
      code: 'unknown-selector-shape',
      message: `Unknown PDF annotation selector shape ${describeValue(shape)}; it must be one of ${shapeList}.`
    }
  }

  const expected = PDF_ANNOTATION_KIND_SHAPES[kind]
  if (shape !== expected) {
    return {
      code: 'selector-shape-mismatch',
      message: `kind "${kind}" needs selector shape "${expected}", but the selector declares shape "${shape}".`
    }
  }

  const fieldFailure = validateShapeFields(kind, shape, fields)
  if (fieldFailure) return fieldFailure

  if (kind === 'page-note' || kind === 'document-note') {
    if (!(input.body ?? '').trim()) {
      return {
        code: 'empty-note-body',
        message: `kind "${kind}" needs a non-empty body; a note with no text annotates nothing.`
      }
    }
  }

  return undefined
}

// --- how an annotation's anchor compares to the version on hand -----------------------------------

// The two ways an anchor can stop matching, plus the case where it still does. Named states, because
// neither of the mismatching ones may be resolved by re-pointing the annotation behind the reader's
// back: a region drawn on different bytes is not the same region.
export const PDF_ANNOTATION_ANCHOR_STATES = [
  'current', // the file version and its bytes are the ones this annotation was drawn on
  'version-changed', // the file moved on to another version; this annotation stays on the old one
  'checksum-mismatch' // the same version id now carries different bytes — the anchor itself is broken
] as const
export type PdfAnnotationAnchorState = (typeof PDF_ANNOTATION_ANCHOR_STATES)[number]

export const resolvePdfAnnotationAnchorState = (
  annotation: Pick<PdfAnnotation, 'versionId' | 'checksum'>,
  version: { versionId: string; checksum: string }
): PdfAnnotationAnchorState => {
  if (annotation.versionId !== version.versionId) return 'version-changed'
  if (annotation.checksum !== version.checksum) return 'checksum-mismatch'
  return 'current'
}

// --- import receipts (导入回执) --------------------------------------------------------------------

// Which channel an imported payload came from. Closed on purpose: a receipt's job is to say where the
// annotations came from, and a free-text channel ("whatever the caller typed") cannot be filtered on.
export const PDF_ANNOTATION_IMPORT_SOURCE_KINDS = [
  'embedded-pdf', // annotations carried inside the PDF itself
  'annotation-file' // a reader's sidecar export for the same file version
] as const
export type PdfAnnotationImportSourceKind = (typeof PDF_ANNOTATION_IMPORT_SOURCE_KINDS)[number]

export const isPdfAnnotationImportSourceKind = (
  value: string
): value is PdfAnnotationImportSourceKind =>
  (PDF_ANNOTATION_IMPORT_SOURCE_KINDS as readonly string[]).includes(value)

// A receipt for one import: which channel, which file version, when, and the digest of the payload.
// The digest scoped to (sourceKind, sourceFileId, versionId) is the idempotency key, so importing the
// same payload into the same version twice records one receipt.
export type PdfAnnotationImport = {
  id: string
  sourceKind: PdfAnnotationImportSourceKind
  sourceFileId: string
  versionId: string
  digest: string
  importedAt: number
}
