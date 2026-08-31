// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

import { render, screen } from '@testing-library/react'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { NotebookPreviewRenderer } from './NotebookPreview'

const SAMPLE_NOTEBOOK = JSON.stringify({
  nbformat: 4,
  cells: [
    { cell_type: 'markdown', id: 'md-1', source: '# 单细胞分析\n\nQC 流程' },
    {
      cell_type: 'code',
      id: 'code-1',
      execution_count: 1,
      source: ['import scanpy as sc\n', 'print(sc.__version__)'],
      outputs: [{ output_type: 'stream', name: 'stdout', text: '1.12.3\n' }]
    },
    {
      cell_type: 'code',
      id: 'code-2',
      execution_count: null,
      source: 'raise ValueError("boom")',
      outputs: [{ output_type: 'error', ename: 'ValueError', evalue: 'boom' }]
    }
  ]
})

describe('NotebookPreviewRenderer', () => {
  it('renders markdown and code cells with outputs and errors', async () => {
    vi.stubGlobal('window', {
      api: { artifacts: { readPreview: vi.fn(async () => ({ content: SAMPLE_NOTEBOOK })) } }
    })

    render(
      <NotebookPreviewRenderer
        item={
          {
            type: 'file',
            id: 'f1',
            projectId: 'p1',
            sessionId: 's1',
            path: 'analysis.ipynb',
            name: 'analysis.ipynb',
            source: 'artifact',
            format: 'notebook'
          } as PreviewFileItem
        }
      />
    )

    expect(await screen.findByText(/# 单细胞分析/)).toBeTruthy()
    expect(screen.getByText(/import scanpy/)).toBeTruthy()
    expect(await screen.findByText(/1\.12\.3/)).toBeTruthy()
    expect(screen.getByText(/ValueError: boom/)).toBeTruthy()
    expect(screen.getByText('2 个代码单元')).toBeTruthy()
    expect(screen.getByText('1 个 Markdown 单元')).toBeTruthy()
  })
})
