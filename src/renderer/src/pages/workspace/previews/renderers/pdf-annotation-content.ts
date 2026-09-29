import type { BookmarkRect } from '../../../../../../shared/bookmark'
import {
  PDF_ANNOTATION_SELECTOR_VERSION,
  type PdfAnnotationSelector
} from '../../../../../../shared/pdf-annotations'
import type { PdfTextSelection } from './pdf-annotation-selection'

// Building the selector for a gesture the reader just made (文档标注层 A3), in one place.
//
// Every builder stamps the envelope `version` here rather than at each call site, so a selector written by
// this file is one the store's own validator can read: the version is the anchor vocabulary's, and a build
// that changes it changes it once. The shapes themselves are the ones `validatePdfAnnotationContent`
// requires for each kind — an area selector carrying `rects`, or a text range carrying `rect`, is refused
// by name, which is exactly why the shape is decided here and not by the caller.

// The box a note placed by a click occupies: small enough to read as a pin, large enough to be a
// rectangle with an extent (a zero-sized rectangle is refused everywhere else in the app).
export const PDF_ANNOTATION_NOTE_PIN_SIZE = 0.03

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000

/**
 * Where a note placed at `point` sits on the page.
 *
 * Clamped so the whole pin stays inside the page box: a note whose rectangle ran off the page would be
 * drawn at the edge and never openable again at the place it was written.
 */
export const pdfAnnotationNoteAnchor = (point: { x: number; y: number }): BookmarkRect => {
  const span = PDF_ANNOTATION_NOTE_PIN_SIZE
  const limit = 1 - span
  return {
    x: round4(Math.min(Math.max(point.x - span / 2, 0), limit)),
    y: round4(Math.min(Math.max(point.y - span / 2, 0), limit)),
    width: span,
    height: span
  }
}

export const pdfAnnotationAreaSelector = (
  page: number,
  rect: BookmarkRect
): PdfAnnotationSelector => ({
  version: PDF_ANNOTATION_SELECTOR_VERSION,
  shape: 'area',
  page,
  rect
})

export const pdfAnnotationTextRangeSelector = (
  page: number,
  selection: PdfTextSelection
): PdfAnnotationSelector => ({
  version: PDF_ANNOTATION_SELECTOR_VERSION,
  shape: 'text-range',
  page,
  rects: selection.rects,
  quote: selection.quote
})

export const pdfAnnotationPageNoteSelector = (
  page: number,
  anchorRect: BookmarkRect
): PdfAnnotationSelector => ({
  version: PDF_ANNOTATION_SELECTOR_VERSION,
  shape: 'page-note',
  page,
  anchorRect
})
