// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LanguageProvider } from '@/i18n'
import type { PdfFigureForAgent, PdfOutlineEntry } from '../../../../shared/pdf'
import { PdfExplorePanel } from './PdfExplorePanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The document's own structure, exactly as the reader hands it over: a two-level bookmark tree and figures
// on two pages, one of them without a caption because the document gives none. The panel must show these
// numbers and must not invent an outline entry, a caption or a page — and it has to say what it skipped,
// so an empty figure list is never read as "this paper has no figures".
const OUTLINE: PdfOutlineEntry[] = [
  { title: '1 Introduction', page: 1, level: 1 },
  { title: '1.1 Motivation', page: 2, level: 2 }
]

const FIGURES: PdfFigureForAgent[] = [
  {
    page: 2,
    index: 1,
    bbox: { x: 10, y: 20, width: 300.4, height: 120.6 },
    caption: 'Figure 1. Expression levels.',
    captionSource: 'below',
    warnings: ['verify-against-source']
  },
  {
    page: 4,
    index: 1,
    bbox: { x: 5, y: 5, width: 200, height: 100 },
    captionSource: 'none',
    warnings: []
  }
]

let container: HTMLDivElement
let root: Root

const mount = async (options: {
  outline?: PdfOutlineEntry[]
  pageCount?: number
  figures?: PdfFigureForAgent[]
  scannedPages?: number
  skippedSmall?: number
  withoutCaption?: number
  pdf?: unknown
}): Promise<void> => {
  ;(window as unknown as { api: unknown }).api = {
    pdf:
      options.pdf === undefined
        ? {
            open: vi.fn().mockResolvedValue({
              doc: {
                docId: 'doc-1',
                title: 'paper.pdf',
                pageCount: options.pageCount ?? 4,
                outline: []
              },
              textPageCount: 4,
              emptyPageCount: 0
            }),
            outline: vi.fn().mockResolvedValue({
              docId: 'doc-1',
              title: 'paper.pdf',
              pageCount: options.pageCount ?? 4,
              outline: options.outline ?? OUTLINE
            }),
            figures: vi.fn().mockResolvedValue({
              docId: 'doc-1',
              scannedPages: options.scannedPages ?? 4,
              figures: options.figures ?? FIGURES,
              skippedSmall: options.skippedSmall ?? 0,
              withoutCaption: options.withoutCaption ?? 1
            })
          }
        : options.pdf
  }
  await act(async () => {
    root.render(
      <LanguageProvider>
        <PdfExplorePanel projectId="project-1" sourcePath="paper.pdf" onClose={() => undefined} />
      </LanguageProvider>
    )
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
  delete (window as unknown as { api?: unknown }).api
})

describe('PdfExplorePanel', () => {
  it('renders the document’s own bookmark tree with its own page numbers', async () => {
    await mount({})

    const rows = container.querySelectorAll('[data-testid^="pdf-explore-outline-"]')
    // The container testid shares the prefix, so count the row elements themselves.
    const rowElements = [...rows].filter((node) => node.tagName === 'LI')
    expect(rowElements).toHaveLength(2)
    expect(container.querySelector('[data-testid="pdf-explore-outline-0"]')?.textContent).toContain(
      '1 Introduction'
    )
    expect(
      container.querySelector('[data-testid="pdf-explore-outline-page-1"]')?.textContent
    ).toBeTruthy()
    // The second entry is a level-2 bookmark: the panel reflects the document's own nesting.
    const nested = container.querySelector<HTMLElement>('[data-testid="pdf-explore-outline-1"]')
    expect(nested?.style.paddingInlineStart).toBe('12px')
  })

  it('groups figures by page and says when the document gives no caption', async () => {
    await mount({})

    expect(container.querySelector('[data-testid="pdf-explore-figure-page-2"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="pdf-explore-figure-page-4"]')).not.toBeNull()
    const first = container.querySelector('[data-testid="pdf-explore-figure-2-1"]')?.textContent
    expect(first).toContain('Figure 1. Expression levels.')
    // #1 · 300x121 — the box size is reported as the reader measured it, rounded for display only.
    expect(first).toContain('300x121')
    // The uncaptioned figure says so in the reader's language instead of rendering an empty line.
    expect(
      container.querySelector('[data-testid="pdf-explore-figure-4-1"]')?.textContent
    ).toContain('no caption')
    expect(
      container.querySelector('[data-testid="pdf-explore-figures-uncaptioned"]')
    ).not.toBeNull()
  })

  it('reports how far it looked instead of showing a bare empty list', async () => {
    await mount({ outline: [], figures: [], scannedPages: 12 })

    const outlineEmpty = container.querySelector('[data-testid="pdf-explore-outline-empty"]')
    expect(outlineEmpty).not.toBeNull()
    expect(outlineEmpty?.textContent).toBeTruthy()
    // An empty figure list is only trustworthy together with the number of pages that were scanned.
    const scan = container.querySelector('[data-testid="pdf-explore-figures-scan"]')
    expect(scan?.textContent).toContain('12')
    expect(container.querySelector('[data-testid="pdf-explore-figures-empty"]')).not.toBeNull()
  })

  it('counts the placements the extractor dropped rather than hiding them', async () => {
    await mount({ skippedSmall: 7, withoutCaption: 2 })

    expect(
      container.querySelector('[data-testid="pdf-explore-figures-skipped"]')?.textContent
    ).toContain('7')
    expect(
      container.querySelector('[data-testid="pdf-explore-figures-uncaptioned"]')?.textContent
    ).toContain('2')
  })

  it('says the channel is unavailable rather than rendering an empty document', async () => {
    await mount({ pdf: null })

    expect(container.querySelector('[data-testid="pdf-explore-outline-failed"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="pdf-explore-figures-failed"]')).not.toBeNull()
  })
})
