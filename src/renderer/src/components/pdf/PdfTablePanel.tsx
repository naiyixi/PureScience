import { useEffect, useState } from 'react'

import { useLanguage } from '@/i18n'
import { PDF_TABLES_MAX_CANDIDATES, type PdfTableCandidateForAgent } from '../../../../shared/pdf'
import { Button } from '@/components/ui/button'
import { copyText } from '@/lib/copy-text'

// Shows the table candidates the app's own reader finds, through the same channel the agent is given
// (`pdf.tables`): geometry decides the columns from the page's own item positions, and only pages whose
// items carry no position fall back to the text layer. Rendering that shared result rather than deriving
// tables again here is the point — what the panel shows, and the markdown, TSV and HTML it copies, are the
// reader's own output, so the panel and the agent cannot quietly disagree about a table.
//
// Two things this panel must never do: report a clean "no tables" as if the page had none when what it means
// is that the reader found no grid (so it says how many pages it looked at), and imply the list is complete
// when the reader stopped at its candidate cap (so it says that it stopped).

type PdfTablePanelProps = {
  projectId: string
  sourcePath: string
  /** The Session the file came from: without it an Artifact Version locator cannot be resolved. */
  sourceSessionId?: string
  onClose: () => void
}

type ScanState =
  | { status: 'scanning' }
  | { status: 'ready'; candidates: PdfTableCandidateForAgent[]; scannedPages: number }
  | { status: 'failed'; message: string }

const PdfTablePanel = ({
  projectId,
  sourcePath,
  sourceSessionId,
  onClose
}: PdfTablePanelProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [state, setState] = useState<ScanState>({ status: 'scanning' })
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const scan = async (): Promise<void> => {
      const pdf = window.api?.pdf
      if (typeof pdf?.open !== 'function' || typeof pdf?.tables !== 'function') {
        setState({ status: 'failed', message: t('pdf.table.unavailable') })
        return
      }
      try {
        const opened = await pdf.open({
          projectId,
          path: sourcePath,
          ...(sourceSessionId ? { sessionId: sourceSessionId } : {})
        })
        const result = await pdf.tables({ projectId, docId: opened.doc.docId })
        if (!active) return
        setState({
          status: 'ready',
          candidates: result.candidates,
          scannedPages: result.scannedPages
        })
      } catch (error) {
        if (!active) return
        setState({
          status: 'failed',
          message: error instanceof Error ? error.message : t('pdf.table.unavailable')
        })
      }
    }
    void scan()
    return () => {
      active = false
    }
  }, [projectId, sourcePath, sourceSessionId, t])

  const copy = async (id: string, artifact: string): Promise<void> => {
    await copyText(artifact)
    setCopied(id)
  }

  const capped = state.status === 'ready' && state.candidates.length >= PDF_TABLES_MAX_CANDIDATES

  return (
    <div className="flex flex-col gap-3 p-4" data-testid="pdf-table-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('pdf.table.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('pdf.table.exportHint')}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>

      {state.status === 'scanning' ? (
        <p className="text-xs text-muted-foreground">{t('pdf.table.scanning')}</p>
      ) : null}

      {state.status === 'failed' ? (
        <p className="text-xs text-red-600" role="alert">
          {state.message}
        </p>
      ) : null}

      {state.status === 'ready' && state.candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="pdf-table-empty">
          {t('pdf.table.noneFound').replace('{n}', String(state.scannedPages))}
        </p>
      ) : null}

      {capped ? (
        <p className="text-xs text-muted-foreground" data-testid="pdf-table-capped">
          {t('pdf.table.capped').replace('{n}', String(PDF_TABLES_MAX_CANDIDATES))}
        </p>
      ) : null}

      {state.status === 'ready'
        ? state.candidates.map((candidate, index) => {
            const id = `${candidate.page}-${index}`
            return (
              <section
                key={id}
                data-testid="pdf-table-candidate"
                className="rounded-lg border border-border bg-card p-3"
              >
                <header className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {t('pdf.table.pageLabel').replace('{page}', String(candidate.page))}
                  </span>
                  <span data-testid="pdf-table-shape">
                    {t('pdf.table.shape')
                      .replace('{rows}', String(candidate.rows.length))
                      .replace('{columns}', String(candidate.columnCount))}
                  </span>
                  <span>
                    {t('pdf.table.confidenceLabel').replace('{level}', candidate.confidence)}
                  </span>
                  <span>{candidate.method}</span>
                </header>
                <ul className="mt-1 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
                  {candidate.warnings.map((reason) => (
                    <li key={reason} className="rounded bg-muted px-1.5 py-0.5">
                      {reason}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 overflow-x-auto">
                  <table className="text-[12px]">
                    <tbody>
                      {candidate.rows.slice(0, 8).map((row, rowIndex) => (
                        <tr key={rowIndex} data-testid={`pdf-table-row-${rowIndex}`}>
                          {row.map((cell, cellIndex) => (
                            <td key={cellIndex} className="border border-border px-2 py-0.5">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    data-testid={`pdf-table-copy-markdown-${id}`}
                    onClick={() => void copy(`${id}-md`, candidate.markdown)}
                  >
                    {t('pdf.table.copyMarkdown')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    data-testid={`pdf-table-copy-tsv-${id}`}
                    onClick={() => void copy(`${id}-tsv`, candidate.tsv)}
                  >
                    {t('pdf.table.copyTsv')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    data-testid={`pdf-table-copy-html-${id}`}
                    onClick={() => void copy(`${id}-html`, candidate.html)}
                  >
                    {t('pdf.table.copyHtml')}
                  </Button>
                  {copied?.startsWith(id) ? (
                    <span className="text-[11px] text-muted-foreground">
                      {t('pdf.table.copied')}
                    </span>
                  ) : null}
                </div>
              </section>
            )
          })
        : null}
    </div>
  )
}

export { PdfTablePanel }
