import { describe, expect, it } from 'vitest'

import { validatePdfAnnotationContent } from '../../../../../../shared/pdf-annotations'
import {
  PDF_ANNOTATION_NOTE_PIN_SIZE,
  pdfAnnotationAreaSelector,
  pdfAnnotationNoteAnchor,
  pdfAnnotationPageNoteSelector,
  pdfAnnotationTextRangeSelector
} from './pdf-annotation-content'
import { markRectsOf, pdfAnnotationMarks } from './pdf-annotation-marks'
import type { PdfAnnotationView } from '../../../../../../shared/pdf-annotation-surface'
import type { PdfAnnotation } from '../../../../../../shared/pdf-annotations'

// The selectors the window builds, checked against the store's OWN rule rather than against a copy of it:
// every one of them is handed to `validatePdfAnnotationContent` here, so a shape that the write path
// would refuse fails in this suite first.

const RECT = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }

const annotation = (overrides: Partial<PdfAnnotation> = {}): PdfAnnotation => ({
  id: 'annotation-1',
  sourceFileId: 'artifact-1',
  versionId: 'version-1',
  checksum: 'a'.repeat(64),
  kind: 'area',
  selector: pdfAnnotationAreaSelector(1, RECT),
  body: '',
  createdAt: 1,
  ...overrides
})

const view = (
  overrides: Partial<PdfAnnotation> = {},
  anchorState: PdfAnnotationView['anchorState'] = 'current'
): PdfAnnotationView => ({ annotation: annotation(overrides), anchorState })

describe('annotation content built from a gesture', () => {
  it('builds an area selector the store accepts', () => {
    expect(
      validatePdfAnnotationContent({ kind: 'area', selector: pdfAnnotationAreaSelector(3, RECT) })
    ).toBeUndefined()
  })

  it('builds a text-range selector carrying every rect and the quote', () => {
    const selection = { quote: 'the effect is large', rects: [RECT, { ...RECT, y: 0.5 }] }
    const selector = pdfAnnotationTextRangeSelector(2, selection)

    expect(selector).toMatchObject({ shape: 'text-range', page: 2, quote: 'the effect is large' })
    expect(markRectsOf(annotation({ kind: 'highlight', selector }))).toEqual(selection.rects)
    for (const kind of ['highlight', 'underline'] as const) {
      expect(validatePdfAnnotationContent({ kind, selector, body: '' })).toBeUndefined()
    }
  })

  it('builds a page note anchored where the reader clicked', () => {
    const anchor = pdfAnnotationNoteAnchor({ x: 0.5, y: 0.5 })
    const selector = pdfAnnotationPageNoteSelector(1, anchor)

    expect(
      validatePdfAnnotationContent({ kind: 'page-note', selector, body: 'worth keeping' })
    ).toBeUndefined()
    expect(anchor.width).toBe(PDF_ANNOTATION_NOTE_PIN_SIZE)
  })

  it('keeps a note placed at the page edge inside the page box', () => {
    // A pin whose rectangle ran off the page would be drawn at the edge and never openable again where it
    // was written.
    for (const point of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0.999, y: 0.001 }
    ]) {
      const anchor = pdfAnnotationNoteAnchor(point)
      expect(anchor.x).toBeGreaterThanOrEqual(0)
      expect(anchor.y).toBeGreaterThanOrEqual(0)
      expect(anchor.x + anchor.width).toBeLessThanOrEqual(1)
      expect(anchor.y + anchor.height).toBeLessThanOrEqual(1)
      expect(
        validatePdfAnnotationContent({
          kind: 'page-note',
          selector: pdfAnnotationPageNoteSelector(1, anchor),
          body: 'near the edge'
        })
      ).toBeUndefined()
    }
  })
})

describe('what the page draws', () => {
  it('draws the version on screen and never another version', () => {
    const marks = pdfAnnotationMarks([
      view(),
      view({ id: 'annotation-2' }, 'version-changed'),
      view({ id: 'annotation-3' }, 'checksum-mismatch')
    ])

    // One drawing, from the one annotation that is anchored to these bytes. The other two are the panel's
    // business: painting them here would be a silent migration performed by the renderer.
    expect(marks).toEqual([{ annotationId: 'annotation-1', kind: 'area', page: 1, rect: RECT }])
  })

  it('draws nothing for a document note, which belongs to no page', () => {
    expect(
      markRectsOf(
        annotation({
          kind: 'document-note',
          selector: { version: 1, shape: 'document-note' }
        })
      )
    ).toEqual([])
  })

  it('draws a placed note at its anchor rectangle and a note with none at all', () => {
    expect(
      markRectsOf(
        annotation({
          kind: 'page-note',
          selector: { version: 1, shape: 'page-note', page: 1, anchorRect: RECT }
        })
      )
    ).toEqual([RECT])
    expect(
      markRectsOf(
        annotation({ kind: 'page-note', selector: { version: 1, shape: 'page-note', page: 1 } })
      )
    ).toEqual([])
  })
})
