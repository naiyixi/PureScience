// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LanguageProvider } from '@/i18n'
import { de } from '@/i18n/de'
import { en } from '@/i18n/en'
import { es } from '@/i18n/es'
import { fr } from '@/i18n/fr'
import { ja } from '@/i18n/ja'
import { ko } from '@/i18n/ko'
import { ru } from '@/i18n/ru'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-Hant'
import type { PdfAnnotationView } from '../../../../../../shared/pdf-annotation-surface'
import type { PdfAnnotationExportReceipt } from '../../../../../../shared/pdf-annotation-surface'
import type { PdfAnnotation } from '../../../../../../shared/pdf-annotations'
import type { PdfEmbeddedAnnotationImportReport } from '../../../../../../shared/pdf-annotation-import'
import { PdfAnnotationPanel, type PdfAnnotationImportView } from './PdfAnnotationPanel'

// The annotation panel (文档标注层 A3), rendered: what it lists, what it says about an anchor that
// stopped matching, and what an import's own report turns into on screen.
//
// The copy comes from the real dictionaries (the provider falls back to English outside one, which is
// what makes these assertions meaningful in a bare jsdom): the panel is the surface where a reader learns
// their markup is on other bytes, so "the state is named and the handling path is stated" is asserted
// against the rendered text, not against a data attribute.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const annotation = (overrides: Partial<PdfAnnotation> = {}): PdfAnnotation => ({
  id: 'annotation-1',
  sourceFileId: 'artifact-1',
  versionId: 'version-1',
  checksum: 'a'.repeat(64),
  kind: 'area',
  selector: {
    version: 1,
    shape: 'area',
    page: 2,
    rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
  },
  body: '',
  createdAt: 1,
  ...overrides
})

const noteAnnotation = (): PdfAnnotation =>
  annotation({
    id: 'annotation-note',
    kind: 'page-note',
    body: 'The sample size is the weak point.',
    selector: { version: 1, shape: 'page-note', page: 3 }
  })

const quoteAnnotation = (): PdfAnnotation =>
  annotation({
    id: 'annotation-quote',
    kind: 'highlight',
    selector: {
      version: 1,
      shape: 'text-range',
      page: 1,
      rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.02 }],
      quote: 'the effect is large'
    }
  })

const viewOf = (
  annotationValue: PdfAnnotation,
  anchorState: PdfAnnotationView['anchorState'] = 'current'
): PdfAnnotationView => ({ annotation: annotationValue, anchorState })

const render = (
  props: Partial<React.ComponentProps<typeof PdfAnnotationPanel>> = {}
): ReturnType<typeof vi.fn>[] => {
  const onDelete = vi.fn()
  const onReattach = vi.fn()
  act(() => {
    root.render(
      // Rendered through the real provider: the panel's copy is the dictionary's, placeholders included —
      // which is the point of asserting on the rendered text rather than on a data attribute.
      <LanguageProvider>
        <PdfAnnotationPanel
          annotations={[]}
          counts={{ current: 0, versionChanged: 0, checksumMismatch: 0 }}
          onDelete={onDelete}
          onReattach={onReattach}
          noteBody=""
          onNoteBodyChange={vi.fn()}
          onNoteSave={vi.fn()}
          onNoteCancel={vi.fn()}
          importer={{ kind: 'idle' }}
          onImport={vi.fn()}
          exporter={{ kind: 'idle' }}
          onExportAnnotated={vi.fn()}
          onExportNotes={vi.fn()}
          onClose={vi.fn()}
          {...props}
        />
      </LanguageProvider>
    )
  })
  return [onDelete, onReattach]
}

const item = (selector: string): HTMLElement | null =>
  container.querySelector(selector) as HTMLElement | null

const items = (): HTMLElement[] =>
  [...container.querySelectorAll('[data-testid="pdf-annotation-item"]')] as HTMLElement[]

const click = (element: HTMLElement | null): void => {
  if (!element) throw new Error('nothing to click')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('PdfAnnotationPanel', () => {
  it('lists the annotations of the file with their kind, page and text', () => {
    render({
      annotations: [viewOf(quoteAnnotation()), viewOf(noteAnnotation())],
      counts: { current: 2, versionChanged: 0, checksumMismatch: 0 }
    })

    expect(items()).toHaveLength(2)
    expect(items()[0]?.getAttribute('data-kind')).toBe('highlight')
    expect(items()[0]?.textContent).toContain('Highlight')
    expect(items()[0]?.textContent).toContain('page 1')
    expect(items()[0]?.textContent).toContain('the effect is large')
    expect(items()[1]?.textContent).toContain('Page note')
    expect(items()[1]?.textContent).toContain('The sample size is the weak point.')
    // Nothing anchored elsewhere is labelled when everything is on the version on screen.
    expect(item('[data-testid="pdf-annotation-anchor-state"]')).toBeNull()
    expect(item('[data-testid="pdf-annotation-reattach"]')).toBeNull()
    expect(item('[data-testid="pdf-annotation-empty"]')).toBeNull()
  })

  it('says which files version an annotation belongs to and offers the re-anchor path', () => {
    const [, onReattach] = render({
      annotations: [
        viewOf(annotation({ id: 'annotation-old', versionId: 'version-7' }), 'version-changed')
      ],
      counts: { current: 0, versionChanged: 1, checksumMismatch: 0 }
    })

    const listed = items()[0]
    expect(listed?.getAttribute('data-anchor-state')).toBe('version-changed')
    expect(item('[data-testid="pdf-annotation-anchor-state"]')?.textContent).toBe('Version changed')
    // The handling path is stated in words, names the version it is on, and is one press away.
    expect(listed?.textContent).toContain('version-7')
    expect(listed?.textContent).toContain('not the version on screen')
    expect(item('[data-testid="pdf-annotation-version-notice"]')?.textContent).toContain(
      'None of the 1 annotations sits on the version on screen.'
    )

    click(item('[data-testid="pdf-annotation-reattach"]'))
    expect(onReattach).toHaveBeenCalledWith('annotation-old')
  })

  it('names a broken anchor — the same version id with different bytes — separately', () => {
    render({
      annotations: [viewOf(annotation({ id: 'annotation-broken' }), 'checksum-mismatch')],
      counts: { current: 0, versionChanged: 0, checksumMismatch: 1 }
    })

    expect(item('[data-testid="pdf-annotation-anchor-state"]')?.textContent).toBe('Bytes changed')
    expect(items()[0]?.textContent).toContain('no longer carries the bytes')
    expect(item('[data-testid="pdf-annotation-reattach"]')).not.toBeNull()
  })

  it('deletes the annotation the reader pressed delete on, and nothing else', () => {
    const [onDelete] = render({
      annotations: [viewOf(quoteAnnotation()), viewOf(noteAnnotation())],
      counts: { current: 2, versionChanged: 0, checksumMismatch: 0 }
    })

    click(items()[1]?.querySelector('[data-testid="pdf-annotation-delete"]') as HTMLElement)
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith('annotation-note')
  })

  it('shows an empty state that says there is nothing yet rather than nothing at all', () => {
    render()
    expect(item('[data-testid="pdf-annotation-empty"]')?.textContent).toBe(
      'No annotations on this file yet'
    )
  })

  it('reports an import as the import reported it: imported, of the file’s own total, per kind', () => {
    const report: PdfEmbeddedAnnotationImportReport = {
      sourceKind: 'embedded-pdf',
      sourceFileId: 'artifact-1',
      versionId: 'version-1',
      checksum: 'a'.repeat(64),
      digest: 'a'.repeat(64),
      status: 'imported',
      imported: 2,
      kinds: [
        { kind: 'highlight', count: 1 },
        { kind: 'area', count: 1 }
      ],
      skipped: [
        { subtype: 'Ink', reason: 'unsupported-subtype', count: 3, detail: 'no counterpart' },
        { subtype: 'Text', reason: 'empty-note', count: 1, detail: 'carries no text' }
      ],
      pageCount: 2,
      annotationsInFile: 6,
      receiptCreated: true
    }
    render({ importer: { kind: 'report', report } })

    const status = item('[data-testid="pdf-annotation-import-status"]')
    expect(status?.getAttribute('data-status')).toBe('imported')
    expect(status?.textContent).toContain('Imported 2 of 6 annotations from this PDF')
    expect(status?.textContent).toContain('Skipped 4')
    expect(item('[data-testid="pdf-annotation-import-kinds"]')?.textContent).toBe(
      'Highlight ×1 · Region ×1'
    )

    // 跳过 M 条并列出原因类别与计数: every group the file carried is named with its reason category, the
    // file's own subtype, and how many — not folded into one number.
    const skipped = [
      ...container.querySelectorAll('[data-testid="pdf-annotation-import-skip"]')
    ] as HTMLElement[]
    expect(skipped.map((entry) => entry.getAttribute('data-reason'))).toEqual([
      'unsupported-subtype',
      'empty-note'
    ])
    expect(skipped.map((entry) => entry.getAttribute('data-count'))).toEqual(['3', '1'])
    expect(skipped[0]?.textContent).toBe('kind this build does not import: Ink ×3')
    expect(skipped[0]?.getAttribute('title')).toBe('no counterpart')
    expect(skipped[1]?.textContent).toBe('note carries no text: Text ×1')
  })

  it('says a file carries no annotations instead of showing a silent zero', () => {
    const report: PdfEmbeddedAnnotationImportReport = {
      sourceKind: 'embedded-pdf',
      sourceFileId: 'artifact-1',
      versionId: 'version-1',
      checksum: 'a'.repeat(64),
      digest: 'a'.repeat(64),
      status: 'no-annotations',
      imported: 0,
      kinds: [],
      skipped: [],
      pageCount: 0,
      annotationsInFile: 0,
      receiptCreated: false
    }
    render({ importer: { kind: 'report', report } })

    const status = item('[data-testid="pdf-annotation-import-status"]')
    expect(status?.getAttribute('data-status')).toBe('no-annotations')
    expect(status?.textContent).toBe('This PDF carries no annotations')
  })

  it('says an already-imported payload was not read again, and names an unsupported-only file', () => {
    const base = {
      sourceKind: 'embedded-pdf' as const,
      sourceFileId: 'artifact-1',
      versionId: 'version-1',
      checksum: 'a'.repeat(64),
      digest: 'a'.repeat(64),
      imported: 0,
      kinds: [],
      pageCount: 0,
      annotationsInFile: 0,
      receiptCreated: false
    }
    render({
      importer: {
        kind: 'report',
        report: { ...base, status: 'unchanged', skipped: [], receiptCreated: true }
      }
    })
    expect(item('[data-testid="pdf-annotation-import-status"]')?.textContent).toContain(
      'already imported on this version'
    )

    act(() => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    render({
      importer: {
        kind: 'report',
        report: {
          ...base,
          status: 'no-supported-annotations',
          annotationsInFile: 2,
          skipped: [
            { subtype: 'Ink', reason: 'unsupported-subtype', count: 2, detail: 'no counterpart' }
          ]
        }
      }
    })
    expect(item('[data-testid="pdf-annotation-import-status"]')?.textContent).toContain(
      'none this build can import'
    )
    expect(item('[data-testid="pdf-annotation-import-skip"]')?.textContent).toBe(
      'kind this build does not import: Ink ×2'
    )
  })

  it('names a refusal by its reason and keeps the refusal’s own words', () => {
    const importer: PdfAnnotationImportView = {
      kind: 'failure',
      code: 'checksum-mismatch',
      message: 'These bytes hash to bbbb, while the version checksum is aaaa.'
    }
    render({ importer })

    expect(item('[data-testid="pdf-annotation-import-status"]')?.textContent).toContain(
      'these bytes are not that file version'
    )
    expect(item('[data-testid="pdf-annotation-import-failure-detail"]')?.textContent).toBe(
      'These bytes hash to bbbb, while the version checksum is aaaa.'
    )
  })

  it('renders the dictionary of the language in effect, not an English literal', () => {
    // The stored preference is what the provider reads on mount, so this is the same path the app takes.
    window.localStorage.setItem('purescience-language', 'zh')
    try {
      render({ annotations: [], counts: { current: 0, versionChanged: 0, checksumMismatch: 0 } })
      expect(container.textContent).toContain(zh['pdfAnnotation.panel.title'])
      expect(item('[data-testid="pdf-annotation-empty"]')?.textContent).toBe(
        zh['pdfAnnotation.panel.empty']
      )
    } finally {
      window.localStorage.removeItem('purescience-language')
    }
  })

  it('says so when the annotations could not be read at all', () => {
    render({ loadError: 'Version version-1 is not one this store knows.' })
    expect(item('[data-testid="pdf-annotation-load-error"]')?.textContent).toBe(
      'Annotations could not be read: Version version-1 is not one this store knows.'
    )
  })

  it('composes a page note only once a page has been chosen', () => {
    const onNoteSave = vi.fn()
    render({ pendingNote: { page: 3 }, noteBody: 'worth keeping', onNoteSave })

    expect(item('[data-testid="pdf-annotation-note-composer"]')?.textContent).toContain(
      'Note on page 3'
    )
    expect((item('[data-testid="pdf-annotation-note-input"]') as HTMLTextAreaElement).value).toBe(
      'worth keeping'
    )
    click(item('[data-testid="pdf-annotation-note-save"]'))
    expect(onNoteSave).toHaveBeenCalledTimes(1)
  })
})

describe('the export channels', () => {
  const receipt = (
    overrides: Partial<PdfAnnotationExportReceipt> = {}
  ): PdfAnnotationExportReceipt => ({
    channel: 'annotated-pdf',
    provenance: {
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceFileId: 'artifact-1',
      versionId: 'version-1',
      checksum: 'a'.repeat(64),
      exportedAt: Date.UTC(2026, 8, 29, 12, 0, 0)
    },
    anchorChecksum: 'a'.repeat(64),
    sourceBytes: {
      path: '/tmp/region-evidence.pdf',
      checksumBefore: 'a'.repeat(64),
      checksumAfter: 'a'.repeat(64),
      bytes: 900
    },
    annotationsInStore: 2,
    annotationsExported: 1,
    kinds: [{ kind: 'area', count: 1 }],
    copy: {
      path: '/tmp/region-evidence (annotated).pdf',
      bytes: 1_240,
      sourceBytes: 900,
      appendedBytes: 340,
      pageCount: 1
    },
    notes: null,
    skipped: [],
    exportedAt: Date.UTC(2026, 8, 29, 12, 0, 0),
    ...overrides
  })

  it('offers both channels, each one press away, and says what each writes', () => {
    render({})

    const section = item('[data-testid="pdf-annotation-export"]')
    expect(section?.getAttribute('data-channels')).toBe('annotated-pdf notes')
    expect(section?.textContent).toContain('Save annotated copy')
    expect(section?.textContent).toContain('Save notes')
    expect(section?.textContent).toContain('never modified')
    expect(section?.textContent).toContain('produces no PDF')
    // Nothing is claimed before anything was exported.
    expect(item('[data-testid="pdf-annotation-export-status"]')).toBeNull()
  })

  it('triggers either channel on its own', () => {
    const onExportAnnotated = vi.fn()
    const onExportNotes = vi.fn()
    render({ onExportAnnotated, onExportNotes })

    click(item('[data-slot="pdf-annotation-export-notes"]'))
    expect(onExportNotes).toHaveBeenCalledTimes(1)
    expect(onExportAnnotated).not.toHaveBeenCalled()

    click(item('[data-slot="pdf-annotation-export-annotated"]'))
    expect(onExportAnnotated).toHaveBeenCalledTimes(1)
  })

  it('reports the annotated copy, the digest the source had before and after it, and the version', () => {
    const withSkipped = receipt({
      skipped: [
        { reason: 'another-version', count: 1, detail: 'drawn on other bytes' },
        { reason: 'document-level', count: 1, detail: 'names no page' }
      ]
    })
    render({
      annotations: [viewOf(annotation())],
      exporter: { kind: 'receipt', receipt: withSkipped }
    })

    const status = item('[data-testid="pdf-annotation-export-status"]')
    expect(status?.getAttribute('data-status')).toBe('exported')
    expect(status?.getAttribute('data-channel')).toBe('annotated-pdf')
    expect(status?.getAttribute('data-anchor-checksum')).toBe('a'.repeat(64))
    expect(item('[data-testid="pdf-annotation-export-summary"]')?.textContent).toContain(
      'Exported 1 of 2 annotations of version version-1'
    )

    const copy = item('[data-testid="pdf-annotation-export-copy"]')
    expect(copy?.getAttribute('data-path')).toBe('/tmp/region-evidence (annotated).pdf')
    expect(copy?.getAttribute('data-bytes')).toBe('1240')
    expect(copy?.getAttribute('data-source-bytes')).toBe('900')
    expect(copy?.getAttribute('data-appended-bytes')).toBe('340')

    // The red line, visible on the surface: the source's digest before and after the write, and the
    // version's own anchor — one number, three places.
    const source = item('[data-testid="pdf-annotation-export-source"]')
    expect(source?.getAttribute('data-checksum-before')).toBe('a'.repeat(64))
    expect(source?.getAttribute('data-checksum-after')).toBe('a'.repeat(64))
    expect(source?.getAttribute('data-anchor-checksum')).toBe('a'.repeat(64))
    expect(source?.textContent).toContain('was not modified')

    expect(item('[data-testid="pdf-annotation-export-provenance"]')?.textContent).toContain(
      'sha256'
    )
    // What the copy could not carry is named, with a count.
    expect(item('[data-testid="pdf-annotation-export-skipped-total"]')?.textContent).toBe(
      'Not carried into the copy: 2'
    )
    const skipped = container.querySelectorAll('[data-testid="pdf-annotation-export-skip"]')
    expect(skipped).toHaveLength(2)
    expect(skipped[0]?.getAttribute('data-reason')).toBe('another-version')
    expect(skipped[0]?.textContent).toBe('drawn on another version ×1')
    // No notes line and no "writes no PDF" claim: this channel produced a copy.
    expect(item('[data-testid="pdf-annotation-export-notes"]')).toBeNull()
    expect(item('[data-testid="pdf-annotation-export-no-pdf"]')).toBeNull()
  })

  it('reports the notes list and states that no PDF was produced', () => {
    const notesReceipt = receipt({
      channel: 'notes',
      sourceBytes: null,
      annotationsExported: 2,
      notes: { path: '/tmp/region-evidence (annotations).txt', bytes: 420, entryLines: 2 },
      copy: null
    })
    render({ exporter: { kind: 'receipt', receipt: notesReceipt } })

    const status = item('[data-testid="pdf-annotation-export-status"]')
    expect(status?.getAttribute('data-channel')).toBe('notes')
    // 仅此一处可见: no copy, and the channel says so in words rather than leaving it to the file name.
    expect(item('[data-testid="pdf-annotation-export-copy"]')).toBeNull()
    expect(item('[data-testid="pdf-annotation-export-source"]')).toBeNull()
    const notes = item('[data-testid="pdf-annotation-export-notes"]')
    expect(notes?.getAttribute('data-path')).toBe('/tmp/region-evidence (annotations).txt')
    expect(notes?.getAttribute('data-lines')).toBe('2')
    expect(item('[data-testid="pdf-annotation-export-no-pdf"]')?.textContent).toBe(
      'This channel writes no PDF'
    )
  })

  it('never reports a cancelled save as an export', () => {
    render({ exporter: { kind: 'cancelled', channel: 'notes' } })

    const status = item('[data-testid="pdf-annotation-export-status"]')
    expect(status?.getAttribute('data-status')).toBe('cancelled')
    expect(status?.getAttribute('data-channel')).toBe('notes')
    expect(status?.textContent).toContain('no file was written')
    expect(item('[data-testid="pdf-annotation-export-notes"]')).toBeNull()
    expect(item('[data-testid="pdf-annotation-export-copy"]')).toBeNull()
  })

  it('names the reason a channel wrote nothing, with the refusal’s own words', () => {
    render({
      exporter: {
        kind: 'failure',
        channel: 'annotated-pdf',
        code: 'nothing-to-export',
        message: 'This version carries no annotations, so there is nothing to write into a copy.'
      }
    })

    const status = item('[data-testid="pdf-annotation-export-status"]')
    expect(status?.getAttribute('data-status')).toBe('failure')
    expect(status?.getAttribute('data-code')).toBe('nothing-to-export')
    expect(status?.textContent).toContain('this version carries no annotation of its own')
    expect(item('[data-testid="pdf-annotation-export-failure-detail"]')?.textContent).toBe(
      'This version carries no annotations, so there is nothing to write into a copy.'
    )
  })

  it('disables both channels while one is running', () => {
    render({ exporter: { kind: 'running', channel: 'annotated-pdf' } })

    expect(item('[data-testid="pdf-annotation-export-status"]')?.getAttribute('data-status')).toBe(
      'running'
    )
    expect(
      (item('[data-slot="pdf-annotation-export-annotated"]') as HTMLButtonElement).disabled
    ).toBe(true)
    expect((item('[data-slot="pdf-annotation-export-notes"]') as HTMLButtonElement).disabled).toBe(
      true
    )
  })
})

describe('the panel’s copy', () => {
  const languages: ReadonlyArray<[string, Partial<Record<keyof typeof en, string>>]> = [
    ['zh', zh],
    ['zh-Hant', zhHant],
    ['ja', ja],
    ['ko', ko],
    ['fr', fr],
    ['de', de],
    ['es', es],
    ['ru', ru]
  ]

  it('exists in all nine languages, and none of them falls back to English', () => {
    const keys = (Object.keys(en) as Array<keyof typeof en>).filter((key) =>
      key.startsWith('pdfAnnotation.')
    )
    expect(keys.length).toBeGreaterThan(50)

    for (const [language, dictionary] of languages) {
      const missing = keys.filter((key) => !(key in dictionary))
      expect(missing, `${language} is missing ${missing.join(', ')}`).toEqual([])
      const english = keys.filter((key) => (dictionary as Record<string, string>)[key] === en[key])
      expect(english, `${language} still shows English for ${english.join(', ')}`).toEqual([])
    }
  })

  // 禁硬编码文案: the renderer modules of this slice carry their copy in the dictionaries and nowhere else.
  // Comments are excluded (they are prose for whoever reads the code), and so are the dictionaries
  // themselves — what is checked is that no SCREEN TEXT was typed into a component.
  it('carries no CJK literal in the renderer code of this slice', () => {
    const dir = __dirname
    const files = [
      'PdfAnnotationPanel.tsx',
      'PdfAnnotationMarks.tsx',
      'PdfRegionOverlay.tsx',
      'PdfPreview.tsx',
      'pdf-annotation-content.ts',
      'pdf-annotation-marks.ts',
      'pdf-annotation-selection.ts'
    ]
    const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u

    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8')
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      expect(cjk.test(withoutComments), `${file} carries a CJK literal`).toBe(false)
    }
  })
})
