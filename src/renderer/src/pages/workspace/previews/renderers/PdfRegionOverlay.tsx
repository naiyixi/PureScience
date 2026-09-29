import { useRef, useState } from 'react'

import type { BookmarkRect } from '../../../../../../shared/bookmark'
import { normalizePdfRegionDrag, type PdfRegionPoint } from '../../../../../../shared/pdf-region'

// The pointer half of a region on a PDF page; the arithmetic lives in `shared/pdf-region`, so this file
// only turns pointer events into a start point, an end point and the page's own box.
//
// It is its own component rather than a few handlers inside the PDF page for one reason: a drag is the
// part that cannot be checked by reading code, so it has to be testable on its own and it must not care
// whether the page behind it is a canvas, a text layer or nothing at all.
//
// Two gestures live here (文档标注层 A3): a DRAG is a region, and a PRESS that never moved is where a page
// note wants to sit. Which of them the reader is making is not this component's business — it reports
// each one and the preview decides, which is why the same overlay serves a region bookmark and a region
// annotation without either knowing about the other.

export type PdfPagePoint = { x: number; y: number }

export type PdfRegionOverlayProps = {
  /** Receives the normalized rectangle when the gesture was a drag, and nothing when it was a click. */
  onRegion: (rect: BookmarkRect) => void
  /**
   * Where on the page a press happened, normalized, when that press never moved. Absent while nothing
   * is being placed — a click then means what it always meant, and nothing is reported.
   */
  onPress?: (point: PdfPagePoint) => void
  /**
   * False while the reader is not placing anything: the layer stops taking pointer events, so a page can
   * still be scrolled and its text still selected.
   */
  enabled?: boolean
  className?: string
}

const pointOf = (event: React.PointerEvent<HTMLDivElement>): PdfRegionPoint => {
  const bounds = event.currentTarget.getBoundingClientRect()
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000

export const PdfRegionOverlay = ({
  onRegion,
  onPress,
  enabled = true,
  className
}: PdfRegionOverlayProps): React.JSX.Element | null => {
  // The gesture lives in refs and only its display lives in state. A pointerup can arrive before React
  // has re-rendered the pointermove, and a drag that depends on that render having happened would drop
  // the rectangle the reader just drew.
  const startRef = useRef<PdfRegionPoint | undefined>(undefined)
  const currentRef = useRef<PdfRegionPoint | undefined>(undefined)
  const [band, setBand] = useState<{ start: PdfRegionPoint; current: PdfRegionPoint } | undefined>(
    undefined
  )
  // The box is captured per gesture: the overlay can be re-laid out mid-drag (a resize, a scroll), and
  // normalizing against a box that moved would store a rectangle the reader never drew.
  const boundsRef = useRef<{ width: number; height: number } | undefined>(undefined)

  const finish = (): void => {
    const origin = startRef.current
    const end = currentRef.current
    const bounds = boundsRef.current
    startRef.current = undefined
    currentRef.current = undefined
    boundsRef.current = undefined
    setBand(undefined)
    if (!origin || !end || !bounds) return
    const rect = normalizePdfRegionDrag(origin, end, bounds)
    if (rect) {
      onRegion(rect)
      return
    }
    // A press that never moved. Reported as a point rather than as a zero-sized rectangle, because a
    // rectangle with no extent is refused everywhere else in the app and would silently store nothing.
    onPress?.({
      x: round4(clamp01(end.x / bounds.width)),
      y: round4(clamp01(end.y / bounds.height))
    })
  }

  if (!enabled) return null

  return (
    <div
      data-slot="pdf-region-overlay"
      className={`absolute inset-0 z-10 cursor-crosshair ${className ?? ''}`}
      onPointerDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        if (!(bounds.width > 0) || !(bounds.height > 0)) return
        boundsRef.current = { width: bounds.width, height: bounds.height }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        const point = pointOf(event)
        startRef.current = point
        currentRef.current = point
        setBand({ start: point, current: point })
      }}
      onPointerMove={(event) => {
        const origin = startRef.current
        if (!origin) return
        const point = pointOf(event)
        currentRef.current = point
        setBand({ start: origin, current: point })
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      {band ? (
        <span
          data-slot="pdf-region-rubber-band"
          aria-hidden="true"
          className="pointer-events-none absolute border border-primary/70 bg-primary/15"
          style={{
            left: Math.min(band.start.x, band.current.x),
            top: Math.min(band.start.y, band.current.y),
            width: Math.abs(band.current.x - band.start.x),
            height: Math.abs(band.current.y - band.start.y)
          }}
        />
      ) : null}
    </div>
  )
}
