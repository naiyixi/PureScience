import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage, type TranslationKey } from '@/i18n'
import { JournalMetricsImport } from './JournalMetricsImport'
import { JournalClaimEditor } from './JournalClaimEditor'
import { JournalAliasRelease, type JournalAliasReleaseOutcome } from './JournalAliasRelease'
import { KIND_LABEL_KEYS } from './journal-metric-kind-labels'
import {
  buildJournalMetricsOverview,
  type JournalMetricLibrary,
  type JournalMetricsFilter,
  type JournalOverviewCounts,
  type JournalOverviewRow
} from '../../../../shared/journal-metrics-overview'
import {
  JOURNAL_MERGE_REFUSAL_LABEL_KEYS,
  isJournalMergeOutcome,
  type JournalAliasUnbindResult,
  type JournalMergeResult
} from '../../../../shared/journal-merge'

// Presentational on purpose: the table takes the view it must draw and nothing else, so the reading that
// matters (a missing metric must say so, and every number must carry its year and source) is testable
// without a bridge, a database or a window.
export function JournalMetricsTable({
  rows,
  kinds,
  counts,
  unknownLabel
}: {
  rows: readonly JournalOverviewRow[]
  kinds: readonly string[]
  counts: JournalOverviewCounts
  unknownLabel: string
}): React.JSX.Element {
  const { t } = useLanguage()

  return (
    <table className="w-full border-collapse text-left text-xs">
      <thead>
        <tr className="text-[var(--muted-foreground)]">
          <th className="py-1 pr-3 font-medium">
            <KindHeader kind="journal" />
          </th>
          <th className="py-1 pr-3 font-medium">ISSN</th>
          {kinds.map((kind) => (
            <th key={kind} className="py-1 pr-3 font-medium">
              <KindHeader kind={kind} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.journalId} className="border-t border-[var(--border)]">
            <td className="py-1 pr-3">
              <span>{row.name}</span>
              {/* The other spellings a merge left behind. Without them a reader would see a number under a
                  name and have no way to know the older name now points here. */}
              {row.aliases.length > 0 ? (
                <span
                  className="ml-1 text-[10px] text-[var(--muted-foreground)]"
                  data-slot="journal-alias"
                >
                  {t('references.journalMetrics.merge.aliases', { names: row.aliases.join(' · ') })}
                </span>
              ) : null}
            </td>
            <td className="py-1 pr-3 text-[var(--muted-foreground)]">{row.issn ?? unknownLabel}</td>
            {kinds.map((kind) => {
              const cell = row.cells[kind]
              if (!cell || cell.state === 'unknown') {
                // A metric nobody imported is NOT a zero: the cell says so in words.
                return (
                  <td key={kind} className="py-1 pr-3 text-[var(--muted-foreground)] italic">
                    {unknownLabel}
                  </td>
                )
              }

              return (
                <td key={kind} className="py-1 pr-3 align-top">
                  <div className="flex items-center gap-1">
                    <span>{cell.value}</span>
                    {/* Every number carries the year and the source it came from, always. */}
                    <span className="text-[10px] text-[var(--muted-foreground)]">
                      ({cell.year} · {cell.source})
                    </span>
                    {cell.alternatives.length > 0 ? (
                      // The same year holds more than one claim. Both facts exist in the library, so both are
                      // printed: silently keeping the newer `fetchedAt` would invent a single truth.
                      <span
                        data-testid="journal-metric-conflict"
                        className="rounded border border-[var(--accent)] px-1 text-[10px] text-[var(--accent)]"
                        title={t('references.journalMetrics.conflictBadgeTitle')}
                      >
                        {t('references.journalMetrics.conflictBadge', {
                          count: cell.alternatives.length
                        })}
                      </span>
                    ) : null}
                  </div>
                  {cell.alternatives.map((alternative) => (
                    <div
                      key={`${alternative.source}\u0000${alternative.value}`}
                      className="text-[10px] text-[var(--muted-foreground)]"
                      data-testid="journal-metric-alternative"
                    >
                      {t('references.journalMetrics.conflictLine', {
                        value: alternative.value,
                        year: cell.year,
                        source: alternative.source
                      })}
                    </div>
                  ))}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t border-[var(--border)] text-[10px] text-[var(--muted-foreground)]">
          <td colSpan={2 + kinds.length} className="py-1">
            <CountsLine counts={counts} />
          </td>
        </tr>
      </tfoot>
    </table>
  )
}

function KindHeader({ kind }: { kind: string }): React.JSX.Element {
  const { t } = useLanguage()
  const key = KIND_LABEL_KEYS[kind]

  return <>{key ? t(key as TranslationKey) : kind}</>
}

function CountsLine({ counts }: { counts: JournalOverviewCounts }): React.JSX.Element {
  const { t } = useLanguage()

  // The four buckets always add up to `total`, so a filter that matches nothing can never be mistaken for an
  // empty library.
  return (
    <>
      {t('references.journalMetrics.counts', {
        matched: counts.matched,
        total: counts.total,
        missing: counts.missingMetric,
        notNumeric: counts.valueNotNumeric,
        notMatching: counts.notMatching
      })}
    </>
  )
}

// The explicit merge (R2-U4): two journals in, one out. There is deliberately no "find similar journals"
// affordance — similarity is not evidence that two names are one journal, and this control is the only place
// a merge can come from.
export function JournalMergeControls({
  journals,
  busy,
  result,
  onMerge
}: {
  journals: readonly { id: string; name: string }[]
  busy: boolean
  result: JournalMergeResult | null
  onMerge: (sourceJournalId: string, targetJournalId: string) => void
}): React.JSX.Element {
  const { t } = useLanguage()
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  // Both sides must still exist as choices: after a merge the journal that was folded away is no longer in
  // the list, and a button that could still send that id would offer a merge that cannot succeed.
  const sourceExists = journals.some((journal) => journal.id === source)
  const targetExists = journals.some((journal) => journal.id === target)
  const canMerge =
    source !== '' && target !== '' && source !== target && sourceExists && targetExists && !busy

  return (
    <div className="flex flex-col gap-2 rounded border border-[var(--border)] p-2 text-xs">
      <div>
        <h4 className="text-xs font-medium">{t('references.journalMetrics.merge.title')}</h4>
        <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
          {t('references.journalMetrics.merge.hint')}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {t('references.journalMetrics.merge.source')}
          </span>
          <select
            aria-label={t('references.journalMetrics.merge.source')}
            className="rounded border border-[var(--border)] bg-transparent px-2 py-1"
            data-slot="journal-merge-source"
            onChange={(event) => setSource(event.target.value)}
            value={source}
          >
            <option value="">{t('references.journalMetrics.merge.choose')}</option>
            {journals.map((journal) => (
              <option key={journal.id} value={journal.id}>
                {journal.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {t('references.journalMetrics.merge.target')}
          </span>
          <select
            aria-label={t('references.journalMetrics.merge.target')}
            className="rounded border border-[var(--border)] bg-transparent px-2 py-1"
            data-slot="journal-merge-target"
            onChange={(event) => setTarget(event.target.value)}
            value={target}
          >
            <option value="">{t('references.journalMetrics.merge.choose')}</option>
            {journals.map((journal) => (
              <option key={journal.id} value={journal.id}>
                {journal.name}
              </option>
            ))}
          </select>
        </label>

        <button
          className="rounded border border-[var(--border)] px-2 py-1 disabled:opacity-50"
          data-slot="journal-merge-confirm"
          disabled={!canMerge}
          onClick={() => onMerge(source, target)}
          type="button"
        >
          {busy
            ? t('references.journalMetrics.merge.merging')
            : t('references.journalMetrics.merge.confirm')}
        </button>
      </div>

      {result === null ? null : isJournalMergeOutcome(result) ? (
        <p className="text-[var(--accent)]" data-slot="journal-merge-result">
          {t('references.journalMetrics.merge.done', {
            metrics: result.movedMetrics,
            references: result.movedReferences,
            alias: result.alias
          })}
        </p>
      ) : (
        <p className="text-[var(--accent)]" data-slot="journal-merge-result">
          {/* The refusal is a judgement, so the window shows the named reason AND the store's own sentence
              (which names the colliding name or the missing id) rather than a generic failure. */}
          {t(JOURNAL_MERGE_REFUSAL_LABEL_KEYS[result.reason] as TranslationKey)} — {result.detail}
        </p>
      )}
    </div>
  )
}

export function JournalMetricsPanel(): React.JSX.Element {
  const { t } = useLanguage()
  const [library, setLibrary] = useState<JournalMetricLibrary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [partition, setPartition] = useState('')
  const [minImpactFactor, setMinImpactFactor] = useState('')
  const [maxImpactFactor, setMaxImpactFactor] = useState('')
  const [year, setYear] = useState('')
  const [merging, setMerging] = useState(false)
  const [mergeResult, setMergeResult] = useState<JournalMergeResult | null>(null)
  const [releasing, setReleasing] = useState(false)
  const [releaseResult, setReleaseResult] = useState<JournalAliasReleaseOutcome | null>(null)
  const alive = useRef(true)

  // One reader for both the mount and the merge: a merge changes the very rows on screen, and re-reading the
  // store is the only way the table can show the result instead of a locally patched guess.
  // The state writes live in the promise callbacks rather than in an async body: a write the mount effect can
  // reach synchronously is reported as a cascading render, and this is the shape the sibling panels read with.
  const readLibrary = useCallback((): Promise<void> => {
    return window.api.references.listJournalMetrics().then(
      (next) => {
        if (!alive.current) return
        setLibrary(next)
        setError(null)
      },
      (loadError: unknown) => {
        if (!alive.current) return
        // Fail loudly: a screening view that silently shows nothing looks like "no journals", not a failure.
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      }
    )
  }, [])

  useEffect(() => {
    alive.current = true
    void readLibrary()

    return () => {
      alive.current = false
    }
  }, [readLibrary])

  const mergeJournals = useCallback(
    (sourceJournalId: string, targetJournalId: string): void => {
      setMerging(true)
      setMergeResult(null)
      window.api.references
        .mergeJournals({ sourceJournalId, targetJournalId })
        .then(async (result) => {
          if (!alive.current) return
          setMergeResult(result)
          // Re-read after a successful merge so the table shows the surviving row; a refusal changed nothing,
          // but re-reading is harmless and keeps one code path.
          await readLibrary()
        })
        .catch((mergeError: unknown) => {
          if (!alive.current) return
          setError(mergeError instanceof Error ? mergeError.message : String(mergeError))
        })
        .finally(() => {
          if (alive.current) setMerging(false)
        })
    },
    [readLibrary]
  )

  // The merge's other half. Same shape as the merge above — one store call, then a re-read, because releasing
  // a name changes the chips the table draws and the only honest source for them is the store.
  const releaseAlias = useCallback(
    (normalizedName: string): void => {
      setReleasing(true)
      setReleaseResult(null)
      window.api.references
        .removeJournalAlias({ normalizedName })
        .then(async (result: JournalAliasUnbindResult) => {
          if (!alive.current) return
          setReleaseResult({ normalizedName, result })
          await readLibrary()
        })
        .catch((releaseError: unknown) => {
          if (!alive.current) return
          setError(releaseError instanceof Error ? releaseError.message : String(releaseError))
        })
        .finally(() => {
          if (alive.current) setReleasing(false)
        })
    },
    [readLibrary]
  )

  const journalCount = library?.journals.length ?? 0
  // The partitions offered are the ones the library actually holds. A fixed list of "一区/二区" would be a
  // vocabulary this code invented, and it would silently filter against values no source uses.
  const partitions = useMemo(() => {
    const values = new Set<string>()
    for (const claim of library?.claims ?? []) {
      if (claim.kind === 'cas-partition' && claim.value.trim() !== '') values.add(claim.value)
    }

    return [...values].sort()
  }, [library])

  const filter: JournalMetricsFilter = useMemo(() => {
    const parsedYear = Number.parseInt(year, 10)
    const parsedMin = Number.parseFloat(minImpactFactor)
    const parsedMax = Number.parseFloat(maxImpactFactor)

    return {
      ...(partition ? { partition } : {}),
      ...(Number.isFinite(parsedMin) ? { minImpactFactor: parsedMin } : {}),
      ...(Number.isFinite(parsedMax) ? { maxImpactFactor: parsedMax } : {}),
      ...(Number.isFinite(parsedYear) ? { year: parsedYear } : {})
    }
  }, [maxImpactFactor, minImpactFactor, partition, year])

  const overview = useMemo(
    () =>
      buildJournalMetricsOverview({
        journals: library?.journals ?? [],
        claims: library?.claims ?? [],
        aliases: library?.aliases ?? [],
        filter
      }),
    [filter, library]
  )

  const mergeChoices = useMemo(
    () =>
      (library?.journals ?? [])
        .map((journal) => ({
          id: journal.id,
          name: journal.displayName?.trim() || journal.normalizedName
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    [library]
  )

  // The alias section names the journal each spelling resolves to, from the same id→name list the merge and
  // the import form already draw on — a second mapping would be a second answer to the same question.
  const journalNames = useMemo(
    () => new Map(mergeChoices.map((journal) => [journal.id, journal.name] as const)),
    [mergeChoices]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
      <div>
        <h3 className="text-sm font-medium">{t('references.journalMetrics.title')}</h3>
        <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
          {t('references.journalMetrics.hint')}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 text-xs" data-testid="journal-metrics-filters">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {t('references.journalMetrics.filter.partition')}
          </span>
          <select
            aria-label={t('references.journalMetrics.filter.partition')}
            className="rounded border border-[var(--border)] bg-transparent px-2 py-1"
            onChange={(event) => setPartition(event.target.value)}
            value={partition}
          >
            <option value="">{t('references.journalMetrics.filter.partitionAny')}</option>
            {partitions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {t('references.journalMetrics.filter.minImpactFactor')}
          </span>
          <input
            aria-label={t('references.journalMetrics.filter.minImpactFactor')}
            className="w-24 rounded border border-[var(--border)] bg-transparent px-2 py-1"
            inputMode="decimal"
            onChange={(event) => setMinImpactFactor(event.target.value)}
            value={minImpactFactor}
          />
        </label>

        {/* The ceiling of the same range. The store's filter has carried both bounds since the screening view
            landed; only the floor was reachable from the window, so a reader could not ask "which journals
            are at most X" — the question a submission shortlist is usually about. */}
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {t('references.journalMetrics.filter.maxImpactFactor')}
          </span>
          <input
            aria-label={t('references.journalMetrics.filter.maxImpactFactor')}
            className="w-24 rounded border border-[var(--border)] bg-transparent px-2 py-1"
            inputMode="decimal"
            onChange={(event) => setMaxImpactFactor(event.target.value)}
            value={maxImpactFactor}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {t('references.journalMetrics.filter.year')}
          </span>
          <input
            aria-label={t('references.journalMetrics.filter.year')}
            className="w-20 rounded border border-[var(--border)] bg-transparent px-2 py-1"
            inputMode="numeric"
            onChange={(event) => setYear(event.target.value)}
            placeholder={t('references.journalMetrics.filter.yearAny')}
            value={year}
          />
        </label>
      </div>

      {/* The import entry lives with the table it fills: before this the command existed with no way to reach
          it from the window (it was registered agent-only), and the reader had to take the counts on trust.
          It is handed the same id→name list the merge controls use, so each imported row can name the journal
          it landed in rather than print an id. */}
      <JournalMetricsImport journals={mergeChoices} onImported={() => void readLibrary()} />

      {error !== null ? (
        <p className="text-xs text-[var(--accent)]">{error}</p>
      ) : library === null ? (
        <p className="text-xs text-[var(--muted-foreground)]">
          {t('references.journalMetrics.loading')}
        </p>
      ) : journalCount === 0 || overview.rows.length === 0 ? (
        <p className="text-xs text-[var(--muted-foreground)]">
          {t('references.journalMetrics.empty')}
        </p>
      ) : null}

      {library !== null && journalCount > 0 ? (
        <JournalMetricsTable
          counts={overview.counts}
          kinds={overview.kinds}
          rows={overview.rows}
          unknownLabel={t('references.journalMetrics.unknown')}
        />
      ) : null}

      {/* IC29: the correction form and the claim history are one section on purpose — a correction is only
          meaningful beside the claims it joins, and the store's doctrine is that it JOINS them (append-only)
          rather than replacing the number the source reported. */}
      {library !== null && mergeChoices.length > 0 ? (
        <JournalClaimEditor
          journals={mergeChoices}
          kinds={overview.kinds}
          onAppended={() => void readLibrary()}
        />
      ) : null}

      {/* Merging needs two journals to choose from; with none or one the control cannot act, so offering it
          would be the empty affordance this project refuses to ship. It DOES stay mounted once a merge has
          produced a result: the report of what moved — and the alias it left behind — is the only place that
          explains the row that just changed, so unmounting it would swallow the answer on success. */}
      {library !== null && (mergeChoices.length > 1 || mergeResult !== null) ? (
        <JournalMergeControls
          busy={merging}
          journals={mergeChoices}
          onMerge={mergeJournals}
          result={mergeResult}
        />
      ) : null}

      {/* The other half of a merge. It mounts on the aliases the library actually holds — not on the merge
          controls' condition — because a name left behind stays releasable even when there is nothing left to
          merge (that is exactly the state a merge leaves the library in). It STAYS mounted after the last
          alias is gone when there is a result to read: the report is the only place that explains the row
          that just changed, so unmounting would swallow the answer on success. */}
      {library !== null && (library.aliases.length > 0 || releaseResult !== null) ? (
        <JournalAliasRelease
          aliases={library.aliases}
          busy={releasing}
          journalNames={journalNames}
          lastResult={releaseResult}
          onRelease={releaseAlias}
        />
      ) : null}
    </div>
  )
}
