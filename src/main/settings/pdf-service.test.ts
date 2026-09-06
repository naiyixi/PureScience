// PDF-explore service tests: open/pages/outline/scan with an injected parser (pdfjs mocked),
// bounds enforcement, and persistence.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { PdfService, PdfValidationError } from './pdf-service'

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
})
