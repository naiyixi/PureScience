// PDF-explore service tests: open/pages/outline/scan with an injected parser (pdfjs mocked),
// bounds enforcement, and persistence.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import type { PdfTextItem } from '../../shared/pdf-table-extraction'
import { PdfService, PdfValidationError, type PdfServiceOptions } from './pdf-service'

let root: string
let service: PdfService
let pdfPath: string

// Mock the pdfjs parse path: extractPdfText-like behavior is exercised by the uploads tests;
// here we stub the module so open() can run without a real PDF.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pdf-svc-'))
  pdfPath = join(root, 'paper.pdf')
  writeFileSync(pdfPath, '%PDF-1.4 fake')
  service = new PdfService({
    storageRoot: root,
    resolvePath: async (path) => (path.startsWith('/') ? path : join(root, path)),
    parsePdf: fakeParser(['Introduction text', 'Methods section', 'Results'])
  })
})

const fakeParser = (pages: string[], outline: unknown[] = []) => {
  const outlineEntries = outline.map((entry) => ({
    title: String((entry as { title?: string }).title ?? ''),
    page:
      (entry as { dest?: { num?: number } }).dest?.num !== undefined
        ? (entry as { dest: { num: number } }).dest.num + 1
        : 1,
    level: 1
  }))
  return async (filePath: string) => ({
    pages,
    outline: outlineEntries,
    title:
      filePath
        .split('/')
        .pop()
        ?.replace(/\.pdf$/i, '') ?? 'doc'
  })
}

// The service persists what it opened; the summary it hands the renderer is deliberately root-independent.
const readPersistedDoc = async (): Promise<{ sourcePath?: string; sourceSessionId?: string }> => {
  const entries = await readdir(root, { recursive: true })
  const docFile = entries.find((entry) => entry.endsWith('.json'))
  if (!docFile) throw new Error('no persisted PDF document')
  return JSON.parse(await readFile(join(root, docFile), 'utf8')) as {
    sourcePath?: string
    sourceSessionId?: string
  }
}

const makeService = (pages: string[], outline: unknown[] = []): PdfService =>
  new PdfService({
    storageRoot: root,
    resolvePath: async (path) => (path.startsWith('/') ? path : join(root, path)),
    parsePdf: fakeParser(pages, outline)
  })

describe('PdfService', () => {
  it('opens a PDF, persists page text, and reports the summary', async () => {
    const svc = makeService(['Introduction text', 'Methods section', 'Results'])
    const result = await svc.open(pdfPath)
    expect(result.doc.pageCount).toBe(3)
    expect(result.textPageCount).toBe(3)
    expect(result.emptyPageCount).toBe(0)
    expect(result.doc.docId).toMatch(/^[0-9a-f]{16}$/)
  })

  it('counts empty (image-only) pages', async () => {
    const svc = makeService(['has text', '', ''])
    const result = await svc.open(pdfPath)
    expect(result.textPageCount).toBe(1)
    expect(result.emptyPageCount).toBe(2)
  })

  it('reads a page range (1-indexed, inclusive)', async () => {
    const svc = makeService(['p1', 'p2', 'p3'])
    const { doc } = await service.open(pdfPath)
    const pages = await svc.pages(doc.docId, 2, 3)
    expect(pages.start).toBe(2)
    expect(pages.end).toBe(3)
    expect(pages.pages.map((p) => p.page)).toEqual([2, 3])
  })

  it('reads a single page when end is omitted', async () => {
    const svc = makeService(['p1', 'p2'])
    const { doc } = await service.open(pdfPath)
    const pages = await svc.pages(doc.docId, 1)
    expect(pages.pages).toHaveLength(1)
    expect(pages.pages[0]?.page).toBe(1)
  })

  it('clamps out-of-range end to the page count', async () => {
    const svc = makeService(['p1', 'p2'])
    const { doc } = await svc.open(pdfPath)
    const pages = await svc.pages(doc.docId, 1, 99)
    expect(pages.end).toBe(2)
  })

  it('extracts the outline from bookmarks', async () => {
    const outline = [
      { title: 'Introduction', dest: [{ num: 0, gen: 0 }], items: [] },
      { title: 'Methods', dest: [{ num: 2, gen: 0 }], items: [] }
    ]
    const svc = makeService(['', '', ''], outline)
    const result = await svc.open(pdfPath)
    expect(result.doc.outline).toHaveLength(2)
    expect(result.doc.outline[1]?.title).toBe('Methods')
  })

  it('scans pages by term frequency and ranks them', async () => {
    const svc = makeService([
      'Introduction about language models',
      'Methods: we use transformer attention for language modelling',
      'Related work on attention mechanisms and attention models',
      'Results and conclusion'
    ])
    const { doc } = await svc.open(pdfPath)
    const scan = await svc.scan(doc.docId, 'attention language')
    expect(scan.hits.length).toBeGreaterThan(0)
    // Page 3 mentions attention twice; page 2 mentions both terms once.
    expect(scan.hits[0]?.page).toBe(3)
    expect(scan.hits[0]?.snippet).toContain('attention')
  })

  it('returns empty hits for a query with no matches', async () => {
    const svc = makeService(['nothing here', 'still nothing'])
    const { doc } = await svc.open(pdfPath)
    const scan = await svc.scan(doc.docId, 'zzzzz')
    expect(scan.hits).toHaveLength(0)
  })

  it('rejects unknown doc ids', async () => {
    await expect(service.pages('nope', 1)).rejects.toThrow(PdfValidationError)
    await expect(service.outline('nope')).rejects.toThrow(/No registered PDF/)
    await expect(service.scan('nope', 'x')).rejects.toThrow(PdfValidationError)
  })

  it('enforces the page-count and total-char bounds', async () => {
    const big = makeService(Array.from({ length: 600 }, () => 'x'))
    await expect(big.open(pdfPath)).rejects.toThrow(/500-page limit/)
    // 200 pages × 6000 chars (the per-page cap) = 1.2M chars > the 1M document cap.
    const huge = makeService(Array.from({ length: 200 }, () => 'x'.repeat(6000)))
    await expect(huge.open(pdfPath)).rejects.toThrow(/char limit/)
  })

  // A PDF opened from an Artifact card is identified by its Version, not by a path: without resolving that
  // identity first, opening a generated file fails with ENOENT and the reader never runs.
  it('resolves an Artifact Version locator through the Session that owns it', async () => {
    const seen: string[] = []
    const svc = new PdfService({
      storageRoot: root,
      resolvePath: async (path) => (path.startsWith('/') ? path : join(root, path)),
      parsePdf: async (filePath: string) => {
        seen.push(`parse:${filePath}`)
        return { pages: ['page one'], outline: [], title: 'table-evidence' }
      },
      resolveSessionArtifactPath: async (projectId, sessionId, path) => {
        seen.push(`artifact:${projectId}:${sessionId}:${path}`)
        return pdfPath
      }
    })
    const locator = 'artifact-version:proj-1/session-1/artifact-1/version-1'

    const result = await svc.open(locator, 'proj-1', 'session-1')

    expect(seen).toEqual([`artifact:proj-1:session-1:${locator}`, `parse:${pdfPath}`])
    // The identity is what the Session keeps, so later reads of the same document resolve it the same way.
    const persisted = await readPersistedDoc()
    expect(persisted.sourcePath).toBe(locator)
    expect(persisted.sourceSessionId).toBe('session-1')
    expect(result.doc.docId).toBeTruthy()
  })

  // Without a Session there is nothing to resolve the identity against, so the path is used as given.
  it('leaves a locator alone when no Session can resolve it', async () => {
    const locator = 'artifact-version:proj-1/session-1/artifact-1/version-1'
    const svc = new PdfService({
      storageRoot: root,
      resolvePath: async (path) => path,
      parsePdf: fakeParser(['page one']),
      resolveSessionArtifactPath: async () => {
        throw new Error('must not be called without a Session')
      }
    })

    await svc.open(locator, 'proj-1')

    expect((await readPersistedDoc()).sourcePath).toBe(locator)
  })
})

// The tables result has to answer "why is this page not a table" without being asked: a bare empty list
// reads as "these pages have no tables", which is a claim the reader cannot make.
describe('PdfService.tables rejection reasons', () => {
  const item = (text: string, x: number, y: number, width = text.length * 5): PdfTextItem => ({
    text,
    x,
    y,
    width,
    height: 10
  })

  // A parser that can position items (the geometry path). An EMPTY item list on a page means that page has
  // text but no coordinates — the weaker whitespace method's territory, named as such.
  const parserWithPositions =
    (pages: string[], items: PdfTextItem[][]): PdfServiceOptions['parsePdf'] =>
    async () => ({ pages, outline: [], title: 'positioned', items })

  const serviceFor = (pages: string[], items: PdfTextItem[][]): PdfService =>
    new PdfService({
      storageRoot: root,
      resolvePath: async (path) => (path.startsWith('/') ? path : join(root, path)),
      parsePdf: parserWithPositions(pages, items)
    })

  it('adds no reasons when the scan found a candidate', async () => {
    const svc = serviceFor(
      ['Site Value\ncontrol 12.4', 'plain prose that carries no grid'],
      [
        [
          item('Site', 40, 700),
          item('Value', 120, 700),
          item('control', 40, 686),
          item('12.4', 120, 686)
        ],
        [item('plain prose', 40, 700), item('that carries no grid', 150, 700)]
      ]
    )
    const { doc } = await svc.open(pdfPath)

    const result = await svc.tables(doc.docId)

    expect(result.candidates.length).toBeGreaterThan(0)
    // Page 2 would have failed a gate, and it is still not reported: next to a real table the reasons are
    // noise, and the field is absent rather than empty so it cannot be mistaken for "no page failed".
    expect(result.rejectedPages).toBeUndefined()
  })

  it('names the gate each scanned page failed, with the counts, when nothing was found', async () => {
    const svc = serviceFor(
      ['alpha\nbeta', 'text that has no coordinates', ''],
      [[item('alpha', 40, 700), item('beta', 40, 686)], [], []]
    )
    const { doc } = await svc.open(pdfPath)

    const result = await svc.tables(doc.docId)

    expect(result.candidates).toEqual([])
    expect(result.scannedPages).toBe(3)
    expect(result.rejectedPages).toEqual([
      {
        page: 1,
        reason: 'too-few-columns',
        counts: { itemCount: 2, rows: 2, columns: 1, spanningRows: 0 },
        thresholds: { minRows: 2, minColumns: 2 }
      },
      {
        page: 2,
        reason: 'no-positioned-text',
        counts: { itemCount: 0, rows: 0, columns: 0, spanningRows: 0 },
        thresholds: { minRows: 2, minColumns: 2 }
      },
      {
        page: 3,
        reason: 'blank-page',
        counts: { itemCount: 0, rows: 0, columns: 0, spanningRows: 0 },
        thresholds: { minRows: 2, minColumns: 2 }
      }
    ])
  })

  it('scopes the reasons to the single page that was asked for', async () => {
    const svc = serviceFor(
      ['Site Value\ncontrol 12.4', 'prose only here'],
      [
        [
          item('Site', 40, 700),
          item('Value', 120, 700),
          item('control', 40, 686),
          item('12.4', 120, 686)
        ],
        [item('prose only here', 40, 700)]
      ]
    )
    const { doc } = await svc.open(pdfPath)

    const withTable = await svc.tables(doc.docId, 1)
    const without = await svc.tables(doc.docId, 2)

    expect(withTable.candidates).toHaveLength(1)
    expect(withTable.rejectedPages).toBeUndefined()
    expect(without.candidates).toEqual([])
    expect(without.rejectedPages).toEqual([
      {
        page: 2,
        reason: 'too-few-rows',
        counts: { itemCount: 1, rows: 1, columns: 1, spanningRows: 0 },
        thresholds: { minRows: 2, minColumns: 2 }
      }
    ])
  })
})
