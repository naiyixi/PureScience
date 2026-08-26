import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import type { ChatMessage, ChatSession } from '@/stores/session-store'
import {
  Activity,
  AlertCircle,
  Bot,
  Brain,
  CheckCircle2,
  CircleStop,
  Scissors,
  X,
  type LucideIcon
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLanguage, type TranslationKey } from '@/i18n'

import type {
  AcpContextUsage,
  AcpContextUsageCategory,
  AcpContextUsageCategoryKey,
  AcpContextWindowSampleSource,
  AcpPromptStopReason
} from '../../../../shared/acp'
import {
  selectContextWindowTrendPoints,
  type ContextWindowTrendPoint
} from './context-window-trend'
import { resolveSessionProviderId } from './error-report'

type ContextWindowDialogProps = {
  open: boolean
  session: ChatSession | undefined
  contextUsage?: AcpContextUsage
  onOpenChange: (open: boolean) => void
}

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

const formatTokens = (tokens: number): string => {
  const absolute = Math.abs(tokens)
  if (absolute >= 1_000_000) {
    const value = tokens / 1_000_000
    return `${numberFormat.format(value)}M`
  }
  if (absolute >= 1_000) {
    const value = tokens / 1_000
    return `${numberFormat.format(value)}K`
  }
  return numberFormat.format(tokens)
}

const formatDateTime = (timestamp: number): string =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(timestamp)

// Per-call usage insights (open-science #1718): every agent message with reported token usage
// becomes one stacked input/cache/output bar, newest first, so a turn's context-window share is
// visible at a glance. Uses the persisted turn-level usage the ACP adapters already report.
type UsageCallRecord = Readonly<{
  id: string
  createdAt: number
  inputTokens: number
  cacheTokens: number
  outputTokens: number
  turnCount?: number
}>

const selectUsageCallRecords = (messages: ChatMessage[] | undefined): UsageCallRecord[] => {
  if (!messages) return []
  const records: UsageCallRecord[] = []
  for (const message of messages) {
    if (message.role !== 'agent' || !message.turnUsage) continue
    const { inputTokens, cacheTokens, outputTokens, turnCount } = message.turnUsage
    if (inputTokens <= 0 && cacheTokens <= 0 && outputTokens <= 0) continue
    records.push({
      id: message.id,
      createdAt: message.createdAt,
      inputTokens,
      cacheTokens,
      outputTokens,
      turnCount
    })
  }
  return records.sort((a, b) => b.createdAt - a.createdAt)
}

const UsageCallsSection = ({
  messages
}: {
  messages: ChatMessage[] | undefined
}): React.JSX.Element | null => {
  const { t } = useLanguage()
  const records = useMemo(() => selectUsageCallRecords(messages), [messages])
  if (records.length === 0) return null

  const maxTotal = Math.max(
    ...records.map(
      (record) => record.inputTokens + record.cacheTokens + record.outputTokens
    ),
    1
  )

  return (
    <section className="space-y-3" data-slot="context-window-calls">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t('ws.contextCallsTitle')}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('ws.contextCallsHint')}</p>
      </div>
      <div className="space-y-2">
        {records.slice(0, 50).map((record) => {
          const total = record.inputTokens + record.cacheTokens + record.outputTokens
          return (
            <div key={record.id} className="group/call">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-muted-foreground">{formatDateTime(record.createdAt)}</span>
                <span className="text-foreground">
                  {formatTokens(total)} tokens
                  {record.turnCount ? ` · ${record.turnCount} model turn${record.turnCount === 1 ? '' : 's'}` : ''}
                </span>
              </div>
              <div className="mt-1 flex h-3 w-full overflow-hidden rounded-full bg-bg-200">
                <div
                  className="h-full bg-amber-400"
                  style={{ width: `${(record.inputTokens / maxTotal) * 100}%` }}
                  title={`Input ${formatTokens(record.inputTokens)}`}
                />
                <div
                  className="h-full bg-cyan-400"
                  style={{ width: `${(record.cacheTokens / maxTotal) * 100}%` }}
                  title={`Cache ${formatTokens(record.cacheTokens)}`}
                />
                <div
                  className="h-full bg-emerald-500"
                  style={{ width: `${(record.outputTokens / maxTotal) * 100}%` }}
                  title={`Output ${formatTokens(record.outputTokens)}`}
                />
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// Catalog keys stay unresolved at module scope so changing locale updates every render site.
const categoryPresentation: Record<AcpContextUsageCategoryKey, { labelKey: TranslationKey; color: string }> = {
  system: { labelKey: 'ws.contextCategorySystem', color: 'bg-emerald-500' },
  tools: { labelKey: 'ws.contextCategoryTools', color: 'bg-amber-400' },
  messages: { labelKey: 'ws.contextCategoryMessages', color: 'bg-violet-500' },
  mcp: { labelKey: 'ws.contextCategoryMcp', color: 'bg-cyan-400' },
  skills: { labelKey: 'ws.contextCategorySkills', color: 'bg-blue-500' },
  other: { labelKey: 'ws.contextCategoryOther', color: 'bg-slate-400' }
}

const visibleCategories = (usage: AcpContextUsage): AcpContextUsageCategory[] =>
  usage.breakdown?.categories.filter((category) => category.tokens > 0) ?? []

const signedTokens = (tokens: number): string => `${tokens > 0 ? '+' : ''}${formatTokens(tokens)}`

// Catalog keys, not resolved copy. `satisfies` makes an source-added reason a compile failure.
const stopReasonLabel = {
  end_turn: 'ws.contextStopEndTurn',
  max_tokens: 'ws.contextStopMaxTokens',
  max_turn_requests: 'ws.contextStopTurnLimit',
  refusal: 'ws.contextStopRefused',
  cancelled: 'ws.contextStopInterrupted'
} satisfies Record<AcpPromptStopReason, TranslationKey>

type PointPresentation = Readonly<{
  labelKey: TranslationKey
  code: string
  color: string
  ring: string
  icon: LucideIcon
}>

const pointState = (point: ContextWindowTrendPoint): PointPresentation => {
  const termination = point.sample.termination
  if (termination.kind === 'error') {
    return {
      labelKey: 'ws.contextStateError',
      code: 'error',
      color: 'text-danger-000',
      ring: 'ring-danger-000',
      icon: AlertCircle
    }
  }
  const interrupted = termination.stopReason === 'cancelled'
  return {
    labelKey: stopReasonLabel[termination.stopReason],
    code: termination.stopReason,
    color: interrupted ? 'text-warning-900' : 'text-muted-foreground',
    ring: interrupted ? 'ring-warning-900' : 'ring-transparent',
    icon: interrupted ? CircleStop : CheckCircle2
  }
}

const sourceLabel: Record<AcpContextWindowSampleSource, TranslationKey> = {
  'provider-response': 'ws.contextSourceResponse',
  'provider-update': 'ws.contextSourceUpdate',
  'local-estimate': 'ws.contextSourceEstimate'
}

const CompositionStrip = ({ usage }: { usage: AcpContextUsage }): React.JSX.Element => {
  const { t } = useLanguage()
  const categories = visibleCategories(usage)
  const categoryTotal = categories.reduce((sum, category) => sum + category.tokens, 0)
  const visualTotal = Math.max(usage.used, categoryTotal)
  const occupancy = usage.size ? Math.min(100, (visualTotal / usage.size) * 100) : 100

  return (
    <div
      className="flex h-3 overflow-hidden rounded-full bg-muted"
      data-slot="context-composition-strip"
      aria-label={
        usage.size
          ? t('ws.contextStripAriaWithSize').replace('{used}', formatTokens(visualTotal)).replace('{size}', formatTokens(usage.size))
          : t('ws.contextStripAria').replace('{used}', formatTokens(visualTotal))
      }
    >
      {categories.map((category) => (
        <span
          key={category.key}
          className={cn(
            'h-full border-r border-background/80 last:border-r-0',
            categoryPresentation[category.key].color
          )}
          style={{ width: `${categoryTotal ? (category.tokens / categoryTotal) * occupancy : 0}%` }}
          title={`${t(categoryPresentation[category.key].labelKey)}: ${formatTokens(category.tokens)}`}
        />
      ))}
    </div>
  )
}

const CategoryLegend = ({
  usage,
  singleRow = false
}: {
  usage: AcpContextUsage
  singleRow?: boolean
}): React.JSX.Element => {
  const { t } = useLanguage()
  const categories = visibleCategories(usage)
  const categoryTotal = categories.reduce((sum, category) => sum + category.tokens, 0)

  return (
    <div
      className={cn(
        'grid min-w-0 gap-x-5 gap-y-1.5',
        singleRow ? 'grid-flow-col auto-cols-fr' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
      )}
      data-slot="context-category-legend"
    >
      {categories.map((category) => (
        <div
          key={category.key}
          className="flex min-w-0 items-center justify-between gap-3 text-[11px]"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'size-2.5 shrink-0 rounded-[2px]',
                categoryPresentation[category.key].color
              )}
              aria-hidden="true"
            />
            <span className="truncate text-foreground">
              {t(categoryPresentation[category.key].labelKey)}
            </span>
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {category.estimated ? '~' : ''}
            {formatTokens(category.tokens)}{' '}
            {categoryTotal ? `${Math.round((category.tokens / categoryTotal) * 100)}%` : '0%'}
          </span>
        </div>
      ))}
    </div>
  )
}

const BreakdownDiagnostics = ({ usage }: { usage: AcpContextUsage }): React.JSX.Element | null => {
  const { t } = useLanguage()
  const breakdown = usage.breakdown
  if (!breakdown) return null

  return (
    <div className="text-[11px] leading-4 text-muted-foreground" data-slot="context-diagnostics">
      {breakdown.status === 'reconciled' ? (
        <span className="tabular-nums">
          {t('ws.contextDiagnosticsReconciled')
            .replace('{local}', formatTokens(breakdown.estimatedTokens))
            .replace('{agent}', formatTokens(usage.used))
            .replace('{difference}', signedTokens(breakdown.difference))}
        </span>
      ) : usage.agentUsed !== undefined ? (
        <span className="tabular-nums">
          {t('ws.contextDiagnosticsPending')
            .replace('{local}', formatTokens(breakdown.estimatedTokens))
            .replace('{agent}', formatTokens(usage.agentUsed))}
        </span>
      ) : (
        <span>{t('ws.contextDiagnosticsGenerating')}</span>
      )}
    </div>
  )
}

const CurrentComposition = ({
  usage,
  model
}: {
  usage: AcpContextUsage
  model?: string
}): React.JSX.Element => {
  const { t } = useLanguage()
  const categories = visibleCategories(usage)
  const percent = usage.size ? Math.round((usage.used / usage.size) * 100) : undefined

  return (
    <section
      aria-labelledby="current-composition-title"
      className="rounded-lg border border-border bg-card p-4"
      data-slot="current-composition"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 id="current-composition-title" className="text-sm font-medium text-foreground">
          {t('ws.contextCurrentComposition')}
        </h3>
        {model ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{model}</span>
        ) : null}
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-semibold tabular-nums text-foreground">
          {formatTokens(usage.used)}
        </span>
        <span className="text-sm tabular-nums text-muted-foreground">
          {usage.size
            ? t('ws.contextOfSize').replace('{size}', formatTokens(usage.size))
            : t('ws.contextTokens')}
          {percent === undefined ? '' : ` (${percent}%)`}
        </span>
      </div>
      <div className="mt-3">
        <CompositionStrip usage={usage} />
      </div>
      {categories.length ? (
        <div className="mt-3">
          <CategoryLegend usage={usage} singleRow />
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('ws.contextBreakdownUnavailable')}
        </p>
      )}
      <div className="mt-2">
        <BreakdownDiagnostics usage={usage} />
      </div>
    </section>
  )
}

const PointDetails = ({ point }: { point: ContextWindowTrendPoint }): React.JSX.Element => {
  const { t } = useLanguage()
  const frameworks = useSettingsStore((state) => state.agentFrameworks)
  const providers = useSettingsStore((state) => state.providers)
  const state = pointState(point)
  const StateIcon = state.icon
  const framework = frameworks.find((candidate) => candidate.id === point.runtime?.frameworkId)
  const providerId = resolveSessionProviderId(point.runtime?.backendId)
  const provider = providers.find((candidate) => candidate.id === providerId)
  const frameworkLabel = framework?.displayName ?? point.runtime?.frameworkId
  const providerLabel = provider?.name ?? point.runtime?.backendId
  const usage = point.sample.contextWindow
  const categories = visibleCategories(usage)

  return (
    <section
      className="min-w-0 rounded-lg border border-border bg-card p-4 text-xs"
      data-slot="context-window-point-details"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-foreground" data-slot="context-window-point-title">
            {t('ws.contextRunTitle')
              .replace('{runNumber}', String(point.runNumber))
              .replace('{messageNumber}', String(point.messageNumber))}
          </h3>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={point.prompt}>
            {point.prompt || t('ws.contextEmptyPrompt')}
          </div>
        </div>
        <span className={cn('flex shrink-0 items-center gap-1 text-[11px]', state.color)}>
          <StateIcon className="size-3.5" aria-hidden="true" />
          {t(state.labelKey)}
        </span>
      </div>

      <div className="mt-3 grid min-w-0 gap-4 border-y border-border py-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(15rem,0.65fr)]">
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-muted-foreground">{t('ws.contextWindowUsed')}</span>
            <span className="font-medium tabular-nums text-foreground">
              {formatTokens(usage.used)}
              {usage.size ? (
                <span className="font-normal text-muted-foreground">
                  {' '}
                  / {formatTokens(usage.size)}
                </span>
              ) : null}
            </span>
          </div>
          <div className="mt-2">
            <CompositionStrip usage={usage} />
          </div>
          {categories.length ? (
            <div className="mt-3">
              <CategoryLegend usage={usage} />
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t('ws.contextBreakdownUnavailableRun')}
            </p>
          )}
          <div
            className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 sm:flex-nowrap"
            data-slot="context-diagnostics-row"
          >
            <BreakdownDiagnostics usage={usage} />
          </div>
        </div>

        <div className="min-w-0 space-y-1 text-[11px] leading-4 text-muted-foreground">
          {frameworkLabel || point.agentName ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <Bot className="size-3 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="truncate">
                {t('ws.contextAgent')} {point.agentName ?? frameworkLabel}
                {point.agentName && frameworkLabel ? ` · ${frameworkLabel}` : ''}
              </span>
            </div>
          ) : null}
          {point.runtime?.model || providerLabel ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <Brain className="size-3 shrink-0" strokeWidth={2} aria-hidden="true" />
              <span className="truncate" title={point.runtime?.model}>
                {t('ws.contextModel')} {point.runtime?.model ?? t('ws.contextUnknown')}
                {providerLabel ? ` · ${providerLabel}` : ''}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3 pt-1 text-[10px]">
            <span>{t(sourceLabel[point.sample.source])}</span>
            <span className="shrink-0 tabular-nums">{formatDateTime(point.sample.timestamp)}</span>
          </div>
        </div>
      </div>
      <div className="sr-only">
        {t('ws.contextTerminalStateCode')} {state.code}
      </div>
    </section>
  )
}

const ContextHistoryChart = ({
  points,
  activeIndex,
  pinnedIndex,
  onPreview,
  onSelect
}: {
  points: ContextWindowTrendPoint[]
  activeIndex: number
  pinnedIndex: number
  onPreview: (index: number | undefined) => void
  onSelect: (index: number) => void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const maximum = Math.max(
    1,
    ...points.flatMap((point) => [
      point.sample.contextWindow.used,
      point.sample.contextWindow.size ?? 0
    ])
  )
  const chartWidth = Math.max(560, points.length * 38 + 16)

  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollLeft = scroller.scrollWidth
  }, [points.length])

  return (
    <div className="flex min-w-0" data-slot="context-window-trend-chart">
      <div
        className="flex h-60 w-12 shrink-0 flex-col justify-between border-r border-border py-2 pr-2 text-right text-[10px] tabular-nums text-muted-foreground"
        aria-hidden="true"
      >
        <span>{formatTokens(maximum)}</span>
        <span>{formatTokens(maximum / 2)}</span>
        <span>0</span>
      </div>
      <div ref={scrollerRef} className="min-w-0 flex-1 overflow-x-auto pb-1">
        <div
          className="relative h-60 min-w-full"
          style={{ width: `${chartWidth}px` }}
          role="group"
          aria-label={t('ws.contextChartAria').replace('{count}', String(points.length))}
        >
          <div
            className="pointer-events-none absolute inset-x-0 inset-y-2 flex flex-col justify-between"
            aria-hidden="true"
          >
            <span className="border-t border-border" />
            <span className="border-t border-border" />
            <span className="border-t border-border" />
          </div>
          <div className="absolute inset-0 flex items-end justify-start gap-0.5 px-2">
            {points.map((point, index) => {
              const usage = point.sample.contextWindow
              const categories = visibleCategories(usage)
              const categoryTotal = categories.reduce((sum, category) => sum + category.tokens, 0)
              const state = pointState(point)
              const isActive = activeIndex === index
              const isPinned = pinnedIndex === index
              return (
                <div
                  key={point.sample.id}
                  className="relative flex h-full w-9 shrink-0 items-end justify-center pb-7 pt-2"
                >
                  <button
                    type="button"
                    data-slot="context-window-point"
                    data-active={isActive ? 'true' : undefined}
                    aria-pressed={isPinned}
                    aria-label={t('ws.contextPointAria')
                      .replace('{run}', String(point.runNumber))
                      .replace('{state}', t(state.labelKey))
                      .replace('{tokens}', formatTokens(usage.used))}
                    onPointerEnter={() => onPreview(index)}
                    onPointerLeave={() => onPreview(undefined)}
                    onFocus={() => onPreview(index)}
                    onBlur={() => onPreview(undefined)}
                    onClick={() => onSelect(index)}
                    className={cn(
                      'group relative flex h-full w-9 items-end justify-center rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'
                    )}
                  >
                    {usage.size ? (
                      <span
                        className="pointer-events-none absolute inset-x-1 border-t border-dashed border-success-000"
                        style={{ bottom: `${Math.min(100, (usage.size / maximum) * 100)}%` }}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span
                      className={cn(
                        'relative flex min-h-0 w-8 flex-col-reverse overflow-hidden rounded-t-[2px] bg-primary ring-2 transition-shadow duration-150 motion-reduce:transition-none group-hover:ring-ring/40 group-focus-visible:ring-ring/60',
                        state.ring,
                        isActive && 'ring-ring/60',
                        isPinned && 'ring-foreground'
                      )}
                      data-slot="context-window-bar"
                      style={{ height: `${Math.max(2, (usage.used / maximum) * 100)}%` }}
                      aria-hidden="true"
                    >
                      {categories.map((category) => (
                        <span
                          key={category.key}
                          className={cn('w-full', categoryPresentation[category.key].color)}
                          style={{
                            height: `${categoryTotal ? (category.tokens / categoryTotal) * 100 : 0}%`
                          }}
                        />
                      ))}
                    </span>
                  </button>
                  <span className="pointer-events-none absolute inset-x-0 bottom-1 text-center text-[10px] tabular-nums text-muted-foreground">
                    {point.runNumber}
                  </span>
                  {point.compactedAfter ? (
                    <span
                      className="absolute -right-2.5 bottom-1 z-10 grid size-5 place-items-center rounded-full border border-border bg-background text-muted-foreground"
                      data-slot="context-window-compaction-marker"
                      role="img"
                      title={t('ws.contextCompactedAfter').replace('{run}', String(point.runNumber))}
                      aria-label={t('ws.contextCompactedAfter').replace('{run}', String(point.runNumber))}
                    >
                      <Scissors className="size-3" aria-hidden="true" />
                    </span>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

const ContextHistory = ({ points }: { points: ContextWindowTrendPoint[] }): React.JSX.Element => {
  const { t } = useLanguage()
  const [pinnedSampleId, setPinnedSampleId] = useState<string>()
  const [previewIndex, setPreviewIndex] = useState<number>()
  const selectedIndex = pinnedSampleId
    ? points.findIndex((point) => point.sample.id === pinnedSampleId)
    : -1
  const pinnedIndex = selectedIndex >= 0 ? selectedIndex : points.length - 1
  const activeIndex = previewIndex ?? pinnedIndex
  const activePoint = points[activeIndex] ?? points.at(-1)

  return (
    <section aria-labelledby="context-window-history-title" data-slot="context-window-history">
      <div className="flex flex-wrap items-end justify-between gap-3 pb-3">
        <div className="min-w-0">
          <h3 id="context-window-history-title" className="text-sm font-medium text-foreground">
            {t('ws.contextHistory')}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('ws.contextHistoryHint')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="h-2.5 w-4 rounded-[2px] bg-primary" aria-hidden="true" />
            {t('ws.contextWindowUsed')}
          </span>
          {points.some((point) => point.sample.contextWindow.size) ? (
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="w-4 border-t border-dashed border-success-000" aria-hidden="true" />
              {t('ws.contextCapacity')}
            </span>
          ) : null}
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <ContextHistoryChart
          points={points}
          activeIndex={activeIndex}
          pinnedIndex={pinnedIndex}
          onPreview={setPreviewIndex}
          onSelect={(index) =>
            setPinnedSampleId((current) =>
              current === points[index]?.sample.id || index === points.length - 1
                ? undefined
                : points[index]?.sample.id
            )
          }
        />
      </div>
      <div className="mt-4">{activePoint ? <PointDetails point={activePoint} /> : null}</div>
    </section>
  )
}

const ContextWindowDialog = ({
  open,
  session,
  contextUsage,
  onOpenChange
}: ContextWindowDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const messages = session?.messages
  const activities = session?.activities
  const conversationGraph = session?.conversationGraph
  const points = useMemo(
    () =>
      messages === undefined
        ? []
        : selectContextWindowTrendPoints({ activities, conversationGraph, messages }),
    [activities, conversationGraph, messages]
  )
  const latestPoint = points.at(-1)
  const currentUsage = contextUsage ?? latestPoint?.sample.contextWindow
  const contentRef = useRef<HTMLDivElement>(null)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          ref={contentRef}
          data-slot="context-window-dialog"
          aria-describedby="context-window-description"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.focus()
          }}
          className={dialogPanelClassName(
            'flex max-h-[min(820px,calc(100dvh-1.5rem))] w-[min(1040px,calc(100vw-1.5rem))] flex-col overflow-hidden'
          )}
        >
          <div className={dialogHeaderClassName} data-slot="context-window-dialog-header">
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>{t('ws.contextWindow')}</Dialog.Title>
              <Dialog.Description
                id="context-window-description"
                className={dialogDescriptionClassName}
              >
                {t('ws.contextWindowDescription')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={dialogCloseButtonClassName}
                aria-label={t('ws.contextClose')}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>

          <div
            className="min-h-0 flex-1 overflow-y-auto"
            data-slot="context-window-dialog-body"
          >
            <div className="space-y-6">
              {currentUsage ? (
                <CurrentComposition
                  usage={currentUsage}
                  model={session?.agentModel ?? latestPoint?.runtime?.model}
                />
              ) : null}
              {points.length ? (
                <ContextHistory points={points} />
              ) : (
                <div className="grid min-h-64 place-items-center rounded-lg border border-dashed border-border bg-bg-100/40 px-6 text-center">
                  <div className="max-w-sm">
                    <Activity className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
                    <h3 className="mt-3 text-sm font-medium text-foreground">
                      {t('ws.contextNoHistory')}
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {t('ws.contextNoHistoryHint')}
                    </p>
                  </div>
                </div>
              )}
              {messages ? <UsageCallsSection messages={messages} /> : null}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { ContextWindowDialog }
