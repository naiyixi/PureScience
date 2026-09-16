import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useLanguage } from '@/i18n'

// Importing the references a PDF cites. The panel is deliberately a receipt, not a wizard: it reads the
// document once, shows what came of it, and never asks the reader to confirm metadata they cannot see.
// Failures are listed with the identifier they belong to — a PDF that cites a paper the public APIs do
// not know must say so, not quietly import four of five and look complete.
type ReferenceImportOutcome =
  | { doi: string; status: 'created'; referenceId: string }
  | { doi: string; status: 'duplicate'; referenceId: string }
  | { doi: string; status: 'failed'; reason: string }

type ReferenceImportResult = {
  outcomes: readonly ReferenceImportOutcome[]
  created: number
  duplicates: number
  failed: number
  truncated: number
}

type ReferenceImportPanelProps = {
  projectId: string
  sourcePath: string
  onClose: () => void
}

type PanelState =
  | { status: 'running' }
  | { status: 'done'; result: ReferenceImportResult }
  | { status: 'error'; message: string }

const ReferenceImportPanel = ({
  projectId,
  sourcePath,
  onClose
}: ReferenceImportPanelProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [state, setState] = useState<PanelState>({ status: 'running' })
  // Decided while rendering rather than from the effect: whether this shell has the surface at all is a
  // property of the shell, not something the effect discovers.
  const importDois = window.api?.references?.importDoisFromPdf

  useEffect(() => {
    let cancelled = false
    if (typeof importDois !== 'function') return
    void importDois(projectId, sourcePath)
      .then((result) => {
        if (!cancelled) setState({ status: 'done', result })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
    return () => {
      cancelled = true
    }
    // `importDois` is read once per mount on purpose: re-running the import when React re-creates the
    // callback identity would import the same document twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sourcePath])

  const unavailable = typeof importDois !== 'function'

  const failures =
    state.status === 'done' ? state.result.outcomes.filter((o) => o.status === 'failed') : []

  return (
    <section
      data-testid="reference-import-panel"
      aria-label={t('references.importFromPdf.title')}
      className="space-y-2 p-3 text-xs"
    >
      <header className="flex items-center gap-2">
        <span className="text-sm font-medium">{t('references.importFromPdf.title')}</span>
        <Button type="button" variant="outline" size="sm" className="ms-auto" onClick={onClose}>
          {t('references.importFromPdf.close')}
        </Button>
      </header>

      {state.status === 'running' ? (
        <p role="status" className="text-muted-foreground">
          {t('references.importFromPdf.running')}
        </p>
      ) : null}

      {unavailable ? (
        <p role="alert" className="text-muted-foreground">
          {t('references.importFromPdf.unavailable')}
        </p>
      ) : null}

      {!unavailable && state.status === 'error' ? (
        <p role="alert" className="text-destructive">
          {t('references.importFromPdf.failed')}：{state.message}
        </p>
      ) : null}

      {state.status === 'done' ? (
        <>
          {state.result.created + state.result.duplicates + state.result.failed === 0 ? (
            <p role="status" className="text-muted-foreground">
              {t('references.importFromPdf.empty')}
            </p>
          ) : (
            <p role="status" data-testid="reference-import-summary" className="text-foreground">
              {t('references.importFromPdf.summary')
                .replace('{created}', String(state.result.created))
                .replace('{duplicates}', String(state.result.duplicates))
                .replace('{failed}', String(state.result.failed))}
            </p>
          )}
          {state.result.truncated > 0 ? (
            <p data-testid="reference-import-truncated" className="text-muted-foreground">
              {t('references.importFromPdf.truncated').replace(
                '{count}',
                String(state.result.truncated)
              )}
            </p>
          ) : null}
          {failures.length > 0 ? (
            <ul
              data-testid="reference-import-failures"
              className="space-y-0.5 text-muted-foreground"
            >
              {failures.map((outcome) => (
                <li key={outcome.doi}>
                  {t('references.importFromPdf.failedItem')
                    .replace('{doi}', outcome.doi)
                    .replace('{reason}', outcome.status === 'failed' ? outcome.reason : '')}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

export { ReferenceImportPanel }
export type { ReferenceImportPanelProps, ReferenceImportResult }
