// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'

const mocks = vi.hoisted(() => ({
  state: { current: undefined as unknown },
  fromSmiles: vi.fn(),
  fromMolfile: vi.fn()
}))

vi.mock('../usePreviewFileContent', () => ({
  usePreviewFileContent: (): unknown => mocks.state.current
}))
vi.mock('openchemlib', () => ({
  Molecule: {
    fromSmiles: mocks.fromSmiles,
    fromMolfile: mocks.fromMolfile
  }
}))

import { MoleculePreviewRenderer } from './MoleculePreview'

/**
 * How long a coordination wait may take.
 *
 * Every `vi.waitFor` in this file is a *coordination* wait: it waits for the side effect of work that
 * is already in flight (a spy being called, a process dying, a worker reporting that it started, a
 * rendered node reaching its final text), never for something that may never happen. The only thing
 * the window has to cover is how long a loaded machine takes to schedule that continuation -- so the
 * default 1s is a quiet-machine budget, not a correctness budget. Measured on this repository: under
 * load a coordinated wait took up to 704ms (34 samples, p90 = 361ms), and a site elsewhere in the
 * suite failed at ~1.1s under load average ~70 while passing on a quiet machine.
 *
 * 30s matches the window this repository already uses for load-sensitive waits, and it stays well below
 * vitest's 60s per-test timeout, so an assertion that is genuinely stuck still fails as a failure
 * instead of hanging.
 */
const COORDINATION_WINDOW_MS = 30_000

const item = (name: string): PreviewFileItem => ({
  id: `artifact:${name}`,
  sessionId: 'session-1',
  title: name,
  type: 'file',
  path: `/workspace/${name}`,
  name,
  format: 'molecule'
})

const readyState = (content: string, overrides: Record<string, unknown> = {}): unknown => ({
  status: 'ready',
  preview: { content, encoding: 'utf8', truncated: false, ...overrides },
  pagination: {
    pageNumber: 1,
    hasPrevious: false,
    hasNext: false,
    previousPage: vi.fn(),
    nextPage: vi.fn()
  }
})

describe('MoleculePreviewRenderer', () => {
  let container: HTMLDivElement
  let root: Root
  let restoreLayout: (() => void) | undefined

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    mocks.fromSmiles.mockReset()
    mocks.fromMolfile.mockReset()
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 640
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 400
    })
    restoreLayout = () => {
      if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width)
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
      if (height) Object.defineProperty(HTMLElement.prototype, 'clientHeight', height)
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    }
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container.remove()
    restoreLayout?.()
  })

  const render = async (file: PreviewFileItem): Promise<void> => {
    root = createRoot(container)
    await act(async () => {
      root.render(<MoleculePreviewRenderer item={file} />)
      await Promise.resolve()
    })
  }

  it('renders SMILES through OpenChemLib with the available canvas size', async () => {
    const toSVG = vi.fn(() => '<svg data-testid="molecule-svg"></svg>')
    mocks.fromSmiles.mockReturnValue({ toSVG })
    mocks.state.current = readyState('CCO')

    await render(item('ethanol.smi'))
    await vi.waitFor(() => expect(mocks.fromSmiles).toHaveBeenCalledWith('CCO'), {
      timeout: COORDINATION_WINDOW_MS
    })

    expect(toSVG).toHaveBeenCalledWith(
      640,
      400,
      expect.stringMatching(/^mol-/),
      expect.objectContaining({ autoCrop: true, autoCropMargin: 16 })
    )
    expect(container.querySelector('[data-testid="molecule-svg"]')).not.toBeNull()
  })

  it('shows an in-place rendering error when OpenChemLib rejects a molecule', async () => {
    mocks.fromSmiles.mockImplementation(() => {
      throw new Error('invalid SMILES')
    })
    mocks.state.current = readyState('not-a-smiles')

    await render(item('broken.smi'))
    await vi.waitFor(() => expect(container.textContent).toContain('invalid SMILES'), {
      timeout: COORDINATION_WINDOW_MS
    })

    expect(container.textContent).toContain('Structure could not be rendered')
  })

  it('uses source content rather than attempting to parse an incomplete molecule fragment', async () => {
    mocks.state.current = readyState('partial molfile', { truncated: true })

    await render(item('large.sdf'))

    expect(container.textContent).toContain('partial molfile')
    expect(mocks.fromMolfile).not.toHaveBeenCalled()
  })

  it('uses the structure fallback for non-UTF8 previews', async () => {
    mocks.state.current = readyState('AAECAw==', { encoding: 'base64' })

    await render(item('binary.mol'))

    expect(container.textContent).toContain("Structure file couldn't be read for preview")
    expect(mocks.fromMolfile).not.toHaveBeenCalled()
  })
})
