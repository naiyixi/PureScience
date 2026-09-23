// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PDF_TABLES_MAX_CANDIDATES, type PdfTableCandidateForAgent } from '../../../../shared/pdf'
import { PdfTablePanel } from './PdfTablePanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A four-column table as the reader hands it over: geometry decided the columns, and the provenance strings
// were built by the exporter that the agent's tool also uses. The panel must render and copy exactly this —
// if it ever derived tables on its own again, the two would be free to disagree.
const HEADER = ['Sample', 'Value', 'sd', 'n']
const DATA_ROW = ['control', '12.4', '1.1', '6']
const CANDIDATE: PdfTableCandidateForAgent = {
  page: 3,
  status: 'candidate',
  method: 'text-layer-row-column-clustering',
  rows: [HEADER, DATA_ROW],
  columnCount: 4,
  confidence: 'medium',
  markdown: '> page 3\n> verify-against-source\n\n| Sample | Value | sd | n |',
  tsv: '# page 3\n# verify-against-source\nSample\tValue\tsd\tn\ncontrol\t12.4\t1.1\t6',
  html: '<table><caption>page 3; reason verify-against-source</caption></table>',
  warnings: ['candidate-extraction', 'verify-against-source']
}

let container: HTMLDivElement
let root: Root
let writeText: ReturnType<typeof vi.fn>

const mount = async (
  result: {
    candidates: PdfTableCandidateForAgent[]
    scannedPages: number
  },
  sessionId?: string
): Promise<void> => {
  ;(window as unknown as { api: unknown }).api = {
    pdf: {
      open: vi.fn().mockResolvedValue({
        doc: { docId: 'doc-1', title: 'paper.pdf', pageCount: 5, outline: [] },
        textPageCount: 5,
        emptyPageCount: 0
      }),
      tables: vi.fn().mockResolvedValue({ docId: 'doc-1', ...result })
    }
  }
  await act(async () => {
    root.render(
      <PdfTablePanel
        projectId="project-1"
        sourcePath="paper.pdf"
        sourceSessionId={sessionId}
        onClose={() => undefined}
      />
    )
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const cellsOf = (rowIndex: number): string[] =>
  Array.from(
    container.querySelectorAll<HTMLTableCellElement>(`[data-testid="pdf-table-row-${rowIndex}"] td`)
  ).map((cell) => cell.textContent ?? '')

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
  it("renders the reader's table column for column rather than a table of its own", async () => {
    await mount({ candidates: [CANDIDATE], scannedPages: 5 })

    const candidate = container.querySelector('[data-testid="pdf-table-candidate"]')
    expect(candidate).not.toBeNull()
    expect(candidate?.textContent).toContain('Page 3')
    expect(container.querySelector('[data-testid="pdf-table-shape"]')?.textContent).toContain(
      '2 rows x 4 columns'
    )
    expect(candidate?.textContent).toContain('text-layer-row-column-clustering')
    // The mandatory labels are on screen, not only in the copied artifact.
    expect(candidate?.textContent).toContain('candidate-extraction')
    expect(candidate?.textContent).toContain('verify-against-source')

    // Header and values, in the columns the reader put them in.
    expect(cellsOf(0)).toEqual([...HEADER])
    expect(cellsOf(1)).toEqual([...DATA_ROW])
  })

  it('copies the exports the reader produced, so they match what the agent is given', async () => {
    await mount({ candidates: [CANDIDATE], scannedPages: 5 })

    for (const [kind, expected] of [
      ['markdown', CANDIDATE.markdown],
      ['tsv', CANDIDATE.tsv],
      ['html', CANDIDATE.html]
    ] as const) {
      act(() => {
        container
          .querySelector<HTMLButtonElement>(`[data-testid^="pdf-table-copy-${kind}-"]`)
          ?.click()
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(writeText.mock.calls.at(-1)?.[0]).toBe(expected)
    }
  })

  it('reports what the reader looked at instead of claiming the PDF has no tables', async () => {
    await mount({ candidates: [], scannedPages: 5 })

    expect(container.querySelector('[data-testid="pdf-table-candidate"]')).toBeNull()
    expect(container.textContent).toContain('No table candidate in the 5 page(s) scanned.')
  })

  it("says it stopped at the reader's cap rather than implying the document holds no more", async () => {
    await mount({
      candidates: Array.from({ length: PDF_TABLES_MAX_CANDIDATES }, (_, index) => ({
        ...CANDIDATE,
        page: index + 1
      })),
      scannedPages: 12
    })

    expect(container.querySelector('[data-testid="pdf-table-capped"]')?.textContent).toContain(
      `Stopped at the first ${PDF_TABLES_MAX_CANDIDATES} candidates the reader returns.`
    )
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

  // A generated file is identified by its Version, which the reader can only resolve when it knows the
  // Session the file belongs to.
  it('tells the reader which Session the file belongs to', async () => {
    await mount({ candidates: [CANDIDATE], scannedPages: 5 }, 'session-1')

    const api = (window as unknown as { api: { pdf: { open: ReturnType<typeof vi.fn> } } }).api
    expect(api.pdf.open).toHaveBeenCalledWith({
      projectId: 'project-1',
      path: 'paper.pdf',
      sessionId: 'session-1'
    })
  })
})
