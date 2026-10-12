// The translation run over the app's own PDF page text.
//
// The unit tests above hand the run page strings directly. This one drives the real chain the tool uses: the
// app's PdfService parses a document (pdfjs stubbed with items shaped like the real ones), `pages()` returns
// the assembled page text, the run turns that into paragraph records on disk, and a SECOND call — which
// builds its own store, exactly what a restart gives the next invocation — proves the reuse instead of being
// told about it.

import { mkdtempSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { PdfService } from '../settings/pdf-service'
import { TranslationCheckpointStore } from './checkpoint-store'
import { runDocumentTranslation } from './document-translation'

type FakeItem = {
  str: string
  transform: number[]
  width?: number
  height?: number
  hasEOL?: boolean
}

// One entry per page. Word runs and their spaces are separate items, and each visual line ends with an item
// carrying `hasEOL` — the shape pdfjs actually produces.
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

const lineItems = (words: string[], y: number, endOfLine = false): FakeItem[] => {
  const items: FakeItem[] = []
  words.forEach((word, index) => {
    const x = 16.6 + index * 40
    items.push({ str: word, transform: [12, 0, 0, 12, x, y], width: 34, height: 12 })
    if (index < words.length - 1) {
      items.push({ str: ' ', transform: [12, 0, 0, 12, x + 34, y], width: 6 })
    }
  })
  if (endOfLine) items.push({ str: '', transform: [1, 0, 0, 1, 0, y], hasEOL: true })
  return items
}

// Two paragraphs on page 1 (one paragraph of two wrapped lines, then a 48 pt gap the page does not use
// anywhere else) and one paragraph on page 2.
const twoPagePaper = (): FakeItem[][] => [
  [
    ...lineItems(['We', 'report', 'a', 'pipeline.'], 700, true),
    ...lineItems(['It', 'runs.'], 688, true),
    ...lineItems(['Second', 'paragraph.'], 640, true)
  ],
  [...lineItems(['Abstract', 'page.'], 700, true)]
]

const readPages = async (): Promise<{ page: number; text: string }[]> => {
  const root = mkdtempSync(join(tmpdir(), 'ps-translation-pdf-'))
  // The service reads the file before it parses; pdfjs itself is stubbed, so the bytes only have to exist.
  const paper = join(root, 'paper.pdf')
  await writeFile(paper, '%PDF-1.4\n', 'utf8')
  const service = new PdfService({
    storageRoot: root,
    resolvePath: async (path) => path
  })
  const opened = await service.open(paper, 'project-1')
  const read = await service.pages(opened.doc.docId, 1, opened.doc.pageCount)
  return read.pages.map((page) => ({ page: page.page, text: page.text }))
}

/** Answers per request, so a reused paragraph is distinguishable from a re-translated one by its text. */
const makeFetch = (
  answer: (asked: string) => string
): { fetchImpl: typeof fetch; asked: string[] } => {
  const asked: string[] = []
  const mock = vi.fn(async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages: { role: string; content: string }[]
    }
    const question = body.messages.at(-1)?.content ?? ''
    asked.push(question)
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: answer(question) } }] })
    }
  })
  return { fetchImpl: mock as unknown as typeof fetch, asked }
}

describe('translation over the app’s own parsed page text', () => {
  it('turns parsed pages into paragraph records and resumes them from a fresh reader', async () => {
    fakePages = twoPagePaper()
    const documentPages = await readPages()
    const storeRoot = mkdtempSync(join(tmpdir(), 'ps-translation-store-'))

    const first = makeFetch((asked) => `译:${asked}`)
    const runOne = await runDocumentTranslation({
      docId: 'doc-live',
      documentPages,
      storageRoot: storeRoot,
      targetLanguage: 'Simplified Chinese',
      target: () => ({
        ok: true,
        target: { url: 'https://example.test/v1/chat/completions', model: 'm' }
      }),
      fetchImpl: first.fetchImpl
    })
    if (!runOne.ok) throw new Error(`unreachable: ${runOne.detail}`)

    // The real page text drives the paragraph split, so the ids and the sources are the document's own.
    expect(first.asked).toHaveLength(3)
    const firstPage = runOne.result.pages[0]?.paragraphs ?? []
    expect(firstPage).toHaveLength(2)
    expect(firstPage[0]?.source).toContain('pipeline')
    expect(firstPage[1]?.source).toBe('Second paragraph.')
    expect(firstPage[0]?.translation).toBe(`译:${firstPage[0]?.source}`)
    expect(runOne.result.pages[1]?.paragraphs[0]?.source).toBe('Abstract page.')
    expect(runOne.result.emptyPages).toEqual([])

    // The records are on disk: read the checkpoint file back by hand rather than through the store.
    const recordsRaw = JSON.parse(
      await readFile(
        new TranslationCheckpointStore({ root: storeRoot }).pathFor({
          kind: 'pdf',
          id: 'doc-live'
        }),
        'utf8'
      )
    ) as { records: Record<string, { status: string; text?: string }> }
    expect(Object.keys(recordsRaw.records).sort()).toEqual(['p1#1', 'p1#2', 'p2#1'])
    expect(recordsRaw.records['p1#1']?.status).toBe('translated')

    // A second call builds its own store over the same root — what a restart gives the next invocation — and
    // whatever it reuses has to have come from that file, not from anything remembered in a process.
    const second = makeFetch(() => 'again')
    const runTwo = await runDocumentTranslation({
      docId: 'doc-live',
      documentPages,
      storageRoot: storeRoot,
      targetLanguage: 'Simplified Chinese',
      target: () => ({
        ok: true,
        target: { url: 'https://example.test/v1/chat/completions', model: 'm' }
      }),
      fetchImpl: second.fetchImpl
    })
    if (!runTwo.ok) throw new Error(`unreachable: ${runTwo.detail}`)

    expect(second.asked).toEqual([])
    expect(runTwo.result.reused).toBe(3)
    expect(runTwo.result.translated).toBe(0)
    expect(runTwo.result.restored).toEqual({ state: 'partial', records: 3 })
    expect(runTwo.result.pages[0]?.paragraphs[0]?.translation).toBe(`译:${firstPage[0]?.source}`)
  })
})
