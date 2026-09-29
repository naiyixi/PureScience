// @vitest-environment jsdom
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
import type { PdfAnnotation } from '../../../../../../shared/pdf-annotations'
import type { PdfAnnotationView } from '../../../../../../shared/pdf-annotation-surface'
import { PdfAnnotationPanel } from './PdfAnnotationPanel'

// The annotation panel rendered as a CITATION CHAIN (文档标注层 A5, 需求 2 + 红线 3).
//
// Two things have to be true on screen, and both are asserted from the DOM rather than restated:
//
//   * 引文链能看到关联标注 — every annotation carries the record that makes it attributable: the file
//     version, the checksum, the page, the boxes and the quoted passage. All five are on the element, so an
//     acceptance run reads them off the panel instead of trusting the prose next to them.
//   * 标注不进模型上下文 — the panel says so in the reader's own language. The executable form of that
//     claim is beside the two paths that build model input
//     (src/main/acp/pdf-annotation-model-input-boundary.test.ts); what is asserted here is that the
//     reader is told, in every shipped language, rather than left to assume either way.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const quoteAnnotation = (): PdfAnnotation => ({
  id: 'annotation-quote',
  sourceFileId: 'artifact-1',
  versionId: 'version-1',
  checksum: 'a'.repeat(64),
  kind: 'highlight',
  selector: {
    version: 1,
    shape: 'text-range',
    page: 4,
    rects: [
      { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
      { x: 0.1, y: 0.25, width: 0.2, height: 0.04 }
    ],
    quote: 'the effect is large'
  },
  body: 'Check this against Table 2.',
  createdAt: 1
})

const documentNote = (): PdfAnnotation => ({
  id: 'annotation-document',
  sourceFileId: 'artifact-1',
  versionId: 'version-1',
  checksum: 'b'.repeat(64),
  kind: 'document-note',
  selector: { version: 1, shape: 'document-note' },
  body: 'The whole document needs a second pass.',
  createdAt: 2
})

const viewOf = (
  annotation: PdfAnnotation,
  anchorState: PdfAnnotationView['anchorState'] = 'current'
): PdfAnnotationView => ({ annotation, anchorState })

const render = (props: Partial<React.ComponentProps<typeof PdfAnnotationPanel>> = {}): void => {
  act(() => {
    root.render(
      <LanguageProvider>
        <PdfAnnotationPanel
          annotations={[]}
          counts={{ current: 0, versionChanged: 0, checksumMismatch: 0 }}
          onDelete={vi.fn()}
          onReattach={vi.fn()}
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
}

const citations = (): HTMLElement[] =>
  [...container.querySelectorAll('[data-testid="pdf-annotation-citation"]')] as HTMLElement[]

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

describe('PdfAnnotationPanel — the citation record', () => {
  it('carries the version, the checksum, the page, the boxes and the quoted passage', () => {
    render({
      annotations: [viewOf(quoteAnnotation())],
      counts: { current: 1, versionChanged: 0, checksumMismatch: 0 },
      anchor: { sourceFileId: 'artifact-1', versionId: 'version-1', checksum: 'a'.repeat(64) }
    })

    const [citation] = citations()
    expect(citation).toBeDefined()
    expect(citation!.getAttribute('data-status')).toBe('record')
    expect(citation!.getAttribute('data-annotation-id')).toBe('annotation-quote')
    expect(citation!.getAttribute('data-source-file-id')).toBe('artifact-1')
    expect(citation!.getAttribute('data-version-id')).toBe('version-1')
    expect(citation!.getAttribute('data-checksum')).toBe('a'.repeat(64))
    expect(citation!.getAttribute('data-anchor-state')).toBe('current')
    expect(citation!.getAttribute('data-page')).toBe('4')
    expect(citation!.getAttribute('data-rect-count')).toBe('2')
    expect(citation!.getAttribute('data-quote')).toBe('the effect is large')
    // And the same facts are legible on screen, with their labels from the dictionary.
    expect(citation!.textContent).toContain('Citation: annotation-quote (highlight)')
    expect(citation!.textContent).toContain(`Checksum: sha256:${'a'.repeat(64)}`)
    expect(citation!.textContent).toContain('Page: 4')
    expect(citation!.textContent).toContain('Region 1: 0.100 0.200 0.300 0.040')
    expect(citation!.textContent).toContain('Quoted passage: the effect is large')
    expect(citation!.textContent).toContain('Annotation text: Check this against Table 2.')
  })

  it('reports a markup on other bytes as such, instead of citing it as if it were on these', () => {
    render({
      annotations: [viewOf(quoteAnnotation(), 'version-changed')],
      counts: { current: 0, versionChanged: 1, checksumMismatch: 0 },
      anchor: { sourceFileId: 'artifact-1', versionId: 'version-1', checksum: 'a'.repeat(64) }
    })

    expect(citations()[0]!.getAttribute('data-anchor-state')).toBe('version-changed')
    expect(citations()[0]!.textContent).toContain('Anchor: version-changed')
  })

  it('leaves the page and the boxes off a document-wide note rather than printing a placeholder', () => {
    render({
      annotations: [viewOf(documentNote())],
      counts: { current: 1, versionChanged: 0, checksumMismatch: 0 }
    })

    const [citation] = citations()
    expect(citation!.getAttribute('data-page')).toBeNull()
    expect(citation!.getAttribute('data-rect-count')).toBe('0')
    expect(citation!.getAttribute('data-quote')).toBe('')
    expect(citation!.textContent).not.toContain('Page:')
    expect(citation!.textContent).not.toContain('Region 1:')
    expect(citation!.textContent).toContain(
      'Annotation text: The whole document needs a second pass.'
    )
  })

  it('refuses to cite a stored row whose kind and selector disagree, by name', () => {
    // A row that got in outside this layer: an area kind with a text-range selector. The panel shows the
    // validator's reason rather than a citation built from fields that do not belong to the kind.
    render({
      annotations: [
        viewOf({
          ...quoteAnnotation(),
          kind: 'area',
          selector: {
            version: 1,
            shape: 'text-range',
            page: 1,
            rects: [{ x: 0, y: 0, width: 1, height: 0.1 }],
            quote: 'q'
          }
        } as unknown as PdfAnnotation)
      ],
      counts: { current: 1, versionChanged: 0, checksumMismatch: 0 }
    })

    const [citation] = citations()
    expect(citation!.getAttribute('data-status')).toBe('refused')
    expect(citation!.getAttribute('data-code')).toBe('selector-shape-mismatch')
    expect(citation!.textContent).toContain('selector shape')
  })

  it('states the model-context policy in every shipped language', () => {
    const languages = [zh, en, zhHant, ja, ko, fr, de, es, ru]

    for (const language of languages) {
      // The key is present with a non-empty translation in all nine dictionaries — a claim the reader can
      // read beats a claim only the source code makes.
      expect(String(language['pdfAnnotation.policy.modelContext']).trim().length).toBeGreaterThan(0)
      expect(String(language['pdfAnnotation.citation.refused'])).toContain('{reason}')
      expect(String(language['gs.contentScopeAnnotation']).trim().length).toBeGreaterThan(0)
      expect(String(language['gs.contentAnnotationsEmpty']).trim().length).toBeGreaterThan(0)
    }

    render({})
    const policy = container.querySelector('[data-testid="pdf-annotation-model-context-policy"]')
    expect(policy).not.toBeNull()
    expect(policy!.textContent).toContain('model')
  })
})
