import { isBookmarkRect, type BookmarkRect } from './bookmark'
import {
  PDF_ANNOTATION_SELECTOR_VERSION,
  validatePdfAnnotationContent,
  type PdfAnnotationContentInput,
  type PdfAnnotationImport,
  type PdfAnnotationKind
} from './pdf-annotations'
import type { PdfTextItem } from './pdf-table-extraction'

// Importing the annotations a PDF carries inside itself (文档标注层 A2).
//
// The markup a reader drew in their previous PDF app — highlights, underlines, a region, a sticky note
// and its text — lives in the file's own annotations. This module turns those into OUR annotations:
// anchored to the exact file version, carrying a real selector (page + normalized rectangles + the
// passage they cover) so a highlight lands on the words that were highlighted rather than "somewhere
// on page 3".
//
// Three rules, because each one is a way an import quietly lies:
//
//   1. NOTHING IS DROPPED SILENTLY. A subtype this build cannot turn into one of our kinds is counted
//      and named in the report, together with why it was left behind — the same for a markup whose
//      text cannot be located on the page. "Imported 5 of 9" is something a reader can act on;
//      "finished" is not.
//   2. A FILE WITH NOTHING TO IMPORT SAYS SO. An import that writes nothing is reported as "this file
//      carries no annotations" (or "it carries only kinds this build does not import"), never as a
//      success that happens to have produced nothing.
//   3. A FILE THAT CANNOT BE READ IS A NAMED FAILURE WITH NOTHING WRITTEN. A damaged PDF, or bytes
//      that are not the version the caller named, stop the import before the first write — there is no
//      half an import.
//
// This module is pure and renderer-safe: no node builtins, and it knows nothing about pdfjs. The
// parser (main process) adapts a PDF library's annotation objects to `PdfEmbeddedAnnotation`; every
// decision about what is importable, and every word of the report, is made here.

// The PDF subtypes that have a counterpart in our kinds — the whole supported surface, in one place.
// A subtype that is absent is reported by name rather than guessed at: `Circle` is not an `area`
// (a circle is not a rectangle), `FreeText` is drawn text rather than a markup of existing text, and
// neither has a selector shape we could honestly write.
export const PDF_EMBEDDED_MARKUP_KINDS: Readonly<Record<string, PdfAnnotationKind>> = {
  Highlight: 'highlight',
  Underline: 'underline',
  Squiggly: 'squiggly',
  StrikeOut: 'strikethrough',
  Square: 'area',
  Text: 'page-note'
}

export const PDF_EMBEDDED_SUPPORTED_SUBTYPES = Object.keys(PDF_EMBEDDED_MARKUP_KINDS)

// Stands in for the /Subtype of an annotation whose dictionary has none. It is a label of ours rather
// than a name from the file, and it exists so that such an annotation is REPORTED (as a subtype with no
// counterpart) instead of being dropped by the adapter for lack of something to call it.
export const PDF_EMBEDDED_UNNAMED_SUBTYPE = '(no-subtype)'

// Why one annotation of the file did not become one of ours. Named, and reported with the subtype it
// happened to, so a reader can tell "we do not import this kind of markup" apart from "this markup
// could not be placed on the page".
export const PDF_EMBEDDED_SKIP_REASONS = [
  'unsupported-subtype', // no counterpart in our kinds
  'not-displayed', // the file itself marks the annotation hidden / not-for-view
  'unknown-page', // the annotation points at a page the parser did not read
  'rotated-page', // coordinates would land in the wrong place; not guessed at
  'degenerate-geometry', // the markup has no extent on the page, so it marks nothing
  'no-text-under-markup', // a text markup covering no text (scanned page / empty selection)
  'empty-note', // a note carrying no text annotates nothing
  'invalid-anchor' // the mapped anchor failed the store's own consistency rule (a bug, not file content)
] as const
export type PdfEmbeddedSkipReason = (typeof PDF_EMBEDDED_SKIP_REASONS)[number]

// The /F bits that mean the file does not want this annotation shown (PDF 32000-1, Annotation Flags):
// Hidden (bit 2) and NoView (bit 6). An annotation carrying either is reported as skipped rather than
// imported, because a markup no viewer draws is not one the reader can see or act on — and reporting it
// by name is the point: the alternative is a parser that drops it before anyone can count it.
//
// Bit 1 (Invisible) is deliberately NOT here: pdf.js clears it on every annotation subtype it parses
// (an annotation that would be invisible is still handed over), so an /F 1 annotation arrives with
// flags 0 and is imported like any other. That normalization belongs to the parser.
export const PDF_EMBEDDED_NOT_DISPLAYED_FLAGS = 0x02 | 0x20

// One page as the parser read it: the page box in PDF user space (points, y up) plus its text layer.
export type PdfImportedPage = {
  number: number // 1-based
  width: number
  height: number
  /** The page's own /Rotate, in degrees. Anything but 0 is refused (see `mapEmbeddedPdfAnnotation`). */
  rotate: number
  items: readonly PdfTextItem[]
}

// One annotation exactly as the file wrote it, still in page user space. `rect` and `quadPoints` stay
// `unknown` on purpose: a PDF library hands them back as an array, a typed array or an indexed object
// depending on the build and the file, and a malformed one must produce a named skip rather than a
// crash or a silently wrong rectangle.
export type PdfEmbeddedAnnotation = {
  page: number
  /**
   * The file's /Subtype, verbatim ('Highlight', 'Squiggly', 'Text', 'Ink', …), or
   * `PDF_EMBEDDED_UNNAMED_SUBTYPE` when the file wrote none.
   */
  subtype: string
  /** /Rect — x1 y1 x2 y2 in user space. */
  rect?: unknown
  /** /QuadPoints — 8 numbers per quadrilateral. */
  quadPoints?: unknown
  /** /Contents — the comment the reader attached to the markup, when the file carries one. */
  contents?: string
  /** /F — the file's annotation flags. Used for one decision: hidden/NoView markup is not imported. */
  flags?: number
}

export type PdfEmbeddedAnnotationMapping =
  | { ok: true; kind: PdfAnnotationKind; content: PdfAnnotationContentInput }
  | { ok: false; subtype: string; reason: PdfEmbeddedSkipReason; detail: string }

/** A quadrilateral or rectangle in page user space, y up: the shape the file states its markup in. */
type UserSpaceBox = { x1: number; y1: number; x2: number; y2: number }

// A markup quad is drawn on the page, so a text item has to overlap it by more than float noise to
// count as covered. One point is under a tenth of a line: it absorbs the rounding a reader's app does
// when it writes quads, without swallowing a neighbouring line.
export const PDF_EMBEDDED_TEXT_TOLERANCE_PT = 1

// What one imported selector may carry as its quoted passage. A real markup covers a line or a
// paragraph; this is the bound that keeps one pathological rectangle (a quad covering the whole page)
// from pushing a page of text into the store through a single annotation.
export const PDF_EMBEDDED_MAX_QUOTE_CHARS = 2000

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

// Four decimals: finer than any display resolves (a 1000 pt page resolves 0.001) and identical to the
// rounding a region bookmark already uses, so the two kinds of anchor stay comparable.
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

// Reads a coordinate list out of whatever the parser handed back: an array, a typed array, or an
// indexed object (a Float32Array arrives serialized that way). Anything that is not a finite number
// disqualifies the whole list, because a rectangle built from half-read coordinates would point
// somewhere the reader never drew.
const toNumberList = (value: unknown): number[] | undefined => {
  if (Array.isArray(value)) {
    return value.every(isFiniteNumber) ? [...value] : undefined
  }
  if (ArrayBuffer.isView(value)) {
    const numbers = Array.from(value as unknown as ArrayLike<unknown>)
    return numbers.every(isFiniteNumber) ? (numbers as number[]) : undefined
  }
  if (typeof value === 'object' && value !== null) {
    const indexed = value as Record<string, unknown>
    const numbers: number[] = []
    for (let index = 0; indexed[String(index)] !== undefined; index += 1) {
      const entry = indexed[String(index)]
      if (!isFiniteNumber(entry)) return undefined
      numbers.push(entry)
    }
    return numbers.length > 0 ? numbers : undefined
  }
  return undefined
}

const rectBox = (value: unknown): UserSpaceBox | undefined => {
  const list = toNumberList(value)
  if (!list || list.length < 4) return undefined
  const [x1, y1, x2, y2] = list as [number, number, number, number]
  return { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) }
}

// QuadPoints is 8 numbers per quad: four corners in the file's own order (upper-left, upper-right,
// lower-left, lower-right), repeated. Our selector stores axis-aligned rectangles, so each quad
// becomes its bounding box — which is also why the order inside a quad does not matter here, and why
// a file that writes the corners in another order still lands on the right line.
const quadBoxes = (value: unknown): UserSpaceBox[] | undefined => {
  const list = toNumberList(value)
  if (!list || list.length < 8) return undefined
  const boxes: UserSpaceBox[] = []
  for (let start = 0; start + 7 < list.length; start += 8) {
    const xs = [list[start], list[start + 2], list[start + 4], list[start + 6]] as number[]
    const ys = [list[start + 1], list[start + 3], list[start + 5], list[start + 7]] as number[]
    boxes.push({
      x1: Math.min(...xs),
      y1: Math.min(...ys),
      x2: Math.max(...xs),
      y2: Math.max(...ys)
    })
  }
  return boxes.length > 0 ? boxes : undefined
}

// Page user space (y up, origin bottom-left) → the normalized 0..1 box the PDF surfaces already use
// (y down, origin top-left). Returns undefined for a box with no extent on the page, so a degenerate
// markup is refused here instead of being written as a rectangle that marks nothing.
const normalizeBox = (box: UserSpaceBox, page: PdfImportedPage): BookmarkRect | undefined => {
  if (!(page.width > 0) || !(page.height > 0)) return undefined
  const left = clamp01(box.x1 / page.width)
  const right = clamp01(box.x2 / page.width)
  const top = clamp01(1 - box.y2 / page.height)
  const bottom = clamp01(1 - box.y1 / page.height)
  const rect: BookmarkRect = {
    x: round4(Math.min(left, right)),
    y: round4(Math.min(top, bottom)),
    width: round4(Math.abs(right - left)),
    height: round4(Math.abs(bottom - top))
  }
  return isBookmarkRect(rect) ? rect : undefined
}

// The passage a markup covers: every text item the boxes overlap, in reading order (top line first,
// left to right within a line). This is what makes an imported selector a real anchor — the quote the
// file's own markup sat on, read out of the same text layer the rest of the app uses.
export const textUnderBoxes = (
  boxes: readonly UserSpaceBox[],
  items: readonly PdfTextItem[]
): string => {
  const covered = items.filter((item) => {
    const itemLeft = item.x - PDF_EMBEDDED_TEXT_TOLERANCE_PT
    const itemRight = item.x + item.width + PDF_EMBEDDED_TEXT_TOLERANCE_PT
    const itemBottom = item.y - PDF_EMBEDDED_TEXT_TOLERANCE_PT
    const itemTop = item.y + item.height + PDF_EMBEDDED_TEXT_TOLERANCE_PT
    return boxes.some(
      (box) =>
        Math.min(itemRight, box.x2) > Math.max(itemLeft, box.x1) &&
        Math.min(itemTop, box.y2) > Math.max(itemBottom, box.y1)
    )
  })

  return (
    covered
      .slice()
      .sort((left, right) => right.y - left.y || left.x - right.x)
      // Joined with a space and then collapsed: a text run may or may not carry its own trailing space
      // depending on how the file split it, and a boundary that is then collapsed can only be right —
      // whereas joining without one can glue two lines into a word that is in neither of them.
      .map((entry) => entry.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

const skip = (
  subtype: string,
  reason: PdfEmbeddedSkipReason,
  detail: string
): PdfEmbeddedAnnotationMapping => ({ ok: false, subtype, reason, detail })

const supportedList = PDF_EMBEDDED_SUPPORTED_SUBTYPES.join(', ')

// The whole rule for one annotation of one page. Returns either the kind and content to write, or a
// named reason it was left out. Never throws: a file that carries something unforeseen must still
// import everything it can import.
export const mapEmbeddedPdfAnnotation = (
  annotation: PdfEmbeddedAnnotation,
  page: PdfImportedPage | undefined
): PdfEmbeddedAnnotationMapping => {
  const subtype = annotation.subtype
  const kind = PDF_EMBEDDED_MARKUP_KINDS[subtype]
  if (!kind) {
    return skip(
      subtype,
      'unsupported-subtype',
      `Annotation subtype "${subtype}" has no counterpart among the annotation kinds this build stores (${supportedList}); it was counted and skipped rather than imported as something it is not.`
    )
  }

  if (!page) {
    return skip(
      subtype,
      'unknown-page',
      `Annotation subtype "${subtype}" names page ${annotation.page}, which the parser did not read; without the page box its coordinates cannot be normalized.`
    )
  }

  // What the file says about showing it. Checked before anything about geometry: an annotation nobody
  // can see is not one whose position matters, and naming it here is what keeps it out of the silent
  // "the parser never told us" bucket.
  const flags = annotation.flags ?? 0
  if (flags & PDF_EMBEDDED_NOT_DISPLAYED_FLAGS) {
    return skip(
      subtype,
      'not-displayed',
      `Annotation subtype "${subtype}" on page ${page.number} is marked ${flags & 0x02 ? 'hidden' : 'no-view'} (annotation flags ${flags}), so no viewer draws it; it was not imported.`
    )
  }

  // A rotated page is displayed with its content turned, while the file's annotation coordinates stay
  // in the unrotated page box. Importing them as they stand would put a highlight on the wrong line,
  // and a guess is worse than a named skip.
  if (page.rotate % 360 !== 0) {
    return skip(
      subtype,
      'rotated-page',
      `Page ${page.number} is rotated ${page.rotate}°; the annotation's coordinates are in the unrotated page box, so its position on the displayed page was not guessed at.`
    )
  }

  const body = (annotation.contents ?? '').trim()

  if (kind === 'page-note') {
    if (!body) {
      return skip(
        subtype,
        'empty-note',
        `A "${subtype}" note on page ${page.number} carries no text; a note with nothing in it annotates nothing.`
      )
    }
    const anchorBox = rectBox(annotation.rect)
    const anchorRect = anchorBox ? normalizeBox(anchorBox, page) : undefined
    return {
      ok: true,
      kind,
      content: {
        kind,
        body,
        // The note itself is the content; a placeholder rectangle the file wrote for its icon is not
        // worth refusing the note over, so the anchor is simply absent when it has no extent.
        selector:
          anchorRect === undefined
            ? { version: PDF_ANNOTATION_SELECTOR_VERSION, shape: 'page-note', page: page.number }
            : {
                version: PDF_ANNOTATION_SELECTOR_VERSION,
                shape: 'page-note',
                page: page.number,
                anchorRect
              }
      }
    }
  }

  if (kind === 'area') {
    const box = rectBox(annotation.rect)
    const rect = box ? normalizeBox(box, page) : undefined
    if (!rect) {
      return skip(
        subtype,
        'degenerate-geometry',
        `A "${subtype}" region on page ${page.number} has no measurable extent in its /Rect, so it would mark nothing on the page.`
      )
    }
    return {
      ok: true,
      kind,
      content: {
        kind,
        body,
        selector: {
          version: PDF_ANNOTATION_SELECTOR_VERSION,
          shape: 'area',
          page: page.number,
          rect
        }
      }
    }
  }

  // Text markup: the quads the reader's app recorded for the selection, or the /Rect when the file
  // carries no quads (readers differ; the rectangle is what is left to anchor on).
  const fileQuads = quadBoxes(annotation.quadPoints)
  const fileRect = rectBox(annotation.rect)
  const boxes: UserSpaceBox[] = fileQuads ?? (fileRect ? [fileRect] : [])
  const rects = boxes
    .map((box) => normalizeBox(box, page))
    .filter((rect): rect is BookmarkRect => rect !== undefined)

  if (rects.length === 0) {
    return skip(
      subtype,
      'degenerate-geometry',
      `A "${subtype}" markup on page ${page.number} carries no rectangle with a measurable extent, so it would mark nothing on the page.`
    )
  }

  const quote = textUnderBoxes(boxes, page.items)
  if (!quote) {
    return skip(
      subtype,
      'no-text-under-markup',
      `A "${subtype}" markup on page ${page.number} covers no text in this file's text layer (a scanned page or an empty selection), so the passage it marked could not be quoted.`
    )
  }

  const content: PdfAnnotationContentInput = {
    kind,
    body,
    selector: {
      version: PDF_ANNOTATION_SELECTOR_VERSION,
      shape: 'text-range',
      page: page.number,
      rects,
      quote: quote.slice(0, PDF_EMBEDDED_MAX_QUOTE_CHARS)
    }
  }

  // The last line of defence before the store: the store refuses a kind/selector disagreement by
  // throwing, and an import writes its annotations one by one, so an invalid pair here would abort the
  // loop with half the file's markup already stored. The guards above make this unreachable today;
  // what it protects is the future change that makes one of them wrong.
  const failure = validatePdfAnnotationContent(content)
  if (failure) {
    return skip(
      subtype,
      'invalid-anchor',
      `A "${subtype}" markup on page ${page.number} could not be expressed as a valid anchor (${failure.message}); it was skipped rather than stored half-formed.`
    )
  }

  return { ok: true, kind, content }
}

// --- the report ------------------------------------------------------------------------------------

export const PDF_ANNOTATION_IMPORT_STATUSES = [
  'imported', // at least one annotation was written
  'no-annotations', // the file carries no annotations at all
  'no-supported-annotations', // it carries annotations, but none this build can import (all named)
  'unchanged' // this exact payload was already imported into this version
] as const
export type PdfAnnotationImportStatus = (typeof PDF_ANNOTATION_IMPORT_STATUSES)[number]

export type PdfAnnotationImportKindCount = { kind: PdfAnnotationKind; count: number }

// One group of annotations the import left behind: which subtype, why, and how many of them. Grouped
// by (subtype, reason) so the report is a short list a reader can read, with `detail` the first
// occurrence's explanation.
export type PdfAnnotationImportSkip = {
  subtype: string
  reason: PdfEmbeddedSkipReason
  count: number
  detail: string
}

export type PdfAnnotationImportCounts = {
  /** Annotations written by this call. */
  imported: number
  /** How many of them per kind, most frequent first. */
  kinds: readonly PdfAnnotationImportKindCount[]
  /** Everything in the file that was not imported, named. Empty only when everything was imported. */
  skipped: readonly PdfAnnotationImportSkip[]
}

// Folds the per-annotation decisions into what the report says: how many were imported, of which
// kinds, and every subtype that was left behind with the reason and its count. Order is stable
// (first appearance), so the same file always produces the same report.
export const summarizeEmbeddedImport = (
  mappings: readonly PdfEmbeddedAnnotationMapping[]
): PdfAnnotationImportCounts => {
  const kindCounts = new Map<PdfAnnotationKind, number>()
  const skipped: PdfAnnotationImportSkip[] = []
  const skipIndex = new Map<string, number>()
  let imported = 0

  for (const mapping of mappings) {
    if (mapping.ok) {
      imported += 1
      kindCounts.set(mapping.kind, (kindCounts.get(mapping.kind) ?? 0) + 1)
      continue
    }
    const key = `${mapping.subtype}\u0000${mapping.reason}`
    const existing = skipIndex.get(key)
    if (existing === undefined) {
      skipIndex.set(key, skipped.length)
      skipped.push({
        subtype: mapping.subtype,
        reason: mapping.reason,
        count: 1,
        detail: mapping.detail
      })
      continue
    }
    skipped[existing] = { ...skipped[existing]!, count: skipped[existing]!.count + 1 }
  }

  return {
    imported,
    kinds: [...kindCounts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind)),
    skipped
  }
}

// One import's outcome, as the caller (and later the UI) reads it. Every count is about THIS call; the
// file's own totals are `imported + sum(skipped)`.
export type PdfEmbeddedAnnotationImportReport = {
  sourceKind: 'embedded-pdf'
  sourceFileId: string
  versionId: string
  /** The version's content checksum, as the caller named it. */
  checksum: string
  /** sha256 of the bytes this import read — the payload digest, and the idempotency key with the anchor. */
  digest: string
  status: PdfAnnotationImportStatus
  imported: number
  kinds: readonly PdfAnnotationImportKindCount[]
  skipped: readonly PdfAnnotationImportSkip[]
  /** Pages the parser read. 0 for 'unchanged': nothing was read a second time. */
  pageCount: number
  /** The file's own annotation count. 0 for 'unchanged'. */
  annotationsInFile: number
  /** The receipt, once this payload has been imported into this version. */
  receipt?: PdfAnnotationImport
  /** Whether THIS call wrote the receipt. False for every status but 'imported'. */
  receiptCreated: boolean
}

// --- named failures ---------------------------------------------------------------------------------

export const PDF_ANNOTATION_IMPORT_FAILURE_CODES = [
  'missing-anchor', // the caller named no file/version/checksum to anchor to
  'checksum-mismatch', // the bytes are not the version the caller named
  'unreadable-pdf' // the file could not be parsed (damaged, truncated, or not a PDF)
] as const
export type PdfAnnotationImportFailureCode = (typeof PDF_ANNOTATION_IMPORT_FAILURE_CODES)[number]

// Thrown instead of a report when the import must not happen at all. A report is for an import that
// ran; a broken anchor or an unreadable file is not an outcome, it is a refusal — and both of them
// happen before the first write, so nothing is stored either way.
export class PdfAnnotationImportError extends Error {
  readonly code: PdfAnnotationImportFailureCode

  constructor(code: PdfAnnotationImportFailureCode, message: string) {
    super(message)
    this.name = 'PdfAnnotationImportError'
    this.code = code
  }
}
