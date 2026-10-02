import { useEffect, useMemo, useState } from 'react'

import { useLanguage, type TranslationKey } from '@/i18n'
import {
  buildJournalMetricsOverview,
  type JournalMetricLibrary,
  type JournalMetricsFilter,
  type JournalOverviewCounts,
  type JournalOverviewRow
} from '../../../../shared/journal-metrics-overview'

// The five kinds the library knows by name get a label; any other kind keeps the store's own word, because
// inventing a translation for a kind nobody defined is how a vocabulary drifts.
const KIND_LABEL_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'impact-factor': 'references.journalMetrics.kind.impactFactor',
  'jcr-quartile': 'references.journalMetrics.kind.jcrQuartile',
  'cas-partition': 'references.journalMetrics.kind.casPartition',
  'cas-top': 'references.journalMetrics.kind.casTop',
  'acceptance-rate': 'references.journalMetrics.kind.acceptanceRate'
})

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
            <td className="py-1 pr-3">{row.name}</td>
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
                <td key={kind} className="py-1 pr-3">
                  <span>{cell.value}</span>
                  {/* Every number carries the year and the source it came from, always. */}
                  <span className="ml-1 text-[10px] text-[var(--muted-foreground)]">
                    ({cell.year} · {cell.source})
                  </span>
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

export function JournalMetricsPanel(): React.JSX.Element {
  const { t } = useLanguage()
  const [library, setLibrary] = useState<JournalMetricLibrary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [partition, setPartition] = useState('')
  const [minImpactFactor, setMinImpactFactor] = useState('')
  const [year, setYear] = useState('')

  // Mount reads the whole library once. Stated as a promise chain rather than an awaited helper call so the
  // effect body itself never sets state — the same shape the screening panel and the library dialog use —
  // and so a read that lands after unmount cannot write into a dead component.
  useEffect(() => {
    let alive = true
    window.api.references
      .listJournalMetrics()
      .then((next) => {
        if (!alive) return
        setLibrary(next)
        setError(null)
      })
      .catch((loadError: unknown) => {
        if (!alive) return
        // Fail loudly: a screening view that silently shows nothing looks like "no journals", not a failure.
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })

    return () => {
      alive = false
    }
  }, [])

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

    return {
      ...(partition ? { partition } : {}),
      ...(Number.isFinite(parsedMin) ? { minImpactFactor: parsedMin } : {}),
      ...(Number.isFinite(parsedYear) ? { year: parsedYear } : {})
    }
  }, [minImpactFactor, partition, year])

  const overview = useMemo(
    () =>
      buildJournalMetricsOverview({
        journals: library?.journals ?? [],
        claims: library?.claims ?? [],
        filter
      }),
    [filter, library]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
      <div>
        <h3 className="text-sm font-medium">{t('references.journalMetrics.title')}</h3>
        <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
          {t('references.journalMetrics.hint')}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 text-xs">
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
    </div>
  )
}
