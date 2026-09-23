// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { OmicsPreviewLauncher } from './OmicsPreviewLauncher'

const manifest = {
  schemaVersion: 1,
  path: '/data/pbmc.h5ad',
  format: 'h5ad',
  generatedAt: '2026-09-12T00:00:00.000Z',
  nObs: 20000,
  nVars: 1500,
  subset: { kept: 2000, total: 20000, reason: 'preview budget' },
  fullRunRequired: true,
  notes: ['preview read only the header and the first 2000 cells']
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const loadFile = async (contents: string): Promise<void> => {
  const input = container.querySelector('[data-testid="omics-manifest-input"]') as HTMLInputElement
  expect(input).toBeTruthy()
  Object.defineProperty(input, 'files', {
    value: [new File([contents], 'pbmc.preview.json', { type: 'application/json' })],
    configurable: true
  })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
  })
}

describe('OmicsPreviewLauncher', () => {
  it('explains how to produce the manifest instead of inventing one', () => {
    act(() => root.render(<OmicsPreviewLauncher sourceName="pbmc.h5ad" />))
    const guidance =
      container.querySelector('[data-testid="omics-launcher-guidance"]')?.textContent ?? ''
    expect(guidance).toContain('omics-data-preview')
    expect(guidance).toContain('will not invent a cell count')
  })

  it('loads a valid manifest and hands it to the panel', async () => {
    act(() => root.render(<OmicsPreviewLauncher sourceName="pbmc.h5ad" />))
    await loadFile(JSON.stringify(manifest))
    const source =
      container.querySelector('[data-testid="omics-manifest-source"]')?.textContent ?? ''
    expect(source).toContain('/data/pbmc.h5ad')
  })

  it('rejects a document that is not a manifest', async () => {
    act(() => root.render(<OmicsPreviewLauncher sourceName="pbmc.h5ad" />))
    await loadFile(JSON.stringify({ hello: 'world' }))
    const error = container.querySelector('[data-testid="omics-launcher-error"]')?.textContent ?? ''
    expect(error).toContain('is not a valid preview manifest')
    expect(container.querySelector('[data-testid="omics-manifest-source"]')).toBeNull()
  })

  it('reports unparseable JSON as an error rather than crashing', async () => {
    act(() => root.render(<OmicsPreviewLauncher sourceName="pbmc.h5ad" />))
    await loadFile('{not json')
    const error = container.querySelector('[data-testid="omics-launcher-error"]')?.textContent ?? ''
    expect(error).toContain('Could not read the manifest')
  })
})
