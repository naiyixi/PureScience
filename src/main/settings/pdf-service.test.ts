// PDF-explore service tests: open/pages/outline/scan with an injected parser (pdfjs mocked),
// bounds enforcement, and persistence.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import type { AxisAlignedRotation } from '../../shared/pdf-page-rotation'
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

// A rotated content stream is turned back to upright before anything is measured, and the result SAYS so —
// regardless of whether a candidate came off the page, because a table read from a rotated page is exactly
// the case where the numbers look shifted against the page as displayed.
describe('PdfService.tables rotated pages', () => {
  const item = (text: string, x: number, y: number, width = text.length * 5): PdfTextItem => ({
    text,
    x,
    y,
    width,
    height: 10
  })

  // A 2x2 grid on page 1, prose on page 2, with the rotation each page was read at.
  const table = [
    item('Site', 40, 700),
    item('Value', 120, 700),
    item('control', 40, 686),
    item('12.4', 120, 686)
  ]
  const prose = [item('plain prose', 40, 700), item('with no grid', 150, 700)]

  const serviceFor = (rotations: AxisAlignedRotation[]): PdfService =>
    new PdfService({
      storageRoot: root,
      resolvePath: async (path) => (path.startsWith('/') ? path : join(root, path)),
      parsePdf: async () => ({
        pages: ['Site Value\ncontrol 12.4', 'plain prose with no grid'],
        outline: [],
        title: 'rotated',
        items: [table, prose],
        pageRotations: rotations
      })
    })

  it('names the rotated page even when a table was read off it', async () => {
    const svc = serviceFor([90, 0])
    const { doc } = await svc.open(pdfPath)

    const result = await svc.tables(doc.docId)

    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.rotatedPages).toEqual([{ page: 1, rotation: 90 }])
  })

  it('leaves the field absent — not empty — when every page was already upright', async () => {
    const svc = serviceFor([0, 0])
    const { doc } = await svc.open(pdfPath)

    const result = await svc.tables(doc.docId)

    expect(result.rotatedPages).toBeUndefined()
  })

  it('scopes the rotated pages to the page that was asked for', async () => {
    const svc = serviceFor([90, 0])
    const { doc } = await svc.open(pdfPath)

    const pageTwo = await svc.tables(doc.docId, 2)

    expect(pageTwo.rotatedPages).toBeUndefined()
  })
})

// U4：插图理解的第一层 —— `figures()` 现在给每张图带上「是哪一类 + 凭哪条证据判的」。这里钉住三件事：
// 图注能判类、图框内的文字项也能判类（来源要分开写）、判不出时如实写 undetermined 而不是落一个默认类别。
describe('PdfService.figures understanding', () => {
  const item = (text: string, x: number, y: number, width = text.length * 5): PdfTextItem => ({
    text,
    x,
    y,
    width,
    height: 10
  })

  // 300x200 的一块（远大于抽取器 60x60 的下限），图注放在它下面 20 点处（在 72 点窗口内）。
  const placement = { x: 100, y: 300, width: 300, height: 200 }

  const serviceFor = (items: PdfTextItem[]): PdfService =>
    new PdfService({
      storageRoot: root,
      resolvePath: async (path) => (path.startsWith('/') ? path : join(root, path)),
      parsePdf: async () => ({
        pages: ['one page'],
        outline: [],
        title: 'figures',
        items: [items],
        images: [[placement]]
      })
    })

  it('用图注判出图表，并把「这一类允许派生什么」一起给出', async () => {
    const svc = serviceFor([
      item('Figure 3. Dose-response curves with 95% CI.', 100, 280),
      item('concentration', 120, 400)
    ])
    const opened = await svc.open(pdfPath, 'proj-1')

    const result = await svc.figures(opened.doc.docId)

    expect(result.figures).toHaveLength(1)
    const understanding = result.figures[0]?.understanding
    expect(understanding?.verdict.class).toBe('chart')
    expect(understanding?.verdict.signals.some((s) => s.where === 'caption')).toBe(true)
    expect(understanding?.route?.derivation).toContain('数值抽取')
  })

  it('图框内的文字项同样能判类，而且来源标成 in-figure-text', async () => {
    const svc = serviceFor([
      item('Scheme 1', 120, 400),
      item('Et3N, DMF', 120, 380),
      item('Figure 4. Experimental setup.', 100, 280)
    ])
    const opened = await svc.open(pdfPath, 'proj-1')

    const result = await svc.figures(opened.doc.docId)

    const understanding = result.figures[0]?.understanding
    expect(understanding?.verdict.class).toBe('chemical-structure')
    expect(
      understanding?.verdict.signals.filter((s) => s.where === 'in-figure-text').length
    ).toBeGreaterThan(0)
    expect(understanding?.route?.requires).toContain('引擎')
  })

  it('判不出时如实写 undetermined 并**不给** route（没有类别就没有允许的派生）', async () => {
    const svc = serviceFor([item('Figure 5. Experimental setup.', 100, 280)])
    const opened = await svc.open(pdfPath, 'proj-1')

    const result = await svc.figures(opened.doc.docId)

    const understanding = result.figures[0]?.understanding
    expect(understanding?.verdict.class).toBe('undetermined')
    if (understanding?.verdict.class !== 'undetermined') throw new Error('unreachable')
    expect(understanding.verdict.reason).toBe('no-signals')
    expect(understanding.route).toBeUndefined()
  })

  it('图表类给出图框内的数值，每项带来源几何（U4-c）', async () => {
    const svc = serviceFor([
      item('Figure 9. Dose-response curves; error bars show SEM; n = 6.', 100, 280),
      item('0.83', 140, 420),
      item('inhibition (%)', 140, 400),
      item('p<0.001', 140, 380)
    ])
    const opened = await svc.open(pdfPath, 'proj-1')

    const result = await svc.figures(opened.doc.docId)

    const derivation = result.figures[0]?.derivation
    expect(derivation?.kind).toBe('numbers')
    if (derivation?.kind !== 'numbers') throw new Error('unreachable')
    expect(derivation.values.map((v) => v.value)).toEqual(['0.83', 'p<0.001'])
    // 来源标注：值印在哪一行、那一行在哪。
    expect(derivation.values[0]?.line).toBe('0.83')
    expect(derivation.values[0]?.bbox).toEqual({ x: 140, y: 420, width: 20, height: 10 })
    expect(derivation.values[1]?.bbox).toEqual({ x: 140, y: 380, width: 35, height: 10 })
  })

  it('有来源会话时把派生记一条账，带着与会话与输入指纹（U4-d）', async () => {
    const records: {
      sessionId: string
      page: number
      figureClass: string
      inFigureText: readonly string[]
    }[] = []
    const svc = new PdfService({
      storageRoot: root,
      resolvePath: async (path) => (path.startsWith('/') ? path : join(root, path)),
      parsePdf: async () => ({
        pages: ['one page'],
        outline: [],
        title: 'figures',
        items: [
          [
            item('Figure 9. Dose-response curves; error bars show SEM; n = 6.', 100, 280),
            item('0.83', 140, 420)
          ]
        ],
        images: [[placement]]
      }),
      onFigureDerivation: (record) => records.push(record)
    })
    const opened = await svc.open(pdfPath, 'proj-1', 'session-7')

    await svc.figures(opened.doc.docId)

    expect(records).toHaveLength(1)
    expect(records[0]?.sessionId).toBe('session-7')
    expect(records[0]?.page).toBe(1)
    expect(records[0]?.figureClass).toBe('chart')
    expect(records[0]?.inFigureText).toEqual(['0.83'])
  })

  it('没有来源会话时不记账（没有会话就没有账，这不是失败）', async () => {
    const records: unknown[] = []
    const svc = new PdfService({
      storageRoot: root,
      resolvePath: async (path) => (path.startsWith('/') ? path : join(root, path)),
      parsePdf: async () => ({
        pages: ['one page'],
        outline: [],
        title: 'figures',
        items: [[item('Scheme 1', 120, 400)]],
        images: [[placement]]
      }),
      onFigureDerivation: (record) => records.push(record)
    })
    const opened = await svc.open(pdfPath, 'proj-1')

    await svc.figures(opened.doc.docId)

    expect(records).toEqual([])
  })

  it('化学结构式给出具名拒答（缺引擎），而不是一个空结果（U4-c）', async () => {
    const svc = serviceFor([item('Scheme 1', 120, 400), item('Et3N, DMF', 120, 380)])
    const opened = await svc.open(pdfPath, 'proj-1')

    const result = await svc.figures(opened.doc.docId)

    const derivation = result.figures[0]?.derivation
    expect(derivation?.kind).toBe('refused')
    if (derivation?.kind !== 'refused') throw new Error('unreachable')
    expect(derivation.reason).toBe('recognizer-unavailable')
  })

  // U4-b：图上读到的库号要绑到**库里真取的记录**上，不靠模型编。查询口是注入的：缺席就说「没接」，
  // 查得到就换成记录，查不动就具名说为什么（连同这台机器能走的下一步）。
  const proteinFigure = () => [item('Figure 4. Crystal structure of crambin (PDB 1CRN).', 100, 280)]

  const serviceWithLookup = (
    items: PdfTextItem[],
    lookup: PdfServiceOptions['lookupAccession']
  ): PdfService =>
    new PdfService({
      storageRoot: root,
      resolvePath: async (path) => (path.startsWith('/') ? path : join(root, path)),
      parsePdf: async () => ({
        pages: ['one page'],
        outline: [],
        title: 'figures',
        items: [items],
        images: [[placement]]
      }),
      ...(lookup ? { lookupAccession: lookup } : {})
    })

  it('把库号换成库里真取的记录，并保留「实验测定 / 预测」的依据（U4-b）', async () => {
    const svc = serviceWithLookup(proteinFigure(), async (accession) => ({
      state: 'resolved',
      records: [
        {
          id: accession.id.toLowerCase(),
          basis: 'experimental',
          source: 'pdbe',
          title: 'WATER STRUCTURE OF A HYDROPHOBIC PROTEIN AT ATOMIC RESOLUTION',
          method: 'X-ray diffraction'
        }
      ]
    }))
    const opened = await svc.open(pdfPath, 'proj-1')

    const result = await svc.figures(opened.doc.docId)

    const derivation = result.figures[0]?.derivation
    expect(derivation?.kind).toBe('records')
    if (derivation?.kind !== 'records') throw new Error('unreachable')
    expect(derivation.records[0].basis).toBe('experimental')
    expect(derivation.records[0].source).toBe('pdbe')
  })

  it('查询口缺席时说「没接」，查不动时具名说为什么（都不是空结果）', async () => {
    const withoutPort = serviceFor(proteinFigure())
    const openedWithout = await withoutPort.open(pdfPath, 'proj-1')
    const refused = (await withoutPort.figures(openedWithout.doc.docId)).figures[0]?.derivation
    expect(refused?.kind).toBe('refused')
    if (refused?.kind !== 'refused') throw new Error('unreachable')
    expect(refused.reason).toBe('accession-lookup-not-wired')

    const unreachable = serviceWithLookup(proteinFigure(), async (accession) => ({
      state: 'unavailable',
      id: accession.id,
      reason: 'no answer within 20000ms'
    }))
    const openedUnreachable = await unreachable.open(pdfPath, 'proj-1')
    const failed = (await unreachable.figures(openedUnreachable.doc.docId)).figures[0]?.derivation
    expect(failed?.kind).toBe('refused')
    if (failed?.kind !== 'refused') throw new Error('unreachable')
    expect(failed.reason).toBe('accession-lookup-unavailable')
  })
})
