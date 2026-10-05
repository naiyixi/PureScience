import { useCallback, useEffect, useState } from 'react'

import { useLanguage } from '@/i18n'

type JournalChoice = { id: string; name: string }
type Claim = { kind: string; value: string; year: number; source: string; fetchedAt: number }

// IC29: hand-correcting a metric, and reading every claim made about one journal. The store is append-only by
// doctrine — a correction is a NEW row, because an UPDATE would erase what the source originally said — but
// nothing in the window could write one, nor read a journal's claims back. Form and history are deliberately
// one section: a correction is only meaningful beside the claims it joins.
const JournalClaimEditor = ({
  journals,
  kinds,
  onAppended
}: {
  journals: readonly JournalChoice[]
  kinds: readonly string[]
  onAppended: () => void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const [journalId, setJournalId] = useState(journals[0]?.id ?? '')
  const [kind, setKind] = useState(kinds[0] ?? '')
  const [value, setValue] = useState('')
  const [year, setYear] = useState('')
  const [source, setSource] = useState('')
  const [note, setNote] = useState('')
  const [claims, setClaims] = useState<Claim[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const readClaims = useCallback(async (): Promise<void> => {
    if (!journalId) return
    try {
      setClaims(await window.api.references.listJournalClaims(journalId))
      setError(null)
    } catch (readError) {
      setClaims([])
      setError(readError instanceof Error ? readError.message : String(readError))
    }
  }, [journalId])

  // The initial read lives in the effect with its own liveness guard (the same shape the panel's library read
  // uses): a late answer from a previously chosen journal must not land in the list.
  useEffect(() => {
    if (!journalId) return
    let alive = true
    void window.api.references
      .listJournalClaims(journalId)
      .then((rows) => {
        if (alive) {
          setClaims(rows)
          setError(null)
        }
      })
      .catch((readError: unknown) => {
        if (alive) {
          setClaims([])
          setError(readError instanceof Error ? readError.message : String(readError))
        }
      })
    return () => {
      alive = false
    }
  }, [journalId])

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      // The repository refuses an undated or unsourced number outright, so a refusal here is a real answer —
      // it is shown, never swallowed.
      await window.api.references.appendJournalMetric({
        journalId,
        kind,
        value,
        year: Number.parseInt(year, 10),
        source,
        note
      })
      setValue('')
      setNote('')
      await readClaims()
      onAppended()
    } catch (appendError) {
      setError(appendError instanceof Error ? appendError.message : String(appendError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="border-t border-[var(--border)] pt-3" data-testid="journal-claim-editor">
      <p className="text-xs font-medium text-[var(--foreground)]">
        {t('references.journalMetrics.correct.title')}
      </p>
      <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)] [text-wrap:pretty]">
        {t('references.journalMetrics.correct.hint')}
      </p>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {t('references.journalMetrics.correct.journal')}
          </span>
          <select
            aria-label={t('references.journalMetrics.correct.journal')}
            className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
            onChange={(event) => setJournalId(event.target.value)}
            value={journalId}
          >
            {journals.map((journal) => (
              <option key={journal.id} value={journal.id}>
                {journal.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {t('references.journalMetrics.correct.kind')}
          </span>
          <select
            aria-label={t('references.journalMetrics.correct.kind')}
            className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
            onChange={(event) => setKind(event.target.value)}
            value={kind}
          >
            {kinds.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {t('references.journalMetrics.correct.value')}
          </span>
          <input
            aria-label={t('references.journalMetrics.correct.value')}
            className="w-24 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
            onChange={(event) => setValue(event.target.value)}
            value={value}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {t('references.journalMetrics.correct.year')}
          </span>
          <input
            aria-label={t('references.journalMetrics.correct.year')}
            className="w-20 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
            inputMode="numeric"
            onChange={(event) => setYear(event.target.value)}
            value={year}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {t('references.journalMetrics.correct.source')}
          </span>
          <input
            aria-label={t('references.journalMetrics.correct.source')}
            className="w-40 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
            onChange={(event) => setSource(event.target.value)}
            value={source}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {t('references.journalMetrics.correct.note')}
          </span>
          <input
            aria-label={t('references.journalMetrics.correct.note')}
            className="w-40 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs"
            onChange={(event) => setNote(event.target.value)}
            value={note}
          />
        </label>

        <button
          type="button"
          className="rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--foreground)] disabled:opacity-50"
          disabled={busy || journalId === '' || value.trim() === '' || source.trim() === ''}
          onClick={() => void submit()}
        >
          {t('references.journalMetrics.correct.submit')}
        </button>
      </div>

      {error !== null ? <p className="mt-2 text-xs text-[var(--accent)]">{error}</p> : null}

      <p className="mt-3 text-[11px] font-medium text-[var(--muted-foreground)]">
        {t('references.journalMetrics.correct.history')}
      </p>
      {claims.length === 0 ? (
        <p className="text-[11px] text-[var(--muted-foreground)]">
          {t('references.journalMetrics.correct.historyEmpty')}
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-0.5" data-testid="journal-claim-history">
          {claims.map((claim) => (
            <li
              key={`${claim.kind}-${claim.year}-${claim.source}-${claim.value}`}
              className="text-[11px] text-[var(--muted-foreground)]"
            >
              <span className="text-[var(--foreground)]">{claim.kind}</span>
              {' · '}
              {claim.value}
              {' · '}
              {claim.year}
              {' · '}
              {claim.source}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export { JournalClaimEditor }
