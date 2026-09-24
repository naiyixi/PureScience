import { useState } from 'react'

import { useLanguage } from '@/i18n'
import { Button } from '@/components/ui/button'
import type { FigurePanel, FigureReviewResult } from '../../../../shared/figure'

// The publication-grade figure checklist (`figure:review`) has been reachable only from the agent's tool
// since it landed. The rule engine takes a *declaration* of a panel, so a surface has to be honest about
// what a reader of a published figure can and cannot declare:
//
//   - What the reader can see and answer: chart type, the data shape it implies, how many series and
//     labels are on it, whether it was inspected at all, the smallest font, and the tick labels of a log
//     axis (the mislabeled-decade check is exactly the one a careful reader can catch).
//   - What only the figure's author can answer: whether excluded rows leaked into summary statistics. The
//     panel says so instead of leaving that rule silently unevaluated, because "clean" from this page must
//     never be read as "the figure's data handling was verified".
//
// Every field is optional in the sense that an omitted field is an *undeclared* one — the engine treats it
// as such — so nothing here invents a value the reader did not give.

type FigureReviewPanelProps = {
  projectId: string
  sourceName: string
  onClose: () => void
}

const CHART_TYPES = ['line', 'bar', 'scatter', 'histogram', 'box', 'heatmap', 'other'] as const

type FormState = {
  panelId: string
  chartType: (typeof CHART_TYPES)[number]
  timeSeries: boolean
  categorical: boolean
  distribution: boolean
  relationship: boolean
  seriesCount: string
  labelCount: string
  fontPt: string
  rendered: boolean
  logAxis: '' | 'x' | 'y'
  logTicks: string
  imagePath: string
  scriptPath: string
}

const INITIAL: FormState = {
  panelId: 'A',
  chartType: 'line',
  timeSeries: true,
  categorical: false,
  distribution: false,
  relationship: false,
  seriesCount: '2',
  labelCount: '4',
  fontPt: '8',
  rendered: false,
  logAxis: '',
  logTicks: '',
  imagePath: '',
  scriptPath: ''
}

type Result =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ready'; result: FigureReviewResult }
  | { status: 'failed'; message: string }

const toNumber = (value: string): number | undefined => {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

const FigureReviewPanel = ({
  projectId,
  sourceName,
  onClose
}: FigureReviewPanelProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [form, setForm] = useState<FormState>(INITIAL)
  const [state, setState] = useState<Result>({ status: 'idle' })

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const buildPanel = (): FigurePanel => {
    const ticks = form.logTicks
      .split(',')
      .map((tick) => tick.trim())
      .filter((tick) => tick !== '')
    const panel: FigurePanel = {
      id: form.panelId.trim() === '' ? 'A' : form.panelId.trim(),
      chartType: form.chartType,
      dataShape: {
        timeSeries: form.timeSeries,
        categorical: form.categorical,
        distribution: form.distribution,
        relationship: form.relationship
      },
      rendered: form.rendered
    }
    const seriesCount = toNumber(form.seriesCount)
    if (seriesCount !== undefined) panel.seriesCount = seriesCount
    const labelCount = toNumber(form.labelCount)
    if (labelCount !== undefined) panel.labelCount = labelCount
    const fontPt = toNumber(form.fontPt)
    if (fontPt !== undefined) panel.fontPt = fontPt
    if (form.logAxis !== '' && ticks.length > 0) {
      panel.axisTicks = [{ axis: form.logAxis, scale: 'log', labels: ticks }]
    }
    if (form.imagePath.trim() !== '') panel.renderedImagePath = form.imagePath.trim()
    if (form.scriptPath.trim() !== '') panel.sourceScriptPath = form.scriptPath.trim()
    return panel
  }

  const run = async (): Promise<void> => {
    const figure = window.api?.figure
    if (typeof figure?.review !== 'function') {
      setState({ status: 'failed', message: t('figureReview.unavailable') })
      return
    }
    setState({ status: 'running' })
    try {
      const result = await figure.review({ projectId, request: { panels: [buildPanel()] } })
      setState({ status: 'ready', result })
    } catch (error) {
      setState({
        status: 'failed',
        message: error instanceof Error ? error.message : t('figureReview.unavailable')
      })
    }
  }

  const inputClass = 'w-full rounded border border-border-300 bg-bg-000 px-2 py-1 text-xs'
  const labelClass = 'text-xs text-text-300'

  return (
    <div
      data-testid="figure-review-panel"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-300"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border-300 px-3 py-2">
        <span className="text-sm font-medium">{t('figureReview.title')}</span>
        <span className="truncate text-xs text-text-300" title={sourceName}>
          {sourceName}
        </span>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          ×
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        <p className="text-[11px] text-text-400" data-testid="figure-review-scope">
          {t('figureReview.hint')}
        </p>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-0.5">
            <span className={labelClass}>{t('figureReview.panelId')}</span>
            <input
              className={inputClass}
              data-testid="figure-review-panel-id"
              value={form.panelId}
              onChange={(event) => set('panelId', event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className={labelClass}>{t('figureReview.chartType')}</span>
            <select
              className={inputClass}
              data-testid="figure-review-chart-type"
              value={form.chartType}
              onChange={(event) => set('chartType', event.target.value as FormState['chartType'])}
            >
              {CHART_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className={labelClass}>{t('figureReview.seriesCount')}</span>
            <input
              className={inputClass}
              data-testid="figure-review-series-count"
              value={form.seriesCount}
              onChange={(event) => set('seriesCount', event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className={labelClass}>{t('figureReview.labelCount')}</span>
            <input
              className={inputClass}
              data-testid="figure-review-label-count"
              value={form.labelCount}
              onChange={(event) => set('labelCount', event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className={labelClass}>{t('figureReview.fontPt')}</span>
            <input
              className={inputClass}
              data-testid="figure-review-font-pt"
              value={form.fontPt}
              onChange={(event) => set('fontPt', event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className={labelClass}>{t('figureReview.logAxis')}</span>
            <select
              className={inputClass}
              data-testid="figure-review-log-axis"
              value={form.logAxis}
              onChange={(event) => set('logAxis', event.target.value as FormState['logAxis'])}
            >
              <option value="">—</option>
              <option value="x">x</option>
              <option value="y">y</option>
            </select>
          </label>
          <label className="col-span-2 flex flex-col gap-0.5">
            <span className={labelClass}>{t('figureReview.logTicks')}</span>
            <input
              className={inputClass}
              data-testid="figure-review-log-ticks"
              placeholder={t('figureReview.logTicksPlaceholder')}
              value={form.logTicks}
              onChange={(event) => set('logTicks', event.target.value)}
            />
          </label>
        </div>

        <fieldset className="mt-2">
          <legend className={labelClass}>{t('figureReview.shape')}</legend>
          <div className="flex flex-wrap gap-3 text-xs">
            {(
              [
                ['timeSeries', 'figureReview.shapeTimeSeries'],
                ['categorical', 'figureReview.shapeCategorical'],
                ['distribution', 'figureReview.shapeDistribution'],
                ['relationship', 'figureReview.shapeRelationship']
              ] as const
            ).map(([key, labelKey]) => (
              <label key={key} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  data-testid={`figure-review-shape-${key}`}
                  checked={form[key]}
                  onChange={(event) => set(key, event.target.checked)}
                />
                {t(labelKey)}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="mt-2 flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            data-testid="figure-review-rendered"
            checked={form.rendered}
            onChange={(event) => set('rendered', event.target.checked)}
          />
          {t('figureReview.rendered')}
        </label>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-0.5">
            <span className={labelClass}>{t('figureReview.imagePath')}</span>
            <input
              className={inputClass}
              data-testid="figure-review-image-path"
              value={form.imagePath}
              onChange={(event) => set('imagePath', event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className={labelClass}>{t('figureReview.scriptPath')}</span>
            <input
              className={inputClass}
              data-testid="figure-review-script-path"
              value={form.scriptPath}
              onChange={(event) => set('scriptPath', event.target.value)}
            />
          </label>
        </div>

        <p className="mt-2 text-[11px] text-text-400" data-testid="figure-review-author-only">
          {t('figureReview.authorOnly')}
        </p>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-2"
          data-testid="figure-review-run"
          onClick={() => void run()}
        >
          {t('figureReview.run')}
        </Button>

        {state.status === 'failed' ? (
          <p className="mt-2 text-xs text-text-300" data-testid="figure-review-failed">
            {state.message}
          </p>
        ) : null}

        {state.status === 'ready' ? (
          <div className="mt-2" data-testid="figure-review-result">
            <p className="text-xs" data-testid="figure-review-count">
              {t('figureReview.violationCount', { count: state.result.violations.length })}
            </p>
            {state.result.clean ? (
              <p className="mt-1 text-xs text-text-200" data-testid="figure-review-clean">
                {t('figureReview.clean')}
              </p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {state.result.violations.map((violation, index) => (
                  <li
                    key={`${violation.rule}-${violation.panelId}-${index}`}
                    data-testid={`figure-review-violation-${index}`}
                    data-rule={violation.rule}
                    data-severity={violation.severity}
                    className="text-xs text-text-200"
                  >
                    <span className="text-text-400">
                      {violation.severity} · {violation.rule} ·{' '}
                    </span>
                    {violation.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export { FigureReviewPanel }
