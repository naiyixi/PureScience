// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  OMICS_PREVIEW_SCHEMA_VERSION,
  type OmicsPreviewManifest
} from '../../../../shared/omics-preview'
import { OmicsPreviewPanel } from './OmicsPreviewPanel'

let container: HTMLDivElement
let root: Root

const manifest = (overrides: Partial<OmicsPreviewManifest> = {}): OmicsPreviewManifest => ({
  schemaVersion: OMICS_PREVIEW_SCHEMA_VERSION,
  path: 'data/pbmc.h5ad',
  format: 'h5ad',
  generatedAt: '2026-09-12T00:00:00.000Z',
  nObs: 20000,
  nVars: 3000,
  subset: { applied: true, requestedCells: 2000, sampledCells: 2000, sampling: 'head' },
  fullRunRequired: true,
  notes: ['structure read via anndata (backed, read-only)'],
  ...overrides
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const text = (testId: string): string =>
  container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? ''

const button = (testId: string): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)

const selectHost = (name: string): void => {
  const select = container.querySelector('[data-testid="omics-host-select"]') as HTMLSelectElement
  act(() => {
    select.value = name
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('OmicsPreviewPanel', () => {
  it('labels a subset preview and warns it cannot be a final answer (G6)', () => {
    act(() => {
      root.render(<OmicsPreviewPanel manifest={manifest()} />)
    })
    expect(text('omics-scope-label')).toBe('基于 2000/20000 降采样（头部截取）')
    expect(text('omics-shape-summary')).toContain('20000 细胞 × 3000 特征')
    expect(text('omics-shape-summary')).toContain('需全量计算')
    expect(text('omics-provisional-warning')).toContain('不得作为最终结论')
  })

  it('gates the full-run submission on choosing a host (G1)', () => {
    const onSubmitFullRun = vi.fn()
    act(() => {
      root.render(
        <OmicsPreviewPanel
          manifest={manifest()}
          hosts={[{ name: 'gpu-a', executionMode: 'slurm' }]}
          engine="scanpy 1.10"
          onSubmitFullRun={onSubmitFullRun}
        />
      )
    })

    expect(button('omics-submit-full-run')?.disabled).toBe(true)
    expect(text('omics-proposal-missing')).toContain('未选择计算主机')

    selectHost('gpu-a')
    expect(button('omics-submit-full-run')?.disabled).toBe(false)
    expect(text('omics-proposal-deliverable')).toContain('gpu-a（Slurm 调度）')
    expect(text('omics-proposal-reason')).toContain('基于 2000/20000 降采样')

    act(() => button('omics-submit-full-run')?.click())
    expect(onSubmitFullRun).toHaveBeenCalledTimes(1)
    const proposal = onSubmitFullRun.mock.calls[0][0] as { requiresApproval: boolean }
    expect(proposal.requiresApproval).toBe(true)
  })

  it('explains the "not computed" instruction when no host exists, and never offers the number', () => {
    act(() => {
      root.render(<OmicsPreviewPanel manifest={manifest()} hosts={[]} />)
    })
    expect(text('omics-proposal-missing')).toContain('未选择计算主机')
    expect(container.textContent).toContain('未计算')
    expect(container.textContent).not.toContain('已提交')
  })

  it('declares the preview answerable when it covered the whole file', () => {
    act(() => {
      root.render(
        <OmicsPreviewPanel
          manifest={manifest({
            subset: { applied: false, requestedCells: 2000, sampledCells: 20000, sampling: 'head' },
            fullRunRequired: false
          })}
        />
      )
    })
    expect(text('omics-answerable')).toContain('可直接用于结论')
    expect(button('omics-submit-full-run')).toBeNull()
    expect(text('omics-scope-label')).toBe('全量（20000）')
  })
})
