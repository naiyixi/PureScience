// @vitest-environment jsdom
// The reference-import receipt: what a PDF import reports, including the parts that failed.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let container: HTMLDivElement
let root: Root

const render = async (): Promise<void> => {
  const { ReferenceImportPanel } = await import('./ReferenceImportPanel')
  act(() => {
    root.render(
      <ReferenceImportPanel projectId="project-a" sourcePath="/papers/paper.pdf" onClose={vi.fn()} />
    )
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const withImport = (result: unknown): void => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { references: { importDoisFromPdf: vi.fn().mockResolvedValue(result) } }
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
  vi.restoreAllMocks()
})

describe('ReferenceImportPanel', () => {
  it('reports what the import found, including the identifiers it could not resolve', async () => {
    withImport({
      outcomes: [
        { doi: '10.1038/nature12373', status: 'created', referenceId: 'ref-1' },
        { doi: '10.1101/dead.2020.001', status: 'failed', reason: 'no metadata found for this DOI' }
      ],
      created: 1,
      duplicates: 0,
      failed: 1,
      truncated: 3
    })
    await render()

    expect(container.querySelector('[data-testid="reference-import-summary"]')?.textContent).toBe(
      'Added 1 · already present 0 · failed 1'
    )
    expect(container.querySelector('[data-testid="reference-import-truncated"]')?.textContent).toContain('3')
    const failures = container.querySelector('[data-testid="reference-import-failures"]')
    expect(failures?.textContent).toContain('10.1101/dead.2020.001')
    expect(failures?.textContent).toContain('no metadata found for this DOI')
  })

  // A PDF with no citations is a normal outcome, not an error the reader has to interpret.
  it('says a document carried no identifier instead of showing an empty summary', async () => {
    withImport({ outcomes: [], created: 0, duplicates: 0, failed: 0, truncated: 0 })
    await render()

    expect(container.textContent).toContain('No DOI was found in this document.')
    expect(container.querySelector('[data-testid="reference-import-summary"]')).toBeNull()
  })

  it('shows the error when the import itself could not run', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        references: {
          importDoisFromPdf: vi.fn().mockRejectedValue(new Error('The PDF reader is not available yet.'))
        }
      }
    })
    await render()

    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('The PDF reader is not available yet.')
  })

  it('degrades honestly in a shell without the import surface', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: { references: {} } })
    await render()

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'not available in this window'
    )
  })
})
