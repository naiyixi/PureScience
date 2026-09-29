import { describe, expect, it, vi } from 'vitest'

import {
  PDF_EMBEDDED_UNNAMED_SUBTYPE,
  PdfAnnotationImportError
} from '../../shared/pdf-annotation-import'
import { readPdfEmbeddedAnnotations } from './pdf-embedded-annotation-reader'

// The parser ADAPTER, with the parser stubbed. This is the one seam where a mock is the right tool: what
// is under test is how this module handles the shapes a PDF library hands back (an indexed quad list, a
// missing transform, a page with no measurable box, a page that fails halfway), not what the library
// does with a real file — every one of those is covered by real PDFs in
// pdf-annotation-import.test.ts.
//
// It also pins the read INTENT. That line is not a detail: with the display intent pdf.js drops markups
// that have no /QuadPoints, silently, and a future "tidy-up" back to the default would undo the only
// reason an imported highlight can be anchored on the rectangle the file actually wrote.

const mocks = vi.hoisted(() => ({
  getDocument: vi.fn()
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument: mocks.getDocument }))

type FakePage = {
  view: unknown
  rotate?: unknown
  annotations?: unknown[]
  items?: unknown[]
  getAnnotations: ReturnType<typeof vi.fn>
  getTextContent: ReturnType<typeof vi.fn>
  cleanup: ReturnType<typeof vi.fn>
}

const fakePage = (overrides: Partial<FakePage> = {}): FakePage => {
  const page: FakePage = {
    view: [0, 0, 612, 792],
    rotate: 0,
    annotations: [],
    items: [],
    getAnnotations: vi.fn(),
    getTextContent: vi.fn(),
    cleanup: vi.fn(),
    ...overrides
  }
  page.getAnnotations.mockResolvedValue(page.annotations ?? [])
  page.getTextContent.mockResolvedValue({ items: page.items ?? [] })
  return page
}

const usePages = (pages: FakePage[]): ReturnType<typeof vi.fn> => {
  const destroy = vi.fn().mockResolvedValue(undefined)
  mocks.getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: pages.length,
      getPage: (pageNumber: number) => Promise.resolve(pages[pageNumber - 1]),
      destroy
    })
  })
  return destroy
}

const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])

describe('reading annotations out of a PDF', () => {
  it('asks for every annotation the file carries, not just the ones the library would display', async () => {
    const page = fakePage({
      annotations: [
        { subtype: 'Highlight', rect: [72, 698, 320, 714], contentsObj: { str: 'note' } }
      ]
    })
    usePages([page])

    const parsed = await readPdfEmbeddedAnnotations(bytes)

    // The ANY intent: a display read hides quad-less markups without telling anyone.
    expect(page.getAnnotations).toHaveBeenCalledWith({ intent: 'any' })
    expect(parsed).toMatchObject({ pageCount: 1 })
    expect(parsed.pages[0]).toMatchObject({ number: 1, width: 612, height: 792, rotate: 0 })
    expect(parsed.annotations).toEqual([
      {
        page: 1,
        subtype: 'Highlight',
        rect: [72, 698, 320, 714],
        quadPoints: undefined,
        contents: 'note',
        flags: 0
      }
    ])
  })

  it('reads a page’s text layer only when that page carries an annotation', async () => {
    const marked = fakePage({
      annotations: [{ subtype: 'Square', rect: [1, 1, 2, 2] }],
      items: [{}]
    })
    const unmarked = fakePage()
    usePages([marked, unmarked])

    const parsed = await readPdfEmbeddedAnnotations(bytes)

    expect(marked.getTextContent).toHaveBeenCalledTimes(1)
    expect(unmarked.getTextContent).not.toHaveBeenCalled()
    expect(parsed.pages[1]).toMatchObject({ number: 2, items: [] })
    // Both pages are still cleaned up, whether or not their text was read.
    expect(marked.cleanup).toHaveBeenCalledTimes(1)
    expect(unmarked.cleanup).toHaveBeenCalledTimes(1)
  })

  it('keeps the text items it can place and drops the ones the file left empty', async () => {
    const page = fakePage({
      rotate: undefined,
      annotations: [{ subtype: 'Square', rect: [1, 1, 2, 2] }],
      items: [
        { str: '   ', transform: [12, 0, 0, 12, 72, 700], width: 10, height: 12 },
        { str: 'placed', transform: [12, 0, 0, 12, 72, 660], width: 40, height: 12 },
        { str: 'no transform', width: 10, height: 12 },
        { str: 42 as unknown as string, transform: [1, 0, 0, 1, 5, 5] }
      ]
    })
    usePages([page])

    const parsed = await readPdfEmbeddedAnnotations(bytes)

    expect(parsed.pages[0]?.items).toEqual([
      { text: 'placed', x: 72, y: 660, width: 40, height: 12 },
      { text: 'no transform', x: 0, y: 0, width: 10, height: 12 }
    ])
    // A page whose /Rotate the library did not report is treated as unrotated, not as unknown.
    expect(parsed.pages[0]?.rotate).toBe(0)
  })

  it('reports a page box it cannot measure as zero, so nothing is normalized against a guess', async () => {
    const page = fakePage({
      view: 'not a box',
      annotations: [{ subtype: 'Square', rect: [1, 1, 2, 2] }]
    })
    usePages([page])

    const parsed = await readPdfEmbeddedAnnotations(bytes)

    expect(parsed.pages[0]).toMatchObject({ width: 0, height: 0 })
  })

  it('takes the comment and the flags off whichever shape the parser settled on', async () => {
    const page = fakePage({
      annotations: [
        // Some builds hand back `contents` as a plain string, and a flag that is not a number.
        { subtype: 'Text', rect: [1, 1, 2, 2], contents: 'plain string', annotationFlags: 'x' },
        // An annotation with no name at all is labelled, so the report can count it.
        { rect: [1, 1, 2, 2] }
      ]
    })
    usePages([page])

    const parsed = await readPdfEmbeddedAnnotations(bytes)

    expect(parsed.annotations).toEqual([
      {
        page: 1,
        subtype: 'Text',
        rect: [1, 1, 2, 2],
        quadPoints: undefined,
        contents: 'plain string',
        flags: 0
      },
      {
        page: 1,
        subtype: PDF_EMBEDDED_UNNAMED_SUBTYPE,
        rect: [1, 1, 2, 2],
        quadPoints: undefined,
        contents: '',
        flags: 0
      }
    ])
  })

  it('names a file the parser refuses, and a failure that happens halfway through', async () => {
    mocks.getDocument.mockReturnValue({
      promise: Promise.reject(new Error('Invalid PDF structure.'))
    })
    const refused = await readPdfEmbeddedAnnotations(bytes).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(PdfAnnotationImportError)
    expect((refused as PdfAnnotationImportError).code).toBe('unreadable-pdf')

    const failing = fakePage()
    failing.getTextContent.mockRejectedValue(new Error('page 1 is damaged'))
    failing.annotations = [{ subtype: 'Square', rect: [1, 1, 2, 2] }]
    failing.getAnnotations.mockResolvedValue(failing.annotations)
    const destroy = usePages([failing])

    const halfway = await readPdfEmbeddedAnnotations(bytes).catch((error: unknown) => error)

    expect((halfway as PdfAnnotationImportError).code).toBe('unreadable-pdf')
    expect((halfway as Error).message).toContain('page 1 is damaged')
    // The document is torn down even on the failure path.
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})
