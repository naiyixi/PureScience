import { useCallback, useMemo, useRef, useState } from 'react'
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
  // The pointer has a crosshair wherever it goes; the keyboard needs one of its own, and needs to be told
  // where it is, or picking is a pointer-only action wearing a focus ring.
  const [caret, setCaret] = useState<{ x: number; y: number } | undefined>(undefined)
  const surfaceRef = useRef<HTMLDivElement | null>(null)

  const nextAxis: 'x' | 'y' = session.phase === 'anchors-x' ? 'x' : 'y'
  const draft = nextAxis === 'x' ? xValueDraft : yValueDraft
  const setDraft = nextAxis === 'x' ? setXValueDraft : setYValueDraft

  /** The one place a point is placed, whether it came from a click or from the keyboard caret. */
  const placePoint = useCallback(
    (point: { x: number; y: number }) => {
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

  const handleSurfaceClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect()
      placePoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
    },
    [placePoint]
  )

  const moveCaret = useCallback((dx: number, dy: number) => {
    const bounds = surfaceRef.current?.getBoundingClientRect()
    const width = bounds?.width ?? 0
    const height = bounds?.height ?? 0
    setCaret((current) => {
      const start = current ?? { x: width / 2, y: height / 2 }
      return {
        x: Math.min(Math.max(start.x + dx, 0), width),
        y: Math.min(Math.max(start.y + dy, 0), height)
      }
    })
  }, [])

  const handleSurfaceKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 10 : 1
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step]
      }
      const move = moves[event.key]
      if (move) {
        event.preventDefault()
        moveCaret(move[0], move[1])
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        // Dropping the caret recentres the next placement, which is the one thing a stray caret must not
        // decide: where the next point lands.
        setCaret(undefined)
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const bounds = surfaceRef.current?.getBoundingClientRect()
        const point = caret ?? { x: (bounds?.width ?? 0) / 2, y: (bounds?.height ?? 0) / 2 }
        if (!caret) setCaret(point)
        placePoint(point)
        return
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        if (session.picks.length === 0) return
        event.preventDefault()
        setSession(undoPick(session))
        setError(undefined)
      }
    },
    [caret, moveCaret, placePoint, session]
  )

  const handleReset = useCallback(() => {
    setSession(startPickSession())
    setError(undefined)
    setXValueDraft('')
    setYValueDraft('')
    setCaret(undefined)
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
        ref={surfaceRef}
        data-testid="figure-pick-surface"
        role="application"
        aria-label={t('figure.pickSurface')}
        aria-describedby="figure-pick-keyboard-hint"
        tabIndex={0}
        onClick={handleSurfaceClick}
        onKeyDown={handleSurfaceKeyDown}
        className="relative min-h-40 cursor-crosshair rounded-md border border-dashed border-[var(--border)] bg-[var(--muted)]/20 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        {caret ? (
          <span
            data-testid="figure-pick-caret"
            aria-hidden="true"
            className="pointer-events-none absolute z-10 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--accent)]"
            style={{ left: caret.x, top: caret.y }}
          />
        ) : null}
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

      <p
        id="figure-pick-keyboard-hint"
        className="text-[11px] text-[var(--muted-foreground)]"
        data-testid="figure-pick-keyboard-hint"
      >
        {t('figure.keyboardHint')}
      </p>
      <p
        aria-live="polite"
        data-testid="figure-pick-caret-status"
        className="text-[11px] text-[var(--muted-foreground)]"
      >
        {caret
          ? t('figure.caretPosition')
              .replace('{x}', String(Math.round(caret.x)))
              .replace('{y}', String(Math.round(caret.y)))
          : ''}
      </p>

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
