import { describe, expect, it } from 'vitest'

import {
  PDF_ANNOTATION_EXPORT_CHANNELS,
  buildAnnotatedPdfCopy,
  buildPdfAnnotationNotes,
  decodeLatin1,
  encodeLatin1,
  isPdfAnnotationExportChannel,
  isPdfFileName,
  pdfDateStamp,
  pdfString,
  planPdfAnnotationBurn,
  readPdfPageGeometry,
  type PdfAnnotationBurnCandidate,
  type PdfAnnotationExportProvenance,
  type PdfPageGeometry
} from './pdf-annotation-export'
import type { PdfAnnotationSelector } from './pdf-annotations'
import { buildPdf } from '../../test/fixtures/pdf-annotation-fixtures'

// The two export channels (文档标注层 A4), taken apart without a window, a file system or a database.
//
// What is pinned here, and why each one is here rather than in the acceptance run:
//
//   * the copy is the source bytes plus an appended section — asserted by byte comparison, not by
//     trusting the intent. A future change that splices the source in the middle fails HERE;
//   * the appended section is a real incremental update: a new cross-reference section, a trailer whose
//     /Prev chains to the file's own, and the page dictionaries re-stated with the new /Annots. The
//     parser's own verdict on the result is asserted in the main-process suite, next to the parser;
//   * what a copy cannot carry is named. Another version's markup, a document note, a rotated page and a
//     shape with no extent are all reported with a reason and a count;
//   * the notes channel writes a list, and nothing about it is a PDF.

const provenance: PdfAnnotationExportProvenance = {
  projectId: 'project-1',
  sessionId: 'session-1',
  sourceFileId: 'artifact-1',
  versionId: 'version-1',
  checksum: 'a'.repeat(64),
  exportedAt: Date.UTC(2026, 8, 29, 12, 0, 0)
}

const areaSelector = (page: number): PdfAnnotationSelector => ({
  version: 1,
  shape: 'area',
  page,
  rect: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 }
})

const candidate = (
  overrides: Partial<PdfAnnotationBurnCandidate> = {}
): PdfAnnotationBurnCandidate => ({
  kind: 'area',
  selector: areaSelector(1),
  body: '',
  anchorState: 'current',
  ...overrides
})

const PAGE: PdfPageGeometry = {
  number: 1,
  width: 612,
  height: 792,
  rotate: 0,
  objectNumber: 4,
  generation: 0
}

describe('the export channels', () => {
  it('names exactly two, and recognises them', () => {
    expect(PDF_ANNOTATION_EXPORT_CHANNELS).toEqual(['annotated-pdf', 'notes'])
    expect(isPdfAnnotationExportChannel('notes')).toBe(true)
    expect(isPdfAnnotationExportChannel('everything')).toBe(false)
    expect(isPdfFileName('region-evidence.pdf')).toBe(true)
    expect(isPdfFileName('region-evidence-annotations.txt')).toBe(false)
  })
})

describe('PDF strings', () => {
  it('writes printable ASCII as a literal with the three special characters escaped', () => {
    expect(pdfString('plain text')).toBe('(plain text)')
    expect(pdfString('a (b) c \\ d')).toBe('(a \\(b\\) c \\\\ d)')
  })

  it('writes anything else as UTF-16BE hex with a byte-order mark', () => {
    // A note in Chinese, a Greek letter and an emoji: all three have to survive into the copy, and only
    // the hex form does that in a viewer reading the file without a font map.
    expect(pdfString('高亮')).toBe('<feff9ad84eae>')
    expect(pdfString('β')).toBe('<feff03b2>')
    expect(pdfString('🙂')).toBe('<feffd83dde42>')
  })

  it('stamps a PDF date in UTC', () => {
    expect(pdfDateStamp(Date.UTC(2026, 8, 29, 12, 0, 0))).toBe('D:20260929120000Z')
  })
})

describe('latin1 byte mapping', () => {
  it('round-trips every byte value exactly, including the range windows-1252 would rewrite', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index)
    const text = decodeLatin1(bytes)
    expect(text).toHaveLength(256)
    expect([...encodeLatin1(text)]).toEqual([...bytes])
  })
})

describe('the burn plan', () => {
  it('burns the markup of the version being copied', () => {
    const plan = planPdfAnnotationBurn({
      annotations: [candidate(), candidate({ selector: areaSelector(1) })],
      pages: [PAGE],
      exportedAt: provenance.exportedAt
    })
    expect(plan.considered).toBe(2)
    expect(plan.burnedCount).toBe(2)
    expect(plan.kinds).toEqual([{ kind: 'area', count: 2 }])
    expect(plan.skipped).toEqual([])
    expect(plan.burned[0]!.objectBody).toContain('/Subtype /Square')
    // A rectangle at x 0.25..0.75, y 0.5..0.75 of a 612x792 page, in user space (y up).
    expect(plan.burned[0]!.objectBody).toContain('/Rect [153 198 459 396]')
  })

  it('refuses to place markup drawn on other bytes', () => {
    const plan = planPdfAnnotationBurn({
      annotations: [candidate({ anchorState: 'version-changed' })],
      pages: [PAGE],
      exportedAt: provenance.exportedAt
    })
    expect(plan.burnedCount).toBe(0)
    expect(plan.skipped.map((entry) => entry.reason)).toEqual(['another-version'])
    expect(plan.skipped[0]!.detail).toContain('not the same region')
  })

  it('names every other reason it left something out, with a count', () => {
    const plan = planPdfAnnotationBurn({
      annotations: [
        candidate({ kind: 'document-note', selector: { version: 1, shape: 'document-note' } }),
        candidate({ selector: areaSelector(9) }),
        candidate({
          kind: 'page-note',
          body: 'a note',
          selector: { version: 1, shape: 'page-note', page: 1 }
        })
      ],
      pages: [{ ...PAGE, rotate: 90 }],
      exportedAt: provenance.exportedAt
    })
    expect(plan.burnedCount).toBe(0)
    expect(plan.skipped.map((entry) => entry.reason)).toEqual([
      'document-level',
      'unknown-page',
      'rotated-page'
    ])
    expect(plan.skipped.every((entry) => entry.count === 1)).toBe(true)
  })

  it('writes a quad list for a text markup, quoting the passage as its comment', () => {
    const plan = planPdfAnnotationBurn({
      annotations: [
        candidate({
          kind: 'highlight',
          selector: {
            version: 1,
            shape: 'text-range',
            page: 1,
            rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.02 }],
            quote: 'the effect is large'
          }
        })
      ],
      pages: [PAGE],
      exportedAt: provenance.exportedAt
    })
    const body = plan.burned[0]!.objectBody
    expect(body).toContain('/Subtype /Highlight')
    expect(body).toContain('/QuadPoints [61.2 712.8 367.2 712.8 61.2 696.96 367.2 696.96]')
    expect(body).toContain('/Contents (the effect is large)')
  })
})

describe('the annotated copy', () => {
  const source = buildPdf([{ lines: [{ text: 'A page the reader annotated.', x: 72, y: 700 }] }])

  it('is the source bytes with an update appended, and nothing spliced into them', () => {
    const result = buildAnnotatedPdfCopy({
      source,
      annotations: [candidate()],
      exportedAt: provenance.exportedAt
    })
    if (result.status !== 'written') throw new Error(result.message)

    expect([...result.bytes.subarray(0, source.length)]).toEqual([...source])
    expect(result.bytes.length).toBeGreaterThan(source.length)
    expect(result.sourceBytes).toBe(source.length)
    expect(result.appendedBytes).toBe(result.bytes.length - source.length)
    expect(result.pageCount).toBe(1)
  })

  it('carries the annotation, attached to the page, with a cross-reference section that chains back', () => {
    const result = buildAnnotatedPdfCopy({
      source,
      annotations: [candidate()],
      exportedAt: provenance.exportedAt
    })
    if (result.status !== 'written') throw new Error(result.message)
    const text = decodeLatin1(result.bytes)
    const appended = text.slice(source.length)

    expect(appended).toContain('/Subtype /Square')
    expect(appended).toContain('/Type /Annot')
    expect(appended).toMatch(/\/Title|\/T \(PureScience\)/)
    // The page dictionary is re-stated with the new annotation attached to the page it was drawn on.
    expect(appended).toMatch(/4 0 obj[\s\S]*?\/Annots \[\d+ 0 R\][\s\S]*?endobj/)
    // A real incremental update: a new xref section whose trailer names the file's own startxref as the
    // previous one — without which every object the source declared would be unknown to a reader.
    expect(appended).toMatch(/xref\n[\s\S]*trailer\n<< \/Size \d+ \/Root 1 0 R \/Prev \d+ >>/)
    expect(appended.trimEnd().endsWith('%%EOF')).toBe(true)
  })

  it('keeps the markup a source PDF already carried, instead of replacing its /Annots', () => {
    const withOwnMarkup = buildPdf([
      {
        lines: [{ text: 'Already marked up.', x: 72, y: 700 }],
        annotations: [{ dict: '/Subtype /Highlight /Rect [72 698 320 714]' }]
      }
    ])
    const result = buildAnnotatedPdfCopy({
      source: withOwnMarkup,
      annotations: [candidate()],
      exportedAt: provenance.exportedAt
    })
    if (result.status !== 'written') throw new Error(result.message)
    const appended = decodeLatin1(result.bytes).slice(withOwnMarkup.length)
    const annots = /\/Annots \[([^\]]*)\]/.exec(appended)?.[1]
    expect(annots?.match(/\d+ 0 R/g)).toHaveLength(2)
  })

  it('adds a second annotation alongside the first, keeping the page dictionary single', () => {
    const result = buildAnnotatedPdfCopy({
      source,
      annotations: [candidate(), candidate()],
      exportedAt: provenance.exportedAt
    })
    if (result.status !== 'written') throw new Error(result.message)
    const appended = decodeLatin1(result.bytes).slice(source.length)
    expect(appended.match(/\/Subtype \/Square/g)).toHaveLength(2)
    expect(appended.match(/\/Annots \[/g)).toHaveLength(1)
  })

  it('refuses, by name, a source it cannot append to rather than writing a broken copy', () => {
    expect(
      buildAnnotatedPdfCopy({
        source: Uint8Array.from([1, 2, 3]),
        annotations: [candidate()],
        exportedAt: provenance.exportedAt
      })
    ).toMatchObject({ status: 'refused', code: 'not-a-pdf' })

    const truncated = source.slice(0, source.length - 40)
    const refused = buildAnnotatedPdfCopy({
      source: truncated,
      annotations: [candidate()],
      exportedAt: provenance.exportedAt
    })
    expect(refused).toMatchObject({ status: 'refused' })
  })

  it('says there is nothing to export when the version carries no annotation of its own', () => {
    const result = buildAnnotatedPdfCopy({
      source,
      annotations: [],
      exportedAt: provenance.exportedAt
    })
    expect(result).toMatchObject({ status: 'refused', code: 'nothing-to-export' })
  })

  it('reports the pages of a source it can read, in reading order', () => {
    const read = readPdfPageGeometry(
      buildPdf([
        { lines: [{ text: 'one', x: 72, y: 700 }] },
        { lines: [{ text: 'two', x: 72, y: 700 }] }
      ])
    )
    expect(read.status).toBe('read')
    if (read.status !== 'read') return
    expect(read.pages.map((page) => page.number)).toEqual([1, 2])
    expect(read.pages.map((page) => page.objectNumber)).toEqual([4, 6])
    expect(read.pages.every((page) => page.width === 612 && page.height === 792)).toBe(true)
  })

  it('carries the source trailer forward, so the copy keeps its metadata and its file identity', () => {
    const withMetadata = decodeLatin1(source).replace(
      '/Root 1 0 R >>',
      '/Root 1 0 R /Info 1 0 R /ID [<aa11><bb22>] >>'
    )
    const result = buildAnnotatedPdfCopy({
      source: encodeLatin1(withMetadata),
      annotations: [candidate()],
      exportedAt: provenance.exportedAt
    })
    if (result.status !== 'written') throw new Error(result.message)
    const appended = decodeLatin1(result.bytes).slice(encodeLatin1(withMetadata).length)
    // A new trailer REPLACES the old one as far as a reader is concerned: anything left out is lost.
    expect(appended).toContain('/Info 1 0 R')
    expect(appended).toContain('/ID [<aa11><bb22>]')
    expect(appended).toMatch(/trailer\n<< \/Size \d+ \/Root 1 0 R \/Info 1 0 R \/ID/)
  })

  it('refuses an encrypted source rather than appending objects the file does not protect', () => {
    const encrypted = encodeLatin1(
      decodeLatin1(source).replace('/Root 1 0 R >>', '/Root 1 0 R /Encrypt 9 0 R >>')
    )
    const result = buildAnnotatedPdfCopy({
      source: encrypted,
      annotations: [candidate()],
      exportedAt: provenance.exportedAt
    })
    expect(result).toMatchObject({ status: 'refused', code: 'unsupported-pdf-structure' })
    if (result.status !== 'refused') return
    expect(result.message).toContain('encrypted')
  })
})

describe('the notes channel', () => {
  it('lists the annotations with their kind, page, version and passage', () => {
    const notes = buildPdfAnnotationNotes({
      provenance,
      entries: [
        {
          kind: 'highlight',
          page: 1,
          versionId: 'version-1',
          text: 'Figure 1. Measured response',
          body: '',
          anchorState: 'current'
        },
        {
          kind: 'page-note',
          page: 3,
          versionId: 'version-0',
          text: 'The sample size is the weak point.',
          body: 'The sample size is the weak point.',
          anchorState: 'version-changed'
        },
        {
          kind: 'document-note',
          versionId: 'version-1',
          text: 'Read in full.',
          body: 'Read in full.',
          anchorState: 'current'
        }
      ]
    })

    expect(notes.entryLines).toBe(3)
    expect(notes.text).toContain(`version: ${provenance.versionId}`)
    expect(notes.text).toContain(`checksum: sha256:${provenance.checksum}`)
    expect(notes.text).toContain('exported-at: 2026-09-29T12:00:00.000Z')
    expect(notes.text).toContain('annotations: 3')
    expect(notes.text).toContain(
      '[1] highlight · page 1 · version version-1 · current\n    text: Figure 1. Measured response'
    )
    // A note that belongs to other bytes says so IN the file, and a document note names no page.
    expect(notes.text).toContain('[2] page-note · page 3 · version version-0 · version-changed')
    expect(notes.text).toContain('[3] document-note · page - · version version-1 · current')
    expect(notes.lines).toBe(notes.text.split('\n').length - 1)
  })

  it('writes nothing that looks like a PDF', () => {
    const notes = buildPdfAnnotationNotes({ provenance, entries: [] })
    expect(notes.entryLines).toBe(0)
    expect(notes.text).toContain('annotations: 0')
    expect(notes.text).not.toContain('/Subtype')
    expect(notes.text.startsWith('%PDF-')).toBe(false)
  })
})
