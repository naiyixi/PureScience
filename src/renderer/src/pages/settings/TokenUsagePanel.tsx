import { ChartNoAxesCombined, Info } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLanguage, type TranslationKey } from '@/i18n'

import type { PersistedChatSession } from '../../../../shared/session-persistence'
import type { Project } from '../../../../shared/projects'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  buildTokenUsageAnalytics,
  selectTokenUsageSummary,
  tokenUsageMetricValue,
  type TokenUsageDailyPoint,
  type TokenUsageHeatmapMetric,
  type TokenUsagePeriod
} from './token-usage-analytics'

// Hallmark · macrostructure: Stat-Led · theme: application-native · tone: technical / utilitarian
// Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 · contrast: pass (40–41) · slop: pass

type TokenUsagePanelProps = {
  sessions: readonly PersistedChatSession[]
  projects: readonly Project[]
  now?: number
}

const PERIODS: ReadonlyArray<{ value: TokenUsagePeriod; label: TranslationKey; shortLabel: TranslationKey }> = [
  { value: 'today', label: 'settings.usageToday', shortLabel: 'settings.usageToday' },
  { value: 'week', label: 'settings.usageThisWeek', shortLabel: 'settings.usageWeek' },
  { value: '30-days', label: 'settings.usageLast30Days', shortLabel: 'settings.usage30Days' },
  { value: 'all', label: 'settings.usageAllTime', shortLabel: 'settings.usageAll' }
]

const HEATMAP_METRICS: ReadonlyArray<{
  value: TokenUsageHeatmapMetric
  label: TranslationKey
}> = [
  { value: 'totalTokens', label: 'settings.totalTokens' },
  { value: 'inputTokens', label: 'settings.inputTokens' },
  { value: 'outputTokens', label: 'settings.outputTokens' },
  { value: 'cacheTokens', label: 'settings.cacheTokens' },
  { value: 'newConversations', label: 'settings.newSessions' },
  { value: 'newProjects', label: 'settings.newProjects' },
  { value: 'newArtifacts', label: 'settings.newArtifacts' },
  { value: 'runs', label: 'settings.runs' }
]

const HEATMAP_INTENSITY_CLASSES = [
  'border-border bg-muted/35',
  'border-primary/15 bg-primary/15',
  'border-primary/25 bg-primary/30',
  'border-primary/35 bg-primary/45',
  'border-primary/45 bg-primary/65',
  'border-primary/55 bg-primary/90'
] as const

const heatmapIntensity = (value: number, maximum: number): number => {
  if (value <= 0 || maximum <= 0) return 0
  return Math.min(5, Math.max(1, Math.ceil((value / maximum) * 5)))
}

const tokenScaleMaximum = (maximum: number): number => {
  if (!Number.isFinite(maximum) || maximum <= 0) return 0
  const magnitude = 10 ** Math.floor(Math.log10(maximum))
  return Math.ceil(maximum / magnitude) * magnitude
}

const metricLabel = (metric: TokenUsageHeatmapMetric): TranslationKey =>
  HEATMAP_METRICS.find((candidate) => candidate.value === metric)?.label ?? 'settings.totalTokens'

function TokenUsagePanel({
  sessions,
  projects,
  now: providedNow
}: TokenUsagePanelProps): React.JSX.Element {
  const { t, lang } = useLanguage()
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const now = providedNow ?? currentTime
  const [period, setPeriod] = useState<TokenUsagePeriod>('30-days')
  const [heatmapMetric, setHeatmapMetric] = useState<TokenUsageHeatmapMetric>('totalTokens')

  useEffect(() => {
    if (providedNow !== undefined) return

    let timeoutId: number
    const scheduleNextLocalDay = (): void => {
      const timestamp = Date.now()
      const nextDay = new Date(timestamp)
      nextDay.setHours(24, 0, 0, 0)
      timeoutId = window.setTimeout(
        () => {
          setCurrentTime(Date.now())
          scheduleNextLocalDay()
        },
        Math.max(1_000, nextDay.getTime() - timestamp + 1_000)
      )
    }

    scheduleNextLocalDay()
    return () => window.clearTimeout(timeoutId)
  }, [providedNow])

  const analytics = useMemo(
    () => buildTokenUsageAnalytics(sessions, now, projects),
    [sessions, now, projects]
  )
  const summary = useMemo(() => selectTokenUsageSummary(analytics, period), [analytics, period])
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }),
    [lang]
  )
  const percentFormatter = useMemo(
    () => new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 1 }),
    [lang]
  )
  const compactNumberFormatter = useMemo(
    () => new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }),
    [lang]
  )
  const shortDateFormatter = useMemo(
    () => new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric' }),
    [lang]
  )
  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    [lang]
  )
  const fullDateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(lang, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      }),
    [lang]
  )

  const formatNumber = (value: number): string => numberFormatter.format(value)
  const formatTokenAxisValue = (value: number): string => {
    const units = [
      { threshold: 1_000_000_000, suffix: 'B' },
      { threshold: 1_000_000, suffix: 'M' },
      { threshold: 1_000, suffix: 'k' }
    ] as const
    const unit = units.find((candidate) => value >= candidate.threshold)
    return unit
      ? `${compactNumberFormatter.format(value / unit.threshold)}${unit.suffix}`
      : compactNumberFormatter.format(value)
  }
  const heatmapMaximum = Math.max(
    0,
    ...analytics.last30Days.map((point) => tokenUsageMetricValue(point, heatmapMetric))
  )
  const tokenMaximum = Math.max(0, ...analytics.last30Days.map((point) => point.totalTokens))
  const chartScaleMaximum = tokenScaleMaximum(tokenMaximum)
  const last30DaysTotal = analytics.last30Days.reduce(
    (total, point) => total + point.totalTokens,
    0
  )
  const tokenSummaryItems: ReadonlyArray<{
    label: TranslationKey
    value: string
    featured?: boolean
    detailLabel?: TranslationKey
    detailValue?: string
  }> = [
    { label: 'settings.totalTokens', value: formatNumber(summary.totalTokens), featured: true },
    { label: 'settings.inputTokens', value: formatNumber(summary.inputTokens) },
    {
      label: 'settings.cacheTokens',
      value: formatNumber(summary.cacheTokens),
      detailLabel: 'settings.cacheShare',
      detailValue: summary.cacheShare === null ? '—' : percentFormatter.format(summary.cacheShare)
    },
    { label: 'settings.outputTokens', value: formatNumber(summary.outputTokens) }
  ]
  const entitySummaryItems: ReadonlyArray<{
    newLabel?: TranslationKey
    newValue?: string
    totalLabel: TranslationKey
    totalValue: string
  }> = [
    {
      newLabel: 'settings.newSessions',
      newValue: formatNumber(summary.newConversations),
      totalLabel: 'settings.totalSessions',
      totalValue: formatNumber(summary.totalSessions)
    },
    {
      newLabel: 'settings.newProjects',
      newValue: formatNumber(summary.newProjects),
      totalLabel: 'settings.totalProjects',
      totalValue: formatNumber(summary.totalProjects)
    },
    {
      newLabel: 'settings.newRuns',
      newValue: formatNumber(summary.newRuns),
      totalLabel: 'settings.totalRuns',
      totalValue: formatNumber(summary.totalRuns)
    },
    {
      newLabel: 'settings.newArtifacts',
      newValue: formatNumber(summary.newArtifacts),
      totalLabel: 'settings.totalArtifacts',
      totalValue: formatNumber(summary.totalArtifacts)
    }
  ]

  const heatmapCellLabel = (point: TokenUsageDailyPoint): string =>
    t('settings.usageHeatmapTooltip')
      .replace('{date}', fullDateFormatter.format(point.dayStart))
      .replace('{value}', formatNumber(tokenUsageMetricValue(point, heatmapMetric)))
      .replace('{metric}', t(metricLabel(heatmapMetric)).toLocaleLowerCase(lang))

  const stackedBarLabel = (point: TokenUsageDailyPoint): string =>
    t('settings.usageStackTooltip')
      .replace('{date}', fullDateFormatter.format(point.dayStart))
      .replace('{input}', formatNumber(point.inputTokens))
      .replace('{cache}', formatNumber(point.cacheTokens))
      .replace('{output}', formatNumber(point.outputTokens))

  return (
    <TooltipProvider delayDuration={200}>
      <div data-slot="token-usage-panel" className="min-w-0 overflow-x-clip">
        <section className="flex flex-col gap-5 px-4 pb-5 pt-6 sm:px-5">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="min-w-0 max-w-xl">
              <h1 className="min-w-0 text-xl font-semibold tracking-tight text-foreground [overflow-wrap:anywhere]">
                {t('settings.tokenUsage')}
              </h1>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                {t('settings.tokenUsageDesc')}
              </p>
            </div>
            <div
              role="group"
              aria-label={t('settings.timeRange')}
              className="grid w-full grid-cols-4 gap-1 rounded-lg bg-muted p-1 sm:w-auto"
            >
              {PERIODS.map((item) => (
                <Button
                  key={item.value}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t(item.label)}
                  aria-pressed={period === item.value}
                  className={cn(
                    'h-9 min-w-0 whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground',
                    period === item.value &&
                      'bg-card text-foreground shadow-sm hover:bg-card hover:text-foreground'
                  )}
                  onClick={() => setPeriod(item.value)}
                >
                  <span className="sm:hidden">{t(item.shortLabel)}</span>
                  <span className="hidden sm:inline">{t(item.label)}</span>
                </Button>
              ))}
            </div>
          </div>

          <div data-slot="token-usage-summary" className="border-y border-border py-5">
            <div className="grid grid-cols-2 gap-x-5 gap-y-5 sm:grid-cols-4">
              {tokenSummaryItems.map((item) => (
                <div key={item.label} className="min-w-0">
                  <p
                    data-stat-label={item.label}
                    className="truncate text-xs font-medium text-muted-foreground"
                  >
                    {t(item.label)}
                  </p>
                  <p
                    className={cn(
                      'mt-1 truncate font-semibold tabular-nums text-foreground',
                      item.featured ? 'text-2xl tracking-tight sm:text-3xl' : 'text-xl'
                    )}
                    title={item.value}
                  >
                    {item.value}
                  </p>
                  {item.detailLabel && item.detailValue ? (
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {t(item.detailLabel)}{' '}
                      <span className="font-medium tabular-nums text-foreground">
                        {item.detailValue}
                      </span>
                    </p>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-5 sm:grid-cols-4">
              {entitySummaryItems.map((item) => (
                <div key={item.totalLabel} className="grid min-w-0 gap-5">
                  {item.newLabel && item.newValue ? (
                    <div className="min-h-14 min-w-0">
                      <p
                        data-stat-label={item.newLabel}
                        className="truncate text-xs font-medium text-muted-foreground"
                      >
                        {t(item.newLabel)}
                      </p>
                      <p
                        className="mt-1 truncate text-xl font-semibold tabular-nums text-foreground"
                        title={item.newValue}
                      >
                        {item.newValue}
                      </p>
                    </div>
                  ) : null}
                  <div className="min-h-14 min-w-0">
                    <p
                      data-stat-label={item.totalLabel}
                      className="truncate text-xs font-medium text-muted-foreground"
                    >
                      {t(item.totalLabel)}
                    </p>
                    <p
                      className="mt-1 truncate text-xl font-semibold tabular-nums text-foreground"
                      title={item.totalValue}
                    >
                      {item.totalValue}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {summary.newRuns > summary.reportedRuns ? (
            <div
              role="status"
              data-slot="token-usage-coverage"
              className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"
            >
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <p>
                {t('settings.tokenTotalsAvailable')
                  .replace('{reported}', String(summary.reportedRuns))
                  .replace('{count}', String(summary.newRuns))}{' '}
                {t('settings.usageMayBeUnreported')}
              </p>
            </div>
          ) : null}
        </section>

        <section
          aria-labelledby="token-activity-title"
          className="border-b border-border px-4 py-6 sm:px-5"
        >
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-end">
            <div className="min-w-0">
              <h2 id="token-activity-title" className="text-base font-semibold text-foreground">
                {t('settings.dailyActivity')}
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                {t('settings.dailyActivityDesc')}
              </p>
            </div>
            <Select
              value={heatmapMetric}
              onValueChange={(value) => setHeatmapMetric(value as TokenUsageHeatmapMetric)}
            >
              <SelectTrigger aria-label={t('settings.dailyActivityMetric')} className="h-9">
                {t(metricLabel(heatmapMetric))}
              </SelectTrigger>
              <SelectContent>
                {HEATMAP_METRICS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {t(item.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="mt-6 min-w-0">
            <div
              role="group"
              aria-label={t('settings.dailyActivityAria')}
              className="grid grid-cols-[repeat(15,minmax(0,1fr))] gap-1.5 sm:grid-cols-[repeat(30,minmax(0,1fr))]"
            >
              {analytics.last30Days.map((point) => {
                const value = tokenUsageMetricValue(point, heatmapMetric)
                const intensity = heatmapIntensity(value, heatmapMaximum)
                return (
                  <Tooltip key={point.dateKey}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={heatmapCellLabel(point)}
                        className={cn(
                          'aspect-square w-full justify-self-center rounded-[3px] border outline-none transition-[background-color,border-color] duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card active:translate-y-px motion-reduce:active:translate-y-0 disabled:pointer-events-none disabled:opacity-50 sm:max-w-10 sm:rounded-md',
                          HEATMAP_INTENSITY_CLASSES[intensity]
                        )}
                      >
                        <span className="sr-only">{heatmapCellLabel(point)}</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{heatmapCellLabel(point)}</TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
            <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
              <span>{t('settings.less')}</span>
              {HEATMAP_INTENSITY_CLASSES.map((className, index) => (
                <span
                  key={className}
                  aria-hidden="true"
                  className={cn('size-2.5 rounded-[3px] border', className)}
                  data-intensity={index}
                />
              ))}
              <span>{t('settings.more')}</span>
            </div>
          </div>
        </section>

        <section aria-labelledby="daily-token-usage-title" className="min-w-0 px-4 py-6 sm:px-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 id="daily-token-usage-title" className="text-base font-semibold text-foreground">
                {t('settings.dailyTokenUsage')}
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {t('settings.dailyTokenUsageDesc')}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
              {[
                ['bg-chart-1', 'settings.inputTokensShort'],
                ['bg-chart-2', 'settings.cacheTokensShort'],
                ['bg-chart-3', 'settings.outputTokensShort']
              ].map(([className, label]) => (
                <span key={label} className="inline-flex items-center gap-1.5">
                  <span className={cn('size-2.5 rounded-[3px]', className)} aria-hidden="true" />
                  {t(label as TranslationKey)}
                </span>
              ))}
            </div>
          </div>

          {tokenMaximum === 0 ? (
            <div className="mt-5 flex items-center gap-2 border-y border-dashed border-border py-4 text-sm text-muted-foreground">
              <ChartNoAxesCombined className="size-4 shrink-0" aria-hidden="true" />
              <p>
                {sessions.length === 0
                  ? t('settings.startConversationForUsage')
                  : t('settings.noUsageReported')}
              </p>
            </div>
          ) : null}

          <div className="mt-5 min-w-0 pb-2" data-slot="token-usage-bars">
            <div
              data-slot="token-usage-30-day-total"
              className="mb-3 flex items-baseline gap-2 text-sm"
            >
              <span className="font-medium text-foreground">{t('settings.totalTokens')}</span>
              <span className="tabular-nums text-muted-foreground">
                {formatNumber(last30DaysTotal)}
              </span>
            </div>
            <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3">
              <div
                data-slot="token-usage-axis"
                aria-hidden="true"
                className="grid h-40 min-w-8 grid-rows-[auto_1fr_auto] text-right text-[10px] tabular-nums text-muted-foreground"
              >
                <span className="-translate-y-1/2">{formatTokenAxisValue(chartScaleMaximum)}</span>
                <span className="self-center">{formatTokenAxisValue(chartScaleMaximum / 2)}</span>
                <span className="translate-y-1/2">0</span>
              </div>
              <div className="relative h-40 min-w-0">
                {[0, 50, 100].map((percentage) => (
                  <span
                    key={percentage}
                    aria-hidden="true"
                    className="absolute inset-x-0 border-t border-border"
                    style={{ bottom: `${percentage}%` }}
                  />
                ))}
                <div
                  role="group"
                  aria-label={t('settings.stackedUsageAria')}
                  className="relative z-10 grid h-full grid-cols-[repeat(30,minmax(0,1fr))] items-end gap-1"
                >
                  {analytics.last30Days.map((point) => {
                    const totalHeight =
                      chartScaleMaximum === 0
                        ? 0
                        : Math.max(1.5, (point.totalTokens / chartScaleMaximum) * 100)
                    const inputHeight =
                      point.totalTokens === 0 ? 0 : (point.inputTokens / point.totalTokens) * 100
                    const cacheHeight =
                      point.totalTokens === 0 ? 0 : (point.cacheTokens / point.totalTokens) * 100
                    const outputHeight =
                      point.totalTokens === 0 ? 0 : (point.outputTokens / point.totalTokens) * 100

                    return (
                      <div key={point.dateKey} className="flex min-w-0 flex-col items-center">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label={stackedBarLabel(point)}
                              className="group flex h-40 w-full min-w-0 items-end justify-center rounded-md outline-none transition-[background-color,box-shadow] duration-150 hover:bg-muted hover:shadow-sm focus-visible:bg-muted focus-visible:shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card active:bg-muted motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50"
                            >
                              {point.totalTokens === 0 ? (
                                <span className="mb-px h-px w-4 bg-border" aria-hidden="true" />
                              ) : (
                                <span
                                  className="flex w-[clamp(0.25rem,55%,0.75rem)] flex-col-reverse overflow-hidden rounded-t-sm bg-muted"
                                  style={{ height: `${totalHeight}%` }}
                                  aria-hidden="true"
                                >
                                  <span
                                    className="w-full bg-chart-1"
                                    style={{ height: `${inputHeight}%` }}
                                  />
                                  <span
                                    className="w-full bg-chart-2"
                                    style={{ height: `${cacheHeight}%` }}
                                  />
                                  <span
                                    className="w-full bg-chart-3"
                                    style={{ height: `${outputHeight}%` }}
                                  />
                                </span>
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent
                            side="top"
                            sideOffset={10}
                            collisionPadding={16}
                            className="w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg"
                          >
                            <div className="flex items-baseline justify-between gap-5">
                              <span className="font-semibold tabular-nums">{point.dateKey}</span>
                              <span className="font-semibold tabular-nums">
                                {formatNumber(point.totalTokens)}
                              </span>
                            </div>
                            <div className="mt-3 grid gap-2">
                              {[
                                {
                                  label: 'settings.inputCached',
                                  value: point.cacheTokens,
                                  className: 'bg-chart-2'
                                },
                                {
                                  label: 'settings.inputUncached',
                                  value: point.inputTokens,
                                  className: 'bg-chart-1'
                                },
                                {
                                  label: 'settings.outputTokensShort',
                                  value: point.outputTokens,
                                  className: 'bg-chart-3'
                                }
                              ].map((row) => (
                                <div
                                  key={row.label}
                                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5"
                                >
                                  <span
                                    className={cn('size-2.5 rounded-[3px]', row.className)}
                                    aria-hidden="true"
                                  />
                                  <span className="min-w-0 text-muted-foreground">
                                    {t(row.label as TranslationKey)}
                                  </span>
                                  <span className="tabular-nums text-foreground">
                                    {formatNumber(row.value)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    )
                  })}
                </div>
              </div>
              <span aria-hidden="true" />
              <div
                aria-hidden="true"
                className="mt-2 grid grid-cols-5 text-[10px] tabular-nums text-muted-foreground"
              >
                {[0, 7, 14, 21, 29].map((index) => (
                  <span
                    key={analytics.last30Days[index].dateKey}
                    className={cn(
                      index === 0 && 'text-left',
                      index > 0 && index < 29 && 'text-center',
                      index === 29 && 'text-right'
                    )}
                  >
                    {shortDateFormatter.format(analytics.last30Days[index].dayStart)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section aria-labelledby="per-run-usage-title" className="min-w-0 border-t border-border px-4 py-6 sm:px-5">
          <div className="flex flex-col gap-1">
            <h2 id="per-run-usage-title" className="text-base font-semibold text-foreground">
              {t('settings.perRunUsage')}
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              {t('settings.perRunUsageDesc')}
            </p>
          </div>
          {analytics.runs.length === 0 ? (
            <div className="mt-4 text-sm text-muted-foreground">{t('settings.noUsageReported')}</div>
          ) : (
            <div className="mt-4 min-w-0 overflow-x-auto" data-slot="per-run-usage-list">
              <table className="w-full min-w-[480px] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">{t('settings.perRunColumnTime')}</th>
                    <th className="pb-2 pr-3 font-medium">{t('settings.perRunColumnRun')}</th>
                    <th className="pb-2 pr-3 text-right font-medium">{t('settings.perRunColumnTokens')}</th>
                    <th className="pb-2 pr-3 text-right font-medium">{t('settings.perRunColumnSubRuns')}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...analytics.runs].reverse().slice(0, 20).map((run) => (
                    <tr key={run.frameId} className="border-b border-border/50 last:border-b-0">
                      <td className="py-2 pr-3 tabular-nums text-muted-foreground">
                        {timeFormatter.format(run.startedAt)}
                      </td>
                      <td className="py-2 pr-3 text-foreground">
                        {run.kind === 'root'
                          ? t('settings.perRunRootRun')
                          : `${run.agentName ?? run.kind}`}
                        {run.subRunCount > 0 ? (
                          <span className="ml-1 text-muted-foreground">
                            ({t('settings.perRunIncludingSubRuns')})
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-foreground">
                        {formatNumber(run.totalTokens + run.subRunTokens)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                        {run.subRunCount > 0 ? run.subRunCount : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </TooltipProvider>
  )
}

export { TokenUsagePanel }
