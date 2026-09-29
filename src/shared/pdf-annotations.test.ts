import { describe, expect, it } from 'vitest'

import {
  PDF_ANNOTATION_KINDS,
  PDF_ANNOTATION_KIND_SHAPES,
  PDF_ANNOTATION_SELECTOR_SHAPES,
  PDF_ANNOTATION_SELECTOR_VERSION,
  isPdfAnnotationKind,
  resolvePdfAnnotationAnchorState,
  validatePdfAnnotationContent
} from './pdf-annotations'

// The kind ↔ selector agreement is the rule this module exists for, so it is pinned here field by
// field: every accepted combination is exercised, and every refusal is asserted down to the field it
// names — a rejection that does not say WHICH field disagreed is not something a caller can act on.

const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.04 }

const textRange = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: PDF_ANNOTATION_SELECTOR_VERSION,
  shape: 'text-range',
  page: 3,
  rects: [rect],
  quote: 'the passage that was marked',
  ...overrides
})

describe('PDF annotation kind/selector agreement', () => {
  it('accepts every kind with the one selector shape that kind declares', () => {
    for (const kind of PDF_ANNOTATION_KINDS) {
      const shape = PDF_ANNOTATION_KIND_SHAPES[kind]
      const selector =
        shape === 'text-range'
          ? textRange()
          : shape === 'area'
            ? { version: 1, shape: 'area', page: 3, rect }
            : shape === 'page-note'
              ? { version: 1, shape: 'page-note', page: 3, anchorRect: rect }
              : { version: 1, shape: 'document-note' }
      const body =
        shape === 'page-note' || shape === 'document-note' ? 'a note that says something' : ''
      expect(
        validatePdfAnnotationContent({ kind, selector, body }),
        `${kind} should accept its own shape`
      ).toBeUndefined()
    }
  })

  it('declares a shape for every kind and uses only declared shapes', () => {
    expect(Object.keys(PDF_ANNOTATION_KIND_SHAPES).sort()).toEqual([...PDF_ANNOTATION_KINDS].sort())
    for (const kind of PDF_ANNOTATION_KINDS) {
      expect(PDF_ANNOTATION_SELECTOR_SHAPES).toContain(PDF_ANNOTATION_KIND_SHAPES[kind])
    }
  })

  it('refuses a selector whose shape belongs to another kind, naming both', () => {
    const failure = validatePdfAnnotationContent({ kind: 'area', selector: textRange() })
    expect(failure?.code).toBe('selector-shape-mismatch')
    expect(failure?.message).toBe(
      'kind "area" needs selector shape "area", but the selector declares shape "text-range".'
    )

    const reversed = validatePdfAnnotationContent({
      kind: 'highlight',
      selector: { version: 1, shape: 'area', page: 3, rect }
    })
    expect(reversed?.code).toBe('selector-shape-mismatch')
    expect(reversed?.message).toContain('kind "highlight" needs selector shape "text-range"')
    expect(reversed?.message).toContain('declares shape "area"')
  })

  it('refuses a document note that carries a page, instead of ignoring the field', () => {
    const failure = validatePdfAnnotationContent({
      kind: 'document-note',
      selector: { version: 1, shape: 'document-note', page: 4 },
      body: 'whole-document remark'
    })
    expect(failure?.code).toBe('selector-shape-invalid')
    expect(failure?.message).toBe(
      'A "document-note" selector has no page, but the selector carries page 4.'
    )
  })

  it('refuses anchors that belong to a different shape on the same kind', () => {
    const failure = validatePdfAnnotationContent({
      kind: 'highlight',
      selector: textRange({ anchorRect: rect })
    })
    expect(failure?.code).toBe('selector-shape-invalid')
    expect(failure?.message).toBe(
      'kind "highlight" (selector shape "text-range") carries "anchorRect", which belongs to selector shape "page-note".'
    )
  })

  it('names the missing field for each malformed shape', () => {
    const noRects = validatePdfAnnotationContent({
      kind: 'underline',
      selector: textRange({ rects: [] })
    })
    expect(noRects?.code).toBe('selector-shape-invalid')
    expect(noRects?.message).toContain('"rects"')
    expect(noRects?.message).toContain('kind "underline" (selector shape "text-range")')

    const noQuote = validatePdfAnnotationContent({
      kind: 'squiggly',
      selector: textRange({ quote: '   ' })
    })
    expect(noQuote?.code).toBe('selector-shape-invalid')
    expect(noQuote?.message).toContain('"quote"')

    const badRect = validatePdfAnnotationContent({
      kind: 'strikethrough',
      selector: textRange({ rects: [rect, { x: 0.1, y: 0.2, width: 0, height: 0.04 }] })
    })
    expect(badRect?.code).toBe('selector-shape-invalid')
    expect(badRect?.message).toContain('entry 1')

    const noPage = validatePdfAnnotationContent({
      kind: 'page-note',
      selector: { version: 1, shape: 'page-note' },
      body: 'note'
    })
    expect(noPage?.code).toBe('selector-shape-invalid')
    expect(noPage?.message).toContain('"page"')

    const badAreaRect = validatePdfAnnotationContent({
      kind: 'area',
      selector: {
        version: 1,
        shape: 'area',
        page: 1,
        rect: { x: 0.5, y: 0.5, width: 1.2, height: 0.2 }
      }
    })
    expect(badAreaRect?.code).toBe('selector-shape-invalid')
    expect(badAreaRect?.message).toContain('"rect"')
  })

  it('refuses a selector written by a newer build rather than guessing at its fields', () => {
    const failure = validatePdfAnnotationContent({
      kind: 'highlight',
      selector: textRange({ version: 2 })
    })
    expect(failure?.code).toBe('unsupported-selector-version')
    expect(failure?.message).toContain('version 1')
    expect(failure?.message).toContain('version 2')
  })

  it('refuses an unknown kind, an unknown shape and a non-object selector', () => {
    const unknownKind = validatePdfAnnotationContent({ kind: 'squiggle', selector: textRange() })
    expect(unknownKind?.code).toBe('unknown-kind')
    expect(unknownKind?.message).toContain('"squiggle"')
    expect(unknownKind?.message).toContain('highlight')

    const unknownShape = validatePdfAnnotationContent({
      kind: 'highlight',
      selector: textRange({ shape: 'blob' })
    })
    expect(unknownShape?.code).toBe('unknown-selector-shape')
    expect(unknownShape?.message).toContain('"blob"')

    for (const selector of [undefined, null, 'text-range', [rect]]) {
      const failure = validatePdfAnnotationContent({ kind: 'highlight', selector })
      expect(failure?.code, `selector ${JSON.stringify(selector)} must be refused`).toBe(
        'missing-selector'
      )
    }
    expect(isPdfAnnotationKind('highlight')).toBe(true)
    expect(isPdfAnnotationKind('Highlight')).toBe(false)
  })

  it('requires note text for the two note kinds and a version envelope for every selector', () => {
    const emptyNote = validatePdfAnnotationContent({
      kind: 'page-note',
      selector: { version: 1, shape: 'page-note', page: 1 },
      body: '   '
    })
    expect(emptyNote?.code).toBe('empty-note-body')
    expect(emptyNote?.message).toContain('page-note')

    const emptyDocumentNote = validatePdfAnnotationContent({
      kind: 'document-note',
      selector: { version: 1, shape: 'document-note' }
    })
    expect(emptyDocumentNote?.code).toBe('empty-note-body')

    // A markup needs no body — the quoted passage is its content.
    expect(
      validatePdfAnnotationContent({ kind: 'highlight', selector: textRange(), body: '' })
    ).toBeUndefined()

    const missingVersion = validatePdfAnnotationContent({
      kind: 'highlight',
      selector: { shape: 'text-range', page: 1, rects: [rect], quote: 'x' }
    })
    expect(missingVersion?.code).toBe('unsupported-selector-version')
    expect(missingVersion?.message).toContain('declares version nothing')
  })
})

describe('PDF annotation version anchor', () => {
  const annotation = { versionId: 'version-2', checksum: 'a'.repeat(64) }

  it('is current when the version and its bytes are the ones it was drawn on', () => {
    expect(
      resolvePdfAnnotationAnchorState(annotation, {
        versionId: 'version-2',
        checksum: 'a'.repeat(64)
      })
    ).toBe('current')
  })

  it('names the two ways an anchor stops matching instead of re-pointing it', () => {
    expect(
      resolvePdfAnnotationAnchorState(annotation, {
        versionId: 'version-3',
        checksum: 'b'.repeat(64)
      })
    ).toBe('version-changed')
    expect(
      resolvePdfAnnotationAnchorState(annotation, {
        versionId: 'version-2',
        checksum: 'b'.repeat(64)
      })
    ).toBe('checksum-mismatch')
  })
})
