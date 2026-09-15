// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PdfTablePanel } from './PdfTablePanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TABLE_PAGE = [
  'Sample    Value    sd',
  'control   12.4     1.1',
  'treated   31.8     2.4',
  'vehicle    9.7     0.8'
].join('\n')

let container: HTMLDivElement
let root: Root
let writeText: ReturnType<typeof vi.fn>

const mount = async (pages: { page: number; text: string }[]): Promise<void> => {
  ;(window as unknown as { api: unknown }).api = {
    pdf: {
      open: vi.fn().mockResolvedValue({
        doc: { docId: 'doc-1', title: 'paper.pdf', pageCount: pages.length, outline: [] },
        textPageCount: pages.length,
        emptyPageCount: 0
      }),
      pages: vi.fn().mockResolvedValue({ docId: 'doc-1', start: 1, end: pages.length, pages })
    }
  }
  await act(async () => {
    root.render(
      <PdfTablePanel projectId="project-1" sourcePath="paper.pdf" onClose={() => undefined} />
    )
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('PdfTablePanel', () => {
  it('shows a candidate with the reasons it must be checked, and copies an export that carries them', async () => {
    await mount([
      { page: 1, text: TABLE_PAGE },
      { page: 2, text: 'Just prose on this page.' }
    ])

    const candidate = container.querySelector('[data-testid="pdf-table-candidate"]')
    expect(candidate).not.toBeNull()
    expect(candidate?.textContent).toContain('Page 1')
    expect(candidate?.textContent).toContain('4 rows x 3 columns')
    expect(candidate?.textContent).toContain('text-layer-whitespace-clustering')
    // The mandatory labels are on screen, not only in the copied artifact.
    expect(candidate?.textContent).toContain('candidate-extraction')
    expect(candidate?.textContent).toContain('verify-against-source')
    expect(candidate?.textContent).toContain('control')

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid^="pdf-table-copy-markdown-"]')
        ?.click()
    })
    await act(async () => {
      await Promise.resolve()
    })

    const copied = writeText.mock.calls[0][0] as string
    expect(copied).toContain('> page 1')
    expect(copied).toContain('verify-against-source')
    expect(copied).toContain('| Sample | Value | sd |')
  })

  it('reports what it scanned instead of claiming the PDF has no tables', async () => {
    await mount([{ page: 1, text: 'Only prose, nothing tabular here.' }])

    expect(container.querySelector('[data-testid="pdf-table-candidate"]')).toBeNull()
    expect(container.textContent).toContain('No table candidate in the 1 page(s) scanned.')
  })

  it('says the reader is unavailable rather than showing an empty result', async () => {
    ;(window as unknown as { api: unknown }).api = { pdf: {} }

    await act(async () => {
      root.render(
        <PdfTablePanel projectId="project-1" sourcePath="paper.pdf" onClose={() => undefined} />
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('The PDF reader is unavailable on this surface.')
    expect(container.textContent).not.toContain('No table candidate')
  })
})
