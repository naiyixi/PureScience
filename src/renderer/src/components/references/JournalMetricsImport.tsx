import { useCallback, useState } from 'react'

import { useLanguage } from '@/i18n'
import type { TranslationKey } from '@/i18n'
import type {
  JournalMetricImportOutcome,
  JournalMetricImportRequest,
  JournalMetricImportResult,
  JournalMetricRowProblem
} from '../../../../shared/journal-metrics'
import { JOURNAL_METRIC_KINDS, KIND_LABEL_KEYS } from './journal-metric-kind-labels'
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

// Which rule identified the journal a row landed in. The store's outcome has carried this (and whether the
// row was what created the journal) since the import path was written, but the report only printed the
// number — so a reader looking at "line 3 imported" could not tell whether it went to the journal they meant,
// under which spelling, or whether it had quietly started a second identity. The map is keyed off the store's
// own union, so a fourth resolving rule would fail to compile here rather than print a raw token.
type ImportedOutcome = Extract<JournalMetricImportOutcome, { status: 'imported' }>

const MATCH_KEYS: Readonly<Record<ImportedOutcome['journalMatch'], TranslationKey>> = Object.freeze(
  {
    'by-issn': 'references.journalMetrics.import.match.byIssn',
    'by-normalized-name': 'references.journalMetrics.import.match.byNormalizedName',
    'by-alias': 'references.journalMetrics.import.match.byAlias'
  } as Record<ImportedOutcome['journalMatch'], TranslationKey>
)

const buttonClass = 'rounded border border-[var(--border)] px-2 py-1 disabled:opacity-50'

export function JournalMetricsImport({
  journals,
  onImported
}: {
  // The names the library already knows, so each imported row can say WHICH journal it landed in instead of
  // printing an opaque id. A journal the import itself created appears here once the library is re-read; until
  // then the row falls back to the store's own id (never an invented name).
  journals: readonly { id: string; name: string }[]
  // Re-reads the library so the table above shows what the import just stored instead of a local guess.
  onImported: () => void
}): React.JSX.Element {
  const { t } = useLanguage()
  const [text, setText] = useState('')
  const [defaultKind, setDefaultKind] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<JournalMetricImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit: ButtonHTMLAttributes<HTMLButtonElement>['onClick'] = useCallback(() => {
    if (text.trim() === '') return
    setBusy(true)
    setError(null)
    // The store refuses ambiguous input rather than guessing which separator it was given (its own error names
    // the requirement), so the window states it: a tab in the pasted text means TSV, otherwise the
    // comma-separated shape every publisher export here uses.
    const format = text.includes('\t') ? 'tsv' : 'csv'
    // A table that names its kind per row needs nothing here — the parser lets a cell win over this value — so
    // an empty box must send NO `defaultKind` rather than send ''. '' would read as "the caller said nothing",
    // which happens to be right, but the store's own error message for a missing kind column says
    // "kind (or defaultKind)" — a caller that meant "no kind anywhere" should not look like it tried.
    const kind = defaultKind.trim()
    const request: JournalMetricImportRequest =
      kind === '' ? { format, text } : { format, text, defaultKind: kind }
    void window.api.references
      .importJournalMetrics(request)
      .then((next) => {
        setResult(next)
        onImported()
      })
      .catch((reason: unknown) => {
        // An engine failure aborts the import; it is not a per-row outcome and must not be dressed as one.
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => setBusy(false))
  }, [defaultKind, onImported, text])

  const imported = result?.outcomes.filter((outcome) => outcome.status === 'imported') ?? []
  const skipped = result?.outcomes.filter((outcome) => outcome.status === 'skipped') ?? []

  // A row's journal, named from what the library knows. Absent (the library has not been re-read since the
  // import created it) the store's own id is shown rather than a guess — the id is a fact, a name would not be.
  const journalName = (id: string): string =>
    journals.find((journal) => journal.id === id)?.name ?? id

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

      {/* Most publisher exports have no kind column: every row of the file is one metric. The store has always
          accepted that sentence (a request-level `defaultKind`, and a cell with a value still wins), but the
          window never sent it, so a kind-less table could only be imported after someone edited the file to
          add a column. It is a form field now, and the five kinds the library knows by name are suggested —
          an unknown kind is still allowed, because the table's own word is what the store keeps. */}
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {t('references.journalMetrics.import.defaultKind')}
          </span>
          <input
            aria-label={t('references.journalMetrics.import.defaultKind')}
            className="w-56 rounded border border-[var(--border)] bg-transparent px-2 py-1 font-mono text-[11px]"
            data-slot="journal-metrics-import-default-kind"
            list="journal-metric-kind-suggestions"
            onChange={(event) => setDefaultKind(event.target.value)}
            value={defaultKind}
          />
        </label>
        <datalist id="journal-metric-kind-suggestions">
          {JOURNAL_METRIC_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(KIND_LABEL_KEYS[kind])}
            </option>
          ))}
        </datalist>
        <p className="text-[10px] text-[var(--muted-foreground)]">
          {t('references.journalMetrics.import.defaultKindHint')}
        </p>
      </div>

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
                  <span
                    className="block text-[10px]"
                    data-slot="journal-metrics-import-attribution"
                  >
                    {t('references.journalMetrics.import.attribution', {
                      journal: journalName(outcome.journalId),
                      match: t(MATCH_KEYS[outcome.journalMatch])
                    })}
                    {outcome.journalCreated
                      ? ` · ${t('references.journalMetrics.import.created')}`
                      : ''}
                  </span>
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
