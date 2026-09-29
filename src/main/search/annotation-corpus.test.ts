import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { GLOBAL_SEARCH_MAX_SCANNED_ANNOTATIONS } from '../../shared/global-search'
import type { PdfAnnotation } from '../../shared/pdf-annotations'
import { createSearchAnnotationCorpus, isAnnotatableProjectFile } from './annotation-corpus'

// The annotation corpus of a project (A5, 需求 1). Two properties are asserted here and nowhere else:
//
//   * WHAT IS INDEXED — the stored `body` and the stored selector's `quote`, carried through unchanged,
//     plus the anchor. Nothing derived from a PDF read, because nothing here reads one.
//   * WHAT IS NOT — the module has no PDF reader to reach for. That is asserted as a property of the
//     source rather than promised in a comment: this file's own imports are checked below.

const annotation = (overrides: Partial<PdfAnnotation> = {}): PdfAnnotation => ({
  id: 'annotation-1',
  sourceFileId: 'artifact-1',
  versionId: 'version-1',
  checksum: 'a'.repeat(64),
  kind: 'highlight',
  selector: {
    version: 1,
    shape: 'text-range',
    page: 3,
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
    quote: 'The passage the markup covers.'
  },
  body: 'A note the reader typed.',
  createdAt: 1,
  ...overrides
})

describe('createSearchAnnotationCorpus', () => {
  it('indexes the stored quote and body, and names the file by the anchor the row carries', async () => {
    const corpus = createSearchAnnotationCorpus({
      listAnchors: async () => ({
        anchors: [
          { sourceFileId: 'artifact-1', versionId: 'version-1', fileName: 'paper.pdf' },
          { sourceFileId: 'artifact-2', versionId: 'version-9', fileName: 'other.pdf' }
        ]
      }),
      readAnnotations: async () => ({ annotations: [annotation()] })
    })

    const read = await corpus.list({ projectId: 'project-1' })

    expect(read.annotations).toEqual([
      {
        id: 'annotation-1',
        projectId: 'project-1',
        sourceFileId: 'artifact-1',
        versionId: 'version-1',
        checksum: 'a'.repeat(64),
        kind: 'highlight',
        body: 'A note the reader typed.',
        quote: 'The passage the markup covers.',
        page: 3,
        fileName: 'paper.pdf',
        createdAt: 1
      }
    ])
  })

  it('does not attach a file name to an annotation whose anchor no anchor entry matches', async () => {
    // A row whose anchor the project no longer lists is dropped rather than paired with a neighbour: a hit
    // that named another file would be a citation pointing at the wrong document.
    const corpus = createSearchAnnotationCorpus({
      listAnchors: async () => ({
        anchors: [{ sourceFileId: 'artifact-2', versionId: 'version-9', fileName: 'other.pdf' }]
      }),
      readAnnotations: async () => ({ annotations: [annotation()] })
    })

    expect((await corpus.list({ projectId: 'project-1' })).annotations).toEqual([])
  })

  it('reads no annotation at all when the project offers no anchor', async () => {
    const readAnnotations = vi.fn()
    const corpus = createSearchAnnotationCorpus({
      listAnchors: async () => ({ anchors: [] }),
      readAnnotations
    })

    expect(await corpus.list({ projectId: 'project-1' })).toEqual({
      annotations: [],
      bounded: false
    })
    expect(readAnnotations).not.toHaveBeenCalled()
  })

  it('carries both bounds through, so a short corpus says it is short', async () => {
    const anchors = [{ sourceFileId: 'artifact-1', versionId: 'version-1', fileName: 'paper.pdf' }]
    const listBounded = createSearchAnnotationCorpus({
      listAnchors: async () => ({ anchors, bounded: true }),
      readAnnotations: async () => ({ annotations: [] })
    })
    expect((await listBounded.list({ projectId: 'p' })).bounded).toBe(true)

    const readBounded = createSearchAnnotationCorpus({
      listAnchors: async () => ({ anchors }),
      readAnnotations: async () => ({ annotations: [], bounded: true })
    })
    expect((await readBounded.list({ projectId: 'p' })).bounded).toBe(true)
  })

  it('asks the store for the bounded number of annotations, and no more', async () => {
    const readAnnotations = vi.fn(async () => ({ annotations: [] }))
    const corpus = createSearchAnnotationCorpus({
      listAnchors: async () => ({
        anchors: [{ sourceFileId: 'artifact-1', versionId: 'version-1', fileName: 'paper.pdf' }]
      }),
      readAnnotations
    })

    await corpus.list({ projectId: 'project-1' })

    expect(readAnnotations).toHaveBeenCalledWith({
      anchors: [{ sourceFileId: 'artifact-1', versionId: 'version-1' }],
      limit: GLOBAL_SEARCH_MAX_SCANNED_ANNOTATIONS
    })
  })

  it('keeps the page for the kinds that have one and drops it for the kinds that do not', async () => {
    const corpus = createSearchAnnotationCorpus({
      listAnchors: async () => ({
        anchors: [{ sourceFileId: 'artifact-1', versionId: 'version-1', fileName: 'paper.pdf' }]
      }),
      readAnnotations: async () => ({
        annotations: [
          annotation({
            id: 'note',
            kind: 'document-note',
            selector: { version: 1, shape: 'document-note' },
            body: 'Whole document.'
          }),
          annotation({
            id: 'area',
            kind: 'area',
            selector: {
              version: 1,
              shape: 'area',
              page: 7,
              rect: { x: 0, y: 0, width: 0.5, height: 0.5 }
            },
            body: ''
          })
        ]
      })
    })

    const read = await corpus.list({ projectId: 'project-1' })
    expect(read.annotations[0]).not.toHaveProperty('page')
    expect(read.annotations[0]!.quote).toBe('')
    expect(read.annotations[1]!.page).toBe(7)
  })
})

describe('isAnnotatableProjectFile', () => {
  it('accepts a PDF by MIME or by extension, and nothing else', () => {
    expect(isAnnotatableProjectFile({ name: 'paper.PDF' })).toBe(true)
    expect(isAnnotatableProjectFile({ name: 'paper', mimeType: 'application/pdf' })).toBe(true)
    expect(isAnnotatableProjectFile({ name: 'notes.md', mimeType: 'text/markdown' })).toBe(false)
    expect(isAnnotatableProjectFile({ name: 'archive.pdf.zip' })).toBe(false)
  })
})

describe('the corpus module never parses a PDF', () => {
  it('imports no PDF parser and no file reader', async () => {
    const source = await readFile(
      join(process.cwd(), 'src', 'main', 'search', 'annotation-corpus.ts'),
      'utf8'
    )
    const imports = [...source.matchAll(/^import[^\n]*from '([^']+)'/gm)].map((match) => match[1]!)

    // 只读已存文本、不解析 PDF, asserted rather than promised: this module's dependencies are listed
    // exhaustively below, and every PDF reader or file reader the app owns is named as forbidden. A later
    // change that wanted PDF text in the corpus would have to add one of them in the open — and this
    // assertion would refuse it, which is what makes the red line enforceable instead of aspirational.
    const forbidden = [
      'pdfjs-dist',
      'node:fs',
      'node:fs/promises',
      '../uploads/attachment-media',
      '../references/pdf-embedded-annotation-reader',
      '../references/pdf-annotation-import',
      '../references/pdf-annotation-export'
    ]
    for (const specifier of imports) {
      expect(forbidden, `${specifier} must not be a PDF or file reader`).not.toContain(specifier)
    }
    // The exact dependency list, pinned: anything added here is a deliberate decision, not a drift.
    expect(imports.sort()).toEqual([
      '../../shared/global-search',
      '../../shared/pdf-annotation-citation',
      '../../shared/pdf-annotations',
      './global-search-service'
    ])
  })
})
