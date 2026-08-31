import { useMemo } from 'react'
import { FileCode2, FileText, TerminalSquare } from 'lucide-react'

import { useLanguage } from '@/i18n'

import type { PreviewFileRendererProps } from '../preview-types'
import { usePreviewFileContent } from '../usePreviewFileContent'

// Minimal nbformat reader: renders Jupyter-style notebooks (.ipynb) as a readable cell stream
// (markdown cells, code cells with their outputs/errors). Outputs are rendered as text — rich
// output (plots/HTML) is intentionally not embedded to keep the preview safe and light; the raw
// JSON view remains available in the file list.
type NotebookCell =
  | { cell_type: 'markdown'; source: string | string[]; id?: string }
  | {
      cell_type: 'code'
      source: string | string[]
      outputs?: Array<{
        output_type?: string
        text?: string | string[]
        name?: string
        ename?: string
        evalue?: string
        data?: Record<string, unknown>
      }>
      execution_count?: number | null
      id?: string
    }

const joinSource = (source: string | string[] | undefined): string =>
  Array.isArray(source) ? source.join('') : (source ?? '')

const outputText = (
  output: NonNullable<Extract<NotebookCell, { cell_type: 'code' }>['outputs']>[number]
): string => {
  if (output.output_type === 'error') {
    return `${output.ename ?? 'Error'}: ${output.evalue ?? ''}`
  }
  if (Array.isArray(output.text)) return output.text.join('')
  if (typeof output.text === 'string') return output.text
  if (output.data && typeof output.data['text/plain'] !== 'undefined') {
    const plain = output.data['text/plain']
    return Array.isArray(plain) ? plain.join('') : String(plain)
  }
  return ''
}

export const NotebookPreviewRenderer = ({ item }: PreviewFileRendererProps): React.JSX.Element => {
  const { t } = useLanguage()
  const load = usePreviewFileContent({
    projectId: item.projectId,
    sessionId: item.sessionId,
    path: item.path,
    source: item.source,
    maxBytes: 1_000_000
  })

  const notebook = useMemo<{
    cells: NotebookCell[]
    error?: string
  }>(() => {
    if (load.status !== 'ready') return { cells: [] }
    try {
      const parsed = JSON.parse(load.preview.content) as {
        nbformat?: number
        cells?: NotebookCell[]
      }
      if (!Array.isArray(parsed.cells)) {
        return { cells: [], error: 'Not a Jupyter notebook (missing cells array)' }
      }
      return { cells: parsed.cells }
    } catch (error) {
      return { cells: [], error: error instanceof Error ? error.message : String(error) }
    }
  }, [load.status, load.status === 'ready' ? load.preview.content : ''])

  if (load.status === 'loading') {
    return <div className="p-6 text-sm text-muted-foreground">{t('common.loading')}</div>
  }
  if (load.status === 'error' || notebook.error) {
    return (
      <div className="p-6 text-sm text-destructive">
        {load.status === 'error' ? String(load.error) : notebook.error}
      </div>
    )
  }

  const codeCells = notebook.cells.filter((cell) => cell.cell_type === 'code').length
  const markdownCells = notebook.cells.filter((cell) => cell.cell_type === 'markdown').length

  return (
    <div className="flex h-full flex-col" data-testid="notebook-preview">
      <div className="flex items-center gap-4 border-b px-4 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <FileCode2 className="size-3.5" />
          {codeCells} 个代码单元
        </span>
        <span className="flex items-center gap-1.5">
          <FileText className="size-3.5" />
          {markdownCells} 个 Markdown 单元
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {notebook.cells.map((cell, index) => {
            const key = cell.id ?? `${index}`
            if (cell.cell_type === 'markdown') {
              return (
                <div key={key} className="rounded-lg border border-border-200 bg-bg-000 px-4 py-3">
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-text-300">
                    Markdown
                  </div>
                  <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-text-100">
                    {joinSource(cell.source)}
                  </div>
                </div>
              )
            }
            const outputs = cell.outputs ?? []
            const renderedOutputs = outputs.map(outputText).filter(Boolean)
            return (
              <div
                key={key}
                className="overflow-hidden rounded-lg border border-border-200 bg-bg-000"
              >
                <div className="flex items-center gap-2 border-b bg-bg-100 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-text-300">
                  <TerminalSquare className="size-3" />
                  Cell {index + 1}
                  {typeof cell.execution_count === 'number' ? ` · [${cell.execution_count}]` : ''}
                </div>
                <pre className="overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed text-text-100">
                  {joinSource(cell.source)}
                </pre>
                {renderedOutputs.length > 0 ? (
                  <div className="border-t bg-bg-100/60">
                    {renderedOutputs.map((output, outputIndex) => (
                      <pre
                        key={outputIndex}
                        className={`overflow-x-auto px-4 py-2 font-mono text-[12px] leading-relaxed ${
                          output.startsWith('Error') || output.startsWith('Traceback')
                            ? 'text-destructive'
                            : 'text-text-200'
                        }`}
                      >
                        {output}
                      </pre>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
