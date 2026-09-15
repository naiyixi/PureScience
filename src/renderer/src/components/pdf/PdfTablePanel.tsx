import { useEffect, useState } from 'react'

import { useLanguage } from '@/i18n'
import {
  auditPdfTableCandidateForUse,
  extractPdfTableCandidatesFromText,
  toHtmlTable,
  toMarkdownTable,
  toTsv,
  type PdfTableCandidate
} from '../../../../shared/pdf-table-extraction'
import { Button } from '@/components/ui/button'

// Reads table CANDIDATES out of a PDF's text layer and offers them as exports that carry their own
// provenance. Everything here is derived from text the app already has (`pdf.pages`); no model decides
// what a table is, and nothing claims a candidate is a transcription of the page.
//
// The one thing this panel must never do is report a clean "no tables" as if the page had none: an empty
// result means nothing in the text layer looked like a grid, and the panel says which pages it looked at.
const MAX_SCANNED_PAGES = 200

type PdfTablePanelProps = {
  projectId: string
  sourcePath: string
  onClose: () => void
}

type ScanState =
  | { status: 'scanning' }
  | { status: 'ready'; candidates: PdfTableCandidate[]; scannedPages: number; truncated: boolean }
  | { status: 'failed'; message: string }

const PdfTablePanel = ({
  projectId,
  sourcePath,
  onClose
}: PdfTablePanelProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [state, setState] = useState<ScanState>({ status: 'scanning' })
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const scan = async (): Promise<void> => {
      const pdf = window.api?.pdf
      if (typeof pdf?.open !== 'function' || typeof pdf?.pages !== 'function') {
        setState({ status: 'failed', message: t('pdf.table.unavailable') })
        return
      }
      try {
        const opened = await pdf.open({ projectId, path: sourcePath })
        const end = Math.min(opened.doc.pageCount, MAX_SCANNED_PAGES)
        const read = await pdf.pages({ projectId, docId: opened.doc.docId, start: 1, end })
        if (!active) return
        const candidates = read.pages.flatMap((page) =>
          extractPdfTableCandidatesFromText(page.page, page.text)
        )
        setState({
          status: 'ready',
          candidates,
          scannedPages: read.pages.length,
          truncated: opened.doc.pageCount > end
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
  }, [projectId, sourcePath, t])

  const copy = async (id: string, artifact: string): Promise<void> => {
    await navigator.clipboard.writeText(artifact)
    setCopied(id)
  }

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
        <p className="text-xs text-muted-foreground">
          {t('pdf.table.noneFound').replace('{n}', String(state.scannedPages))}
          {state.truncated ? ` ${t('pdf.table.truncated')}` : ''}
        </p>
      ) : null}

      {state.status === 'ready'
        ? state.candidates.map((candidate, index) => {
            const id = `${candidate.page}-${index}`
            const reasons = auditPdfTableCandidateForUse(candidate)
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
                  <span>
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
                  {reasons.map((reason) => (
                    <li key={reason} className="rounded bg-muted px-1.5 py-0.5">
                      {reason}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 overflow-x-auto">
                  <table className="text-[12px]">
                    <tbody>
                      {candidate.rows.slice(0, 8).map((row, rowIndex) => (
                        <tr key={rowIndex}>
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
                    onClick={() => void copy(`${id}-md`, toMarkdownTable(candidate))}
                  >
                    {t('pdf.table.copyMarkdown')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    data-testid={`pdf-table-copy-tsv-${id}`}
                    onClick={() => void copy(`${id}-tsv`, toTsv(candidate))}
                  >
                    {t('pdf.table.copyTsv')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    data-testid={`pdf-table-copy-html-${id}`}
                    onClick={() => void copy(`${id}-html`, toHtmlTable(candidate))}
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

export { PdfTablePanel, MAX_SCANNED_PAGES }
