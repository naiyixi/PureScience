import { useCallback, useMemo, useState } from 'react'
import { Crosshair, MousePointerClick, RotateCcw, Trash2, Undo2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useLanguage, type Translate } from '@/i18n'
import { isFigureErrorKey } from './figure-error-keys'
import type {
  DigitizationProvenance,
  FigureDigitizationResult
} from '../../../../shared/figure-to-data'
import {
  addAnchor,
  addPick,
  buildDigitization,
  canPickPoints,
  startPickSession,
  toDigitizationCsv,
  undoPick,
  type PickSessionState
} from '../../../../shared/figure-pick-session'

// Thin picking shell over any figure surface (PDF page canvas or image): the component owns only
// clicks and labels — every rule (phase order, degenerate anchors, provenance, audit) lives in
// shared/figure-pick-session, so this file stays a view.
export type FigurePickOverlayProps = {
  provenance: DigitizationProvenance
  /** Called when the user finishes a digitisation (CSV ready). */
  onExport?: (csv: string, result: FigureDigitizationResult) => void
  className?: string
}

const describePhase = (phase: PickSessionState['phase'], t: Translate): string =>
  ({
    'anchors-x': t('figure.phaseAnchorsX'),
    'anchors-y': t('figure.phaseAnchorsY'),
    picking: t('figure.phasePicking'),
    ready: t('figure.phaseReady')
  })[phase]

/** Shared errors carry an i18n key; anything else is a transport-level message and stays as-is. */
const describePickError = (cause: unknown, t: Translate): string => {
  if (cause instanceof Error && 'messageKey' in cause) {
    const key = (cause as { messageKey?: string }).messageKey
    if (isFigureErrorKey(key)) return t(key)
  }
  return cause instanceof Error ? cause.message : String(cause)
}

export function FigurePickOverlay({
  provenance,
  onExport,
  className
}: FigurePickOverlayProps): React.JSX.Element {
  const { t } = useLanguage()
  const [session, setSession] = useState<PickSessionState>(() => startPickSession())
  const [xValueDraft, setXValueDraft] = useState('')
  const [yValueDraft, setYValueDraft] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  const nextAxis: 'x' | 'y' = session.phase === 'anchors-x' ? 'x' : 'y'
  const draft = nextAxis === 'x' ? xValueDraft : yValueDraft
  const setDraft = nextAxis === 'x' ? setXValueDraft : setYValueDraft

  const handleSurfaceClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect()
      const point = {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top
      }
      try {
        setError(undefined)
        if (canPickPoints(session)) {
          setSession(addPick(session, point))
          return
        }
        const value = Number.parseFloat(draft)
        if (!Number.isFinite(value)) {
          setError(t('figure.tickValueMissing'))
          return
        }
        setSession(
          addAnchor(session, nextAxis, { pixel: nextAxis === 'x' ? point.x : point.y, value })
        )
        setDraft('')
      } catch (cause) {
        setError(describePickError(cause, t))
      }
    },
    [draft, nextAxis, session, setDraft, t]
  )

  const handleReset = useCallback(() => {
    setSession(startPickSession())
    setError(undefined)
    setXValueDraft('')
    setYValueDraft('')
  }, [])

  const canExport = session.phase === 'ready'
  const progressLabel = useMemo(() => {
    const parts = [
      t('figure.xAnchorProgress').replace('{count}', String(session.xAnchors.length)),
      t('figure.yAnchorProgress').replace('{count}', String(session.yAnchors.length)),
      t('figure.pickProgress').replace('{count}', String(session.picks.length))
    ]
    return parts.join(' · ')
  }, [session, t])

  const handleExport = useCallback(() => {
    try {
      const result = buildDigitization(session, provenance)
      onExport?.(toDigitizationCsv(result), result)
      setError(undefined)
    } catch (cause) {
      setError(describePickError(cause, t))
    }
  }, [onExport, provenance, session, t])

  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`}>
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] px-2 py-1 text-xs">
        <Crosshair className="size-3.5" aria-hidden="true" />
        <span data-testid="figure-pick-phase">{describePhase(session.phase, t)}</span>
        <span className="text-[var(--muted-foreground)]" data-testid="figure-pick-progress">
          {progressLabel}
        </span>
      </div>

      {session.phase === 'anchors-x' || session.phase === 'anchors-y' ? (
        <label className="flex items-center gap-2 text-xs">
          <span className="text-[var(--muted-foreground)]">{t('figure.tickValueLabel')}</span>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            inputMode="decimal"
            placeholder={t('figure.tickValuePlaceholder')}
            aria-label={t('figure.tickValueLabel')}
            className="w-28 rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
          />
        </label>
      ) : null}

      <div
        data-testid="figure-pick-surface"
        role="application"
        aria-label={t('figure.pickSurface')}
        onClick={handleSurfaceClick}
        className="relative min-h-40 cursor-crosshair rounded-md border border-dashed border-[var(--border)] bg-[var(--muted)]/20"
      >
        {session.xAnchors.map((anchor, index) => (
          <span
            key={`x-${index}`}
            title={t('figure.xAnchorTitle').replace('{value}', String(anchor.value))}
            className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--accent)]"
            style={{ left: anchor.pixel, top: 8 }}
          />
        ))}
        {session.yAnchors.map((anchor, index) => (
          <span
            key={`y-${index}`}
            title={t('figure.yAnchorTitle').replace('{value}', String(anchor.value))}
            className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--accent)]"
            style={{ left: 8, top: anchor.pixel }}
          />
        ))}
        {session.picks.map((pick, index) => (
          <span
            key={`p-${index}`}
            className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400"
            style={{ left: pick.x, top: pick.y }}
          />
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={session.picks.length === 0}
          onClick={() => setSession(undoPick(session))}
        >
          <Undo2 className="size-3.5" aria-hidden="true" /> {t('figure.undoPoint')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={handleReset}>
          <RotateCcw className="size-3.5" aria-hidden="true" /> {t('figure.restart')}
        </Button>
        <Button type="button" size="sm" disabled={!canExport} onClick={handleExport}>
          <MousePointerClick className="size-3.5" aria-hidden="true" /> {t('figure.exportCsv')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setSession({ ...session, picks: [] })}
          disabled={session.picks.length === 0}
        >
          <Trash2 className="size-3.5" aria-hidden="true" /> {t('figure.clearPoints')}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  )
}
