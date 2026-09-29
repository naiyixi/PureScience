import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PdfAnnotationSelector } from '../../shared/pdf-annotations'
import {
  createInMemoryPdfAnnotationStore,
  type InMemoryPdfAnnotationStore
} from '../../../test/fixtures/in-memory-pdf-annotation-client'
import { buildPdf } from '../../../test/fixtures/pdf-annotation-fixtures'
import { PdfAnnotationExportService } from './pdf-annotation-export'
import { PdfAnnotationRepository } from './pdf-annotation-repository'
import { PdfAnnotationService } from './pdf-annotation-service'
import { readPdfEmbeddedAnnotations } from './pdf-embedded-annotation-reader'

// The two export channels, driven end to end over a REAL file on disk and the REAL parser: a PDF written
// byte by byte, the store that anchors annotations to its version, and a copy that is then read back.
//
// The assertions this suite exists for:
//
//   * the version's file hashes to the same digest before and after a copy is made, and the copy is a
//     separate file whose first bytes are the version's own. Nothing here reads the code and believes it;
//     the digests are computed from the file the export was pointed at;
//   * the copy is a real PDF with real markup: the app's own parser reads the annotation back off the
//     page, with the subtype and the rectangle the selector asked for. A writer bug that produced
//     plausible-looking bytes would fail here;
//   * the notes channel writes a list and no PDF — asserted on the receipt (`copy === null`) and on the
//     directory the export wrote into, not on the file name alone;
//   * what a copy cannot carry is named in the receipt, and a version whose bytes are not the ones the
//     store anchors stops the export before anything is written.

const ANCHOR = { sourceFileId: 'artifact-1', versionId: 'version-1' }

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

let root: string
let store: InMemoryPdfAnnotationStore
let repository: PdfAnnotationRepository
let sourcePath: string
let sourceBytes: Uint8Array
let written: Array<{ channel: string; suggestedName: string; bytes: Uint8Array }>
let nextPath: string | null

const pageOne = (lines: readonly string[]): Uint8Array =>
  buildPdf([{ lines: lines.map((text, index) => ({ text, x: 72, y: 700 - index * 40 })) }])

const areaSelector = (page: number): PdfAnnotationSelector => ({
  version: 1,
  shape: 'area',
  page,
  rect: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 }
})

const annotationService = (checksum: string): PdfAnnotationService =>
  new PdfAnnotationService({
    repository,
    resolveVersion: async () => ({ versionId: ANCHOR.versionId, checksum }),
    resolveVersionFile: async () => sourcePath
  })

const exportService = (checksum: string): PdfAnnotationExportService =>
  new PdfAnnotationExportService({
    annotations: annotationService(checksum),
    resolveVersionFile: async () => sourcePath,
    // The save dialog is the one seam a save-to-file flow needs; the write itself still happens on disk,
    // so the assertions below are about bytes that exist rather than about a call that was made.
    write: async (request) => {
      written.push(request)
      if (nextPath === null) return null
      await writeFile(nextPath, request.bytes)
      return nextPath
    },
    now: () => Date.UTC(2026, 8, 29, 12, 0, 0)
  })

const request = {
  projectId: 'project-1',
  sessionId: 'session-1',
  artifactId: ANCHOR.sourceFileId,
  versionId: ANCHOR.versionId,
  fileName: 'region-evidence.pdf'
}

const seedAnnotation = async (overrides: {
  kind: string
  selector: unknown
  body?: string
  versionId?: string
  checksum?: string
}): Promise<void> => {
  await repository.createAnnotation({
    sourceFileId: ANCHOR.sourceFileId,
    versionId: overrides.versionId ?? ANCHOR.versionId,
    checksum: overrides.checksum ?? sha256Hex(sourceBytes),
    kind: overrides.kind,
    selector: overrides.selector,
    body: overrides.body ?? ''
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pdf-annotation-export-'))
  store = createInMemoryPdfAnnotationStore()
  repository = new PdfAnnotationRepository(() => Promise.resolve(store.client))
  sourceBytes = pageOne(['A page the reader annotated.', 'A second line on the same page.'])
  sourcePath = join(root, 'region-evidence.pdf')
  await writeFile(sourcePath, sourceBytes)
  written = []
  nextPath = join(root, 'export.out')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('the annotated-pdf channel', () => {
  it('writes a copy that carries the markup, and leaves the source bytes exactly as they were', async () => {
    await seedAnnotation({ kind: 'area', selector: areaSelector(1) })
    const checksum = sha256Hex(sourceBytes)
    const before = sha256Hex(await readFile(sourcePath))

    nextPath = join(root, 'region-evidence (annotated).pdf')
    const outcome = await exportService(checksum).exportAnnotatedPdf(request)
    if (outcome.status !== 'exported') throw new Error(JSON.stringify(outcome))
    const receipt = outcome.receipt

    // --- the red line, as numbers ---------------------------------------------------------------------
    const after = sha256Hex(await readFile(sourcePath))
    expect(after).toBe(before)
    expect(before).toBe(checksum)
    expect(receipt.sourceBytes).toEqual({
      path: sourcePath,
      checksumBefore: checksum,
      checksumAfter: checksum,
      bytes: sourceBytes.length
    })
    expect(receipt.anchorChecksum).toBe(checksum)
    expect(await stat(sourcePath)).toMatchObject({ size: sourceBytes.length })

    // --- the copy, as bytes ---------------------------------------------------------------------------
    const copy = new Uint8Array(await readFile(nextPath))
    expect(receipt.copy).toMatchObject({
      path: nextPath,
      bytes: copy.length,
      sourceBytes: sourceBytes.length,
      pageCount: 1
    })
    expect(copy.length).toBeGreaterThan(sourceBytes.length)
    expect([...copy.subarray(0, sourceBytes.length)]).toEqual([...sourceBytes])

    // --- the markup, read back by the app's own parser --------------------------------------------------
    const parsed = await readPdfEmbeddedAnnotations(copy)
    const square = parsed.annotations.find((entry) => entry.subtype === 'Square')
    expect(square).toBeDefined()
    expect(square!.page).toBe(1)
    // A rectangle at x 0.25..0.75, y 0.5..0.75 of a 612x792 page, in page user space (y up).
    expect((square!.rect as number[]).map((value) => Math.round(value))).toEqual([
      153, 198, 459, 396
    ])
    expect(parsed.annotations).toHaveLength(1)

    // And the source still carries no markup: the copy is where the annotation went.
    expect((await readPdfEmbeddedAnnotations(sourceBytes)).annotations).toHaveLength(0)
  })

  it('carries the provenance: which version, which bytes, and the moment', async () => {
    await seedAnnotation({ kind: 'area', selector: areaSelector(1) })
    nextPath = join(root, 'copy.pdf')
    const outcome = await exportService(sha256Hex(sourceBytes)).exportAnnotatedPdf(request)
    if (outcome.status !== 'exported') throw new Error(JSON.stringify(outcome))

    expect(outcome.receipt.provenance).toEqual({
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceFileId: ANCHOR.sourceFileId,
      versionId: ANCHOR.versionId,
      checksum: sha256Hex(sourceBytes),
      exportedAt: Date.UTC(2026, 8, 29, 12, 0, 0)
    })
    expect(outcome.receipt.exportedAt).toBe(Date.UTC(2026, 8, 29, 12, 0, 0))
    expect(outcome.receipt.notes).toBeNull()
    // The provenance is in the file too: which version this copy was made from survives the window.
    const copy = new Uint8Array(await readFile(nextPath))
    expect(new TextDecoder().decode(copy)).toContain('/T (PureScience)')
  })

  it('names the markup it cannot carry and still writes the copy of what it can', async () => {
    await seedAnnotation({ kind: 'area', selector: areaSelector(1) })
    // One of the file's annotations belongs to the file's FIRST version: it is listed by the store, and
    // it is not placed on these bytes.
    await seedAnnotation({
      kind: 'highlight',
      selector: {
        version: 1,
        shape: 'text-range',
        page: 1,
        rects: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.02 }],
        quote: 'A page the reader annotated.'
      },
      versionId: 'version-0'
    })
    await seedAnnotation({
      kind: 'document-note',
      selector: { version: 1, shape: 'document-note' },
      body: 'read in full'
    })

    nextPath = join(root, 'copy.pdf')
    const outcome = await exportService(sha256Hex(sourceBytes)).exportAnnotatedPdf(request)
    if (outcome.status !== 'exported') throw new Error(JSON.stringify(outcome))
    const receipt = outcome.receipt

    expect(receipt.annotationsInStore).toBe(3)
    expect(receipt.annotationsExported).toBe(1)
    expect(receipt.kinds).toEqual([{ kind: 'area', count: 1 }])
    expect(receipt.skipped.map((entry) => entry.reason)).toEqual([
      'another-version',
      'document-level'
    ])
    expect(receipt.skipped.every((entry) => entry.count === 1)).toBe(true)
    expect(receipt.skipped[0]!.detail).toContain('not the same region')

    // A markup drawn on other bytes is NOT in the copy, and the source is untouched either way.
    const copy = new Uint8Array(await readFile(nextPath))
    expect(new TextDecoder().decode(copy)).not.toContain('/Subtype /Highlight')
  })

  it('refuses a version whose bytes are not the ones the store anchors, and writes nothing', async () => {
    await seedAnnotation({ kind: 'area', selector: areaSelector(1) })
    nextPath = join(root, 'copy.pdf')
    const outcome = await exportService('b'.repeat(64)).exportAnnotatedPdf(request)

    expect(outcome).toMatchObject({
      status: 'failure',
      channel: 'annotated-pdf',
      code: 'checksum-mismatch'
    })
    expect(written).toHaveLength(0)
    expect(sha256Hex(await readFile(sourcePath))).toBe(sha256Hex(sourceBytes))
  })

  it('says there is nothing to export when the version carries no markup of its own', async () => {
    expect(await exportService(sha256Hex(sourceBytes)).exportAnnotatedPdf(request)).toMatchObject({
      status: 'failure',
      channel: 'annotated-pdf',
      code: 'nothing-to-export'
    })
    expect(written).toHaveLength(0)
  })

  it('reports a cancelled save as cancelled, never as an export', async () => {
    await seedAnnotation({ kind: 'area', selector: areaSelector(1) })
    nextPath = null
    expect(await exportService(sha256Hex(sourceBytes)).exportAnnotatedPdf(request)).toEqual({
      status: 'cancelled',
      channel: 'annotated-pdf'
    })
  })
})

describe('the notes channel', () => {
  it('writes the annotations as a list, with no PDF copy and no PDF on disk', async () => {
    await seedAnnotation({ kind: 'area', selector: areaSelector(1) })
    await seedAnnotation({
      kind: 'highlight',
      selector: {
        version: 1,
        shape: 'text-range',
        page: 1,
        rects: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.02 }],
        quote: 'A page the reader annotated.'
      },
      body: 'keep'
    })
    await seedAnnotation({
      kind: 'page-note',
      selector: { version: 1, shape: 'page-note', page: 2 },
      body: 'the sample size is the weak point'
    })

    nextPath = join(root, 'region-evidence (annotations).txt')
    const outcome = await exportService(sha256Hex(sourceBytes)).exportNotes(request)
    if (outcome.status !== 'exported') throw new Error(JSON.stringify(outcome))
    const receipt = outcome.receipt

    // No PDF, and no bytes of the source: the notes channel reads the store.
    expect(receipt.copy).toBeNull()
    expect(receipt.sourceBytes).toBeNull()
    expect(receipt.notes).toMatchObject({ path: nextPath, entryLines: 3 })
    expect(receipt.notes!.path.endsWith('.pdf')).toBe(false)
    expect(receipt.annotationsInStore).toBe(3)
    expect(receipt.annotationsExported).toBe(3)

    // The list names each annotation's kind, page, the version it was drawn on, and its passage.
    const lines = (await readFile(nextPath, 'utf8')).trimEnd().split('\n')
    expect(lines[0]).toBe('PureScience PDF annotation notes')
    expect(lines).toContain(`version: ${ANCHOR.versionId}`)
    expect(lines).toContain(`checksum: sha256:${sha256Hex(sourceBytes)}`)
    expect(lines).toContain('exported-at: 2026-09-29T12:00:00.000Z')
    expect(lines).toContain('annotations: 3')
    expect(lines.filter((line) => /^\[\d+\] /.test(line))).toHaveLength(receipt.annotationsInStore)
    expect(lines.join('\n')).toContain('[2] highlight · page 1 · version version-1 · current')
    expect(lines.join('\n')).toContain('text: A page the reader annotated.')
    expect(lines.join('\n')).toContain('[3] page-note · page 2 · version version-1 · current')

    // Only what this test asked for exists: the notes channel produced no copy of the PDF, and the
    // source's directory holds nothing else.
    expect((await readdir(root)).sort()).toEqual([
      'region-evidence (annotations).txt',
      'region-evidence.pdf'
    ])

    // And the version's own bytes are exactly what they were.
    expect(sha256Hex(await readFile(sourcePath))).toBe(sha256Hex(sourceBytes))
  })

  it('lists the annotations of another version too, saying which version each belongs to', async () => {
    await seedAnnotation({
      kind: 'area',
      selector: areaSelector(1),
      versionId: 'version-0'
    })
    nextPath = join(root, 'notes.txt')
    const outcome = await exportService(sha256Hex(sourceBytes)).exportNotes(request)
    if (outcome.status !== 'exported') throw new Error(JSON.stringify(outcome))
    const text = await readFile(nextPath, 'utf8')
    expect(text).toContain('version version-0 · version-changed')
  })

  it('reports a cancelled save as cancelled, and writes nothing', async () => {
    await seedAnnotation({ kind: 'area', selector: areaSelector(1) })
    nextPath = null
    expect(await exportService(sha256Hex(sourceBytes)).exportNotes(request)).toEqual({
      status: 'cancelled',
      channel: 'notes'
    })
    expect(await readdir(root)).toEqual(['region-evidence.pdf'])
  })
})
