// The page text of the real pdfjs parse path.
//
// Every other test in this suite injects `parsePdf`, so none of them can see how a page's text is assembled —
// and that is exactly where a real page used to come out as one run-on string (pdfjs ends lines with `hasEOL`
// and delivers spaces as their own items). Here the service runs its OWN parser against a stubbed pdfjs whose
// items are shaped like the real ones, and the text is read back through `pages()` (persistence included).

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PdfService } from './pdf-service'

type FakeItem = {
  str: string
  transform: number[]
  width?: number
  height?: number
  hasEOL?: boolean
}

// One entry per page. `view`/operators are not needed: the pages here carry no images.
let fakePages: FakeItem[][]

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: fakePages.length,
      getPage: async (pageNumber: number) => ({
        getTextContent: async () => ({ items: fakePages[pageNumber - 1] ?? [] }),
        getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
        cleanup: () => {}
      }),
      getOutline: async () => [],
      destroy: async () => {}
    })
  }),
  OPS: {
    transform: 0,
    paintImageXObject: 1,
    paintInlineImageXObject: 2,
    paintImageMaskXObject: 3
  }
}))

// A run of one line's text at a baseline. pdfjs puts the words and the spaces in separate items, so the fixture
// does too — assembling them is the behaviour under test.
const lineItems = (words: string[], y: number, options: { endOfLine?: boolean } = {}): FakeItem[] =>
  words
    .flatMap((word, index) => {
      const x = 16.6 + index * 40
      const items: FakeItem[] = [
        { str: word, transform: [12, 0, 0, 12, x, y], width: 34, height: 12 }
      ]
      if (index < words.length - 1)
        items.push({ str: ' ', transform: [12, 0, 0, 12, x + 34, y], width: 6 })
      return items
    })
    .concat(
      // The empty item pdfjs appends as the line's end marker, then the marker itself on the last run.
      options.endOfLine === false
        ? []
        : [
            {
              str: '',
              transform: [12, 0, 0, 12, 16.6, y],
              width: 0,
              height: 0,
              hasEOL: true
            }
          ]
    )

let root: string
let pdfPath: string

const serviceForRealParser = (): PdfService =>
  new PdfService({
    storageRoot: root,
    resolvePath: async (path) => (path.startsWith('/') ? path : join(root, path))
  })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pdf-svc-page-text-'))
  pdfPath = join(root, 'paper.pdf')
  writeFileSync(pdfPath, '%PDF-1.4 fake')
})

describe('parsePdf page text', () => {
  it('keeps the lines of a real page instead of gluing the last word to the first of the next', async () => {
    fakePages = [
      [
        // Heading, then a paragraph whose two lines share a paragraph (pitch 12, paragraph gap 24).
        ...lineItems(['Abstract'], 763.284),
        ...lineItems(['We', 'report', 'a', 'pipeline.'], 739.284),
        ...lineItems(['It', 'runs', 'on', 'the', 'receptor.'], 727.284)
      ]
    ]

    const service = serviceForRealParser()
    const opened = await service.open(pdfPath)
    const page = await service.pages(opened.doc.docId, 1)

    // The defect this replaces: "pipeline.It" / "the receptor." glued into the previous line's last word.
    expect(page.pages[0]?.text).toBe('Abstract\n\nWe report a pipeline. It runs on the receptor.')
    expect(page.pages[0]?.text).not.toContain('pipeline.It')
    expect(page.pages[0]?.text).not.toContain('receptor.We')
  })

  it('falls back to the baselines for a parser that reports no end-of-line markers', async () => {
    fakePages = [
      [
        ...lineItems(['first', 'line'], 100, { endOfLine: false }),
        ...lineItems(['second', 'line'], 88, { endOfLine: false }),
        ...lineItems(['third', 'line'], 64, { endOfLine: false })
      ]
    ]

    const service = serviceForRealParser()
    const opened = await service.open(pdfPath)
    const page = await service.pages(opened.doc.docId, 1)

    expect(page.pages[0]?.text).toBe('first line second line\n\nthird line')
  })

  it('still reports a page with no text layer as an empty page', async () => {
    fakePages = [
      [
        {
          str: 'Title text',
          transform: [12, 0, 0, 12, 16.6, 700],
          width: 60,
          height: 12,
          hasEOL: true
        }
      ],
      // A scanned page: pdfjs reports runs, but none of them is text.
      [{ str: '   ', transform: [12, 0, 0, 12, 16.6, 700], width: 0, height: 12, hasEOL: true }]
    ]

    const service = serviceForRealParser()
    const opened = await service.open(pdfPath)

    expect(opened.textPageCount).toBe(1)
    expect(opened.emptyPageCount).toBe(1)
    const page = await service.pages(opened.doc.docId, 1, 2)
    expect(page.pages.map((entry) => entry.text)).toEqual(['Title text', ''])
  })
})
