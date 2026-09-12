import { useState } from 'react'

import { FigurePickOverlay } from '../figure/FigurePickOverlay'
import type {
  DigitizationProvenance,
  FigureDigitizationResult
} from '../../../../shared/figure-to-data'

// Panel wrapper for figure digitisation: adds the two pieces of provenance the overlay cannot know
// by itself — which page of the source the figure sits on, and the figure reference — then hands
// off to FigurePickOverlay, which owns the picking rules (steps, calibration, estimated CSV).
export type FigureDigitizePanelProps = {
  /** Source file the figure lives in (PDF or image). */
  sourcePath: string
  /** Default page; for images this stays 1. */
  defaultPage?: number
  /** Pre-filled figure reference (e.g. from the file name). */
  defaultFigureRef?: string
  /** True when the source is a multi-page document and the page must be confirmed. */
  requiresPageEntry?: boolean
  onExport?: (csv: string, result: FigureDigitizationResult) => void
  onClose?: () => void
  className?: string
}

export function FigureDigitizePanel({
  sourcePath,
  defaultPage = 1,
  defaultFigureRef,
  requiresPageEntry = false,
  onExport,
  onClose,
  className
}: FigureDigitizePanelProps): React.JSX.Element {
  const [page, setPage] = useState(String(defaultPage))
  const [figureRef, setFigureRef] = useState(defaultFigureRef ?? '')

  const parsedPage = Number.parseInt(page, 10)
  const pageValid = Number.isFinite(parsedPage) && parsedPage >= 1

  const provenance: DigitizationProvenance = {
    sourcePath,
    page: pageValid ? parsedPage : 0,
    figureRef: figureRef.trim() || undefined,
    method: 'anchor-calibration'
  }

  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border border-[var(--border)] p-3 ${className ?? ''}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--muted-foreground)]">来源</span>
        <span className="font-medium text-[var(--foreground)]" data-testid="digitize-source">
          {sourcePath}
        </span>
        <label className="flex items-center gap-1">
          <span className="text-[var(--muted-foreground)]">页码</span>
          <input
            value={page}
            onChange={(event) => setPage(event.target.value)}
            inputMode="numeric"
            aria-label="页码"
            data-testid="digitize-page"
            className="w-16 rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-1">
          <span className="text-[var(--muted-foreground)]">图号</span>
          <input
            value={figureRef}
            onChange={(event) => setFigureRef(event.target.value)}
            placeholder="如 Fig. 3B"
            aria-label="图号"
            data-testid="digitize-figure-ref"
            className="w-24 rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
          />
        </label>
        {requiresPageEntry ? (
          <span className="text-amber-400" data-testid="digitize-page-required">
            请确认页码：缺失或错误的页码会让溯源失效
          </span>
        ) : null}
      </div>

      {!pageValid ? (
        <p role="alert" className="text-xs text-red-400">
          页码必须是 ≥1 的整数；否则提取结果无法通过溯源审计（不可用）。
        </p>
      ) : null}

      <FigurePickOverlay provenance={provenance} onExport={onExport} />

      {onClose ? (
        <div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-[var(--muted-foreground)] underline"
          >
            关闭
          </button>
        </div>
      ) : null}
    </div>
  )
}
