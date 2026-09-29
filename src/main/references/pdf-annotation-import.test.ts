import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  validatePdfAnnotationContent,
  type PdfAnnotationSelector
} from '../../shared/pdf-annotations'
import { PdfAnnotationImportError } from '../../shared/pdf-annotation-import'
import {
  createInMemoryPdfAnnotationStore,
  type InMemoryPdfAnnotationStore
} from '../../../test/fixtures/in-memory-pdf-annotation-client'
import {
  FIXTURE_AREA_COMMENT,
  FIXTURE_HIGHLIGHT_COMMENT,
  FIXTURE_LINES,
  FIXTURE_NOTE_TEXT,
  FIXTURE_PAGE_SIZE,
  annotatedPdfFixture,
  damagedPdfFixture,
  plainPdfFixture,
  rotatedPdfFixture,
  sha256HexOf,
  unsupportedOnlyPdfFixture
} from '../../../test/fixtures/pdf-annotation-fixtures'
import { importPdfEmbeddedAnnotations } from './pdf-annotation-import'
import { PdfAnnotationRepository } from './pdf-annotation-repository'

// The import channel, driven end to end: a REAL PDF (built byte by byte in the fixture module) through
// the REAL pdf.js parser, into the real A1 repository over an in-memory ledger that enforces the same
// unique key the database does. Nothing here mocks the parse — every quote asserted below is text the
// parser read out of the file's own text layer.
//
// What the suite is really about is the four honest answers: an import that worked and says what it
// left behind; one that finds nothing and says so; one that finds only kinds this build cannot place;
// and one that cannot read the file at all and writes nothing.

const ANCHOR = { sourceFileId: 'file-1', versionId: 'version-1' }

let root: string
let store: InMemoryPdfAnnotationStore
let repository: PdfAnnotationRepository

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pdf-annotation-import-'))
  store = createInMemoryPdfAnnotationStore()
  repository = new PdfAnnotationRepository(() => Promise.resolve(store.client))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const writeFixture = async (name: string, bytes: Uint8Array): Promise<string> => {
  const filePath = join(root, name)
  await writeFile(filePath, bytes)
  return filePath
}

const selectorOf = (selectorJson: string): PdfAnnotationSelector =>
  JSON.parse(selectorJson) as PdfAnnotationSelector

const counts = (): { annotations: number; imports: number } => ({
  annotations: store.annotations.length,
  imports: store.imports.length
})

describe('importing the annotations a PDF carries inside itself', () => {
  it('imports every markup kind the file carries, anchored to the version, and reports the rest by name', async () => {
    const bytes = annotatedPdfFixture()
    const checksum = sha256HexOf(bytes)
    const filePath = await writeFixture('annotated.pdf', bytes)

    const report = await importPdfEmbeddedAnnotations(repository, {
      ...ANCHOR,
      checksum,
      payload: { filePath }
    })

    expect(report.status).toBe('imported')
    expect(report.sourceKind).toBe('embedded-pdf')
    expect(report.digest).toBe(checksum)
    expect(report.imported).toBe(8)
    expect(report.annotationsInFile).toBe(17)
    expect(report.pageCount).toBe(2)
    expect(report.receiptCreated).toBe(true)
    expect(report.receipt).toMatchObject({
      sourceKind: 'embedded-pdf',
      sourceFileId: 'file-1',
      versionId: 'version-1',
      digest: checksum
    })
    expect(report.kinds).toEqual([
      { kind: 'highlight', count: 3 },
      { kind: 'area', count: 1 },
      { kind: 'page-note', count: 1 },
      { kind: 'squiggly', count: 1 },
      { kind: 'strikethrough', count: 1 },
      { kind: 'underline', count: 1 }
    ])
    // Everything the file carried that did not become an annotation, with the reason. The arithmetic
    // has to close: imported + skipped === the file's own count.
    expect(report.skipped.map((entry) => [entry.subtype, entry.reason, entry.count])).toEqual([
      ['Highlight', 'no-text-under-markup', 1],
      ['Text', 'empty-note', 1],
      ['Highlight', 'not-displayed', 2],
      ['Ink', 'unsupported-subtype', 1],
      ['Circle', 'unsupported-subtype', 1],
      ['Link', 'unsupported-subtype', 1],
      // pdf.js moves popups to the end of the page's list; the report keeps the parser's order.
      ['(no-subtype)', 'unsupported-subtype', 1],
      ['Popup', 'unsupported-subtype', 1]
    ])
    expect(report.imported + report.skipped.reduce((total, entry) => total + entry.count, 0)).toBe(
      report.annotationsInFile
    )

    // What landed in the store: one row per imported annotation, every one anchored to the version.
    expect(store.annotations).toHaveLength(8)
    for (const row of store.annotations) {
      expect(row.sourceFileId).toBe('file-1')
      expect(row.versionId).toBe('version-1')
      expect(row.checksum).toBe(checksum)
      // The store's own consistency rule, satisfied by what the mapper produced.
      expect(
        validatePdfAnnotationContent({
          kind: row.kind,
          selector: selectorOf(row.selectorJson),
          body: row.body
        })
      ).toBeUndefined()
    }

    const quotes = store.annotations.map(
      (row) => (selectorOf(row.selectorJson) as { quote?: string }).quote
    )
    // The passage under each markup, read out of the file's text layer — including the markup that
    // carries only a rectangle, which a display-intent read would have hidden entirely.
    expect(quotes).toContain(FIXTURE_LINES.highlighted.text)
    expect(quotes).toContain(FIXTURE_LINES.rectOnly.text)
    expect(quotes).toContain(FIXTURE_LINES.underlined.text)
    expect(quotes).toContain(FIXTURE_LINES.squiggly.text)
    expect(quotes).toContain(FIXTURE_LINES.struck.text)
    expect(quotes).toContain(FIXTURE_LINES.secondPage.text)

    const highlight = store.annotations.find((row) => row.body === FIXTURE_HIGHLIGHT_COMMENT)
    expect(highlight?.kind).toBe('highlight')
    expect(selectorOf(highlight!.selectorJson)).toMatchObject({
      version: 1,
      shape: 'text-range',
      page: 1,
      quote: FIXTURE_LINES.highlighted.text
    })

    // The geometry of the markup the file wrote with only a rectangle, normalized against the page box
    // the parser reported — i.e. the anchor is where the file drew it, not somewhere plausible.
    const rectOnly = store.annotations.find((row) => row.body === 'no quads in this file')
    expect(selectorOf(rectOnly!.selectorJson)).toMatchObject({
      page: 1,
      rects: [
        {
          x: Math.round((70 / FIXTURE_PAGE_SIZE.width) * 10_000) / 10_000,
          y: Math.round((1 - 674 / FIXTURE_PAGE_SIZE.height) * 10_000) / 10_000,
          width: Math.round((230 / FIXTURE_PAGE_SIZE.width) * 10_000) / 10_000,
          height: Math.round((16 / FIXTURE_PAGE_SIZE.height) * 10_000) / 10_000
        }
      ]
    })

    const secondPage = store.annotations.find(
      (row) => (selectorOf(row.selectorJson) as { page?: number }).page === 2
    )
    expect(selectorOf(secondPage!.selectorJson)).toMatchObject({
      page: 2,
      quote: FIXTURE_LINES.secondPage.text
    })
    expect(secondPage!.versionId).toBe('version-1')

    const area = store.annotations.find((row) => row.kind === 'area')
    expect(area?.body).toBe(FIXTURE_AREA_COMMENT)
    expect(selectorOf(area!.selectorJson)).toMatchObject({ shape: 'area', page: 1 })

    const note = store.annotations.find((row) => row.kind === 'page-note')
    expect(note?.body).toBe(FIXTURE_NOTE_TEXT)
    expect(selectorOf(note!.selectorJson)).toMatchObject({ shape: 'page-note', page: 1 })

    // The repository reads back exactly what was written, through its own version-anchored read.
    const listed = await repository.listAnnotations(ANCHOR)
    expect(listed).toHaveLength(8)
    expect(await repository.countAnnotations(ANCHOR)).toBe(8)
    expect(await repository.listAnnotatedVersions('file-1')).toEqual(['version-1'])
  })

  it('imports the same file once: a repeated import writes nothing and says it was already imported', async () => {
    const bytes = annotatedPdfFixture()
    const checksum = sha256HexOf(bytes)
    const filePath = await writeFixture('annotated.pdf', bytes)

    const first = await importPdfEmbeddedAnnotations(repository, {
      ...ANCHOR,
      checksum,
      payload: { filePath }
    })
    expect(first.status).toBe('imported')
    expect(counts()).toEqual({ annotations: 8, imports: 1 })

    // Same bytes, handed over as bytes this time — the digest is of the payload, not of a path, so
    // this is still the same import.
    const again = await importPdfEmbeddedAnnotations(repository, {
      ...ANCHOR,
      checksum,
      payload: { bytes }
    })

    expect(again.status).toBe('unchanged')
    expect(again.imported).toBe(0)
    expect(again.kinds).toEqual([])
    expect(again.skipped).toEqual([])
    expect(again.receiptCreated).toBe(false)
    expect(again.receipt?.digest).toBe(checksum)
    expect(counts()).toEqual({ annotations: 8, imports: 1 })

    // The same payload against ANOTHER version is a different import, and it gets its own receipt:
    // the digest is unique per (channel, file, version), not globally.
    const otherVersion = await importPdfEmbeddedAnnotations(repository, {
      ...ANCHOR,
      versionId: 'version-2',
      checksum,
      payload: { bytes }
    })
    expect(otherVersion.status).toBe('imported')
    expect(counts()).toEqual({ annotations: 16, imports: 2 })

    // And the two versions never see each other's annotations.
    expect(await repository.countAnnotations(ANCHOR)).toBe(8)
    expect(await repository.countAnnotations({ ...ANCHOR, versionId: 'version-2' })).toBe(8)

    // Clearing one version's annotations leaves both receipts standing: a receipt records that an
    // import happened, which stays true afterwards.
    expect(await repository.deleteAnnotationsForVersion(ANCHOR)).toBe(8)
    expect(counts()).toEqual({ annotations: 8, imports: 2 })
    expect(await repository.listImports({ sourceFileId: 'file-1' })).toHaveLength(2)
  })

  it('reports a file with no annotations as exactly that, and writes no receipt for it', async () => {
    const bytes = plainPdfFixture()
    const checksum = sha256HexOf(bytes)
    const filePath = await writeFixture('plain.pdf', bytes)

    const report = await importPdfEmbeddedAnnotations(repository, {
      ...ANCHOR,
      checksum,
      payload: { filePath }
    })

    expect(report.status).toBe('no-annotations')
    expect(report.imported).toBe(0)
    expect(report.skipped).toEqual([])
    expect(report.annotationsInFile).toBe(0)
    expect(report.pageCount).toBe(1)
    expect(report.receipt).toBeUndefined()
    expect(report.receiptCreated).toBe(false)
    expect(counts()).toEqual({ annotations: 0, imports: 0 })

    // Twice: still "this file carries no annotations", never "already imported" — no import happened,
    // so there is no receipt to be idempotent about.
    const again = await importPdfEmbeddedAnnotations(repository, {
      ...ANCHOR,
      checksum,
      payload: { bytes }
    })
    expect(again.status).toBe('no-annotations')
    expect(counts()).toEqual({ annotations: 0, imports: 0 })
  })

  it('reports a file whose annotations are all of kinds this build cannot place, by name and count', async () => {
    const bytes = unsupportedOnlyPdfFixture()
    const checksum = sha256HexOf(bytes)
    const filePath = await writeFixture('shapes-only.pdf', bytes)

    const report = await importPdfEmbeddedAnnotations(repository, {
      ...ANCHOR,
      checksum,
      payload: { filePath }
    })

    // Not "no annotations" (the file has three) and not "imported" (nothing was): its own answer.
    expect(report.status).toBe('no-supported-annotations')
    expect(report.imported).toBe(0)
    expect(report.annotationsInFile).toBe(3)
    expect(report.skipped.map((entry) => [entry.subtype, entry.reason, entry.count])).toEqual([
      ['Ink', 'unsupported-subtype', 1],
      ['Circle', 'unsupported-subtype', 1],
      ['FreeText', 'unsupported-subtype', 1]
    ])
    expect(report.skipped[0]?.detail).toContain('no counterpart')
    expect(report.receipt).toBeUndefined()
    expect(counts()).toEqual({ annotations: 0, imports: 0 })
  })

  it('refuses a damaged file by name, before anything is written', async () => {
    const filePath = await writeFixture('damaged.pdf', damagedPdfFixture())

    const failure = await importPdfEmbeddedAnnotations(repository, {
      ...ANCHOR,
      checksum: sha256HexOf(damagedPdfFixture()),
      payload: { filePath }
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(PdfAnnotationImportError)
    expect((failure as PdfAnnotationImportError).code).toBe('unreadable-pdf')
    expect((failure as Error).message).toContain('nothing was imported')
    // No half an import: not an annotation, not a receipt.
    expect(counts()).toEqual({ annotations: 0, imports: 0 })
  })

  it('refuses bytes that are not the version the caller named', async () => {
    const bytes = annotatedPdfFixture()
    const filePath = await writeFixture('annotated.pdf', bytes)

    const failure = await importPdfEmbeddedAnnotations(repository, {
      ...ANCHOR,
      // The checksum of a DIFFERENT file: the anchor would be a lie about these bytes.
      checksum: sha256HexOf(plainPdfFixture()),
      payload: { filePath }
    }).catch((error: unknown) => error)

    expect((failure as PdfAnnotationImportError).code).toBe('checksum-mismatch')
    expect((failure as Error).message).toContain(sha256HexOf(bytes))
    expect(counts()).toEqual({ annotations: 0, imports: 0 })
  })

  it('refuses an import with no version to anchor to, before it even opens the file', async () => {
    const failure = await importPdfEmbeddedAnnotations(repository, {
      sourceFileId: 'file-1',
      versionId: '  ',
      checksum: sha256HexOf(plainPdfFixture()),
      // A path that does not exist: if the anchor were checked after reading, this would fail on ENOENT.
      payload: { filePath: join(root, 'no-such-file.pdf') }
    }).catch((error: unknown) => error)

    expect((failure as PdfAnnotationImportError).code).toBe('missing-anchor')
    expect((failure as Error).message).toContain('versionId')
    expect(counts()).toEqual({ annotations: 0, imports: 0 })
  })

  it('does not guess where markup belongs on a rotated page', async () => {
    const bytes = rotatedPdfFixture()
    const checksum = sha256HexOf(bytes)
    const filePath = await writeFixture('rotated.pdf', bytes)

    const report = await importPdfEmbeddedAnnotations(repository, {
      ...ANCHOR,
      checksum,
      payload: { filePath }
    })

    expect(report.status).toBe('no-supported-annotations')
    expect(report.annotationsInFile).toBe(1)
    expect(report.skipped.map((entry) => [entry.subtype, entry.reason, entry.count])).toEqual([
      ['Highlight', 'rotated-page', 1]
    ])
    expect(counts()).toEqual({ annotations: 0, imports: 0 })
  })
})
