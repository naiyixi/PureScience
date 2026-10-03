import { useCallback, useState } from 'react'

import { useLanguage } from '@/i18n'
import type { TranslationKey } from '@/i18n'
import type {
  JournalMetricImportResult,
  JournalMetricRowProblem
} from '../../../../shared/journal-metrics'
import type { ButtonHTMLAttributes } from 'react'

// Import entry for the journal metric library. Before this the surface existed only as an application
// command (`references.importJournalMetrics`) and was registered in entry-layer-archived-surfaces.ts as
// agent-only — a capability you could not reach from the window. The window now calls it, and the register
// entry was removed in the same change, so the entry-coverage guard keeps meaning what it says.
//
// Two things the panel must not do: hide a refused row (every row gets an outcome, with the store's named
// reason AND its own sentence), and claim success more loudly than the store did (`imported` / `skipped` /
// `journalsCreated` are the store's own counts, printed as they came back).

// The store names nine ways a row can be refused. Each gets a label; the sentence that says WHICH name or
// WHICH column is wrong stays the store's own text, because inventing a second vocabulary for it would let
// the two drift.
const REASON_LABEL_KEYS: Readonly<Record<JournalMetricRowProblem, TranslationKey>> = Object.freeze({
  'malformed-row': 'references.journalMetrics.import.reason.malformedRow',
  'no-kind': 'references.journalMetrics.import.reason.noKind',
  'no-value': 'references.journalMetrics.import.reason.noValue',
  'no-year': 'references.journalMetrics.import.reason.noYear',
  'no-source': 'references.journalMetrics.import.reason.noSource',
  'bad-issn': 'references.journalMetrics.import.reason.badIssn',
  'name-missing': 'references.journalMetrics.import.reason.nameMissing',
  'name-ambiguous': 'references.journalMetrics.import.reason.nameAmbiguous',
  duplicate: 'references.journalMetrics.import.reason.duplicate'
} as Record<JournalMetricRowProblem, TranslationKey>)

const buttonClass = 'rounded border border-[var(--border)] px-2 py-1 disabled:opacity-50'

export function JournalMetricsImport({
  onImported
}: {
  // Re-reads the library so the table above shows what the import just stored instead of a local guess.
  onImported: () => void
}): React.JSX.Element {
  const { t } = useLanguage()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<JournalMetricImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit: ButtonHTMLAttributes<HTMLButtonElement>['onClick'] = useCallback(() => {
    if (text.trim() === '') return
    setBusy(true)
    setError(null)
    void window.api.references
      .importJournalMetrics({ text })
      .then((next) => {
        setResult(next)
        onImported()
      })
      .catch((reason: unknown) => {
        // An engine failure aborts the import; it is not a per-row outcome and must not be dressed as one.
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => setBusy(false))
  }, [onImported, text])

  const imported = result?.outcomes.filter((outcome) => outcome.status === 'imported') ?? []
  const skipped = result?.outcomes.filter((outcome) => outcome.status === 'skipped') ?? []

  return (
    <div className="flex flex-col gap-2 rounded border border-[var(--border)] p-2">
      <div>
        <p className="text-xs font-medium">{t('references.journalMetrics.import.title')}</p>
        <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">
          {t('references.journalMetrics.import.hint')}
        </p>
      </div>

      <textarea
        aria-label={t('references.journalMetrics.import.title')}
        className="h-20 w-full rounded border border-[var(--border)] bg-transparent px-2 py-1 font-mono text-[11px]"
        data-slot="journal-metrics-import-text"
        onChange={(event) => setText(event.target.value)}
        placeholder={t('references.journalMetrics.import.placeholder')}
        value={text}
      />

      <div className="flex items-center gap-2">
        <button
          className={buttonClass}
          data-slot="journal-metrics-import-submit"
          disabled={busy || text.trim() === ''}
          onClick={submit}
          type="button"
        >
          {busy
            ? t('references.journalMetrics.import.busy')
            : t('references.journalMetrics.import.submit')}
        </button>
      </div>

      {error === null ? null : (
        <p className="text-[11px] text-[var(--accent)]" data-slot="journal-metrics-import-error">
          {error}
        </p>
      )}

      {result === null ? null : (
        <>
          <p className="text-[11px]" data-slot="journal-metrics-import-summary">
            {t('references.journalMetrics.import.summary', {
              imported: result.imported,
              skipped: result.skipped,
              journals: result.journalsCreated
            })}
          </p>
          {imported.length === 0 ? null : (
            <ul className="flex flex-col gap-0.5 text-[11px] text-[var(--muted-foreground)]">
              {imported.map((outcome) => (
                <li data-slot="journal-metrics-import-imported" key={`ok-${outcome.index}`}>
                  {t('references.journalMetrics.import.importedLine', {
                    line: outcome.line ?? outcome.index + 1,
                    kind: outcome.kind,
                    value: outcome.value,
                    year: outcome.year
                  })}
                </li>
              ))}
            </ul>
          )}
          {skipped.length === 0 ? null : (
            <ul className="flex flex-col gap-0.5 text-[11px] text-[var(--accent)]">
              {skipped.map((outcome) => (
                <li data-slot="journal-metrics-import-skipped" key={`skip-${outcome.index}`}>
                  {t('references.journalMetrics.import.skippedLine', {
                    line: outcome.line ?? outcome.index + 1,
                    reason: t(REASON_LABEL_KEYS[outcome.reason])
                  })}
                  {outcome.detail ? ` — ${outcome.detail}` : ''}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
