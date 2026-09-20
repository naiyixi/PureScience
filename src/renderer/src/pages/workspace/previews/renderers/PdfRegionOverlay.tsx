import { useRef, useState } from 'react'

import type { BookmarkRect } from '../../../../../../shared/bookmark'
import { normalizePdfRegionDrag, type PdfRegionPoint } from '../../../../../../shared/pdf-region'

// The pointer half of a region bookmark; the arithmetic lives in `shared/pdf-region`, so this file only
// turns pointer events into a start point, an end point and the page's own box.
//
// It is its own component rather than a few handlers inside the PDF page for one reason: a drag is the
// part that cannot be checked by reading code, so it has to be testable on its own and it must not care
// whether the page behind it is a canvas, a text layer or nothing at all.

export type PdfRegionOverlayProps = {
  /** Receives the normalized rectangle when the gesture was a drag, and nothing when it was a click. */
  onRegion: (rect: BookmarkRect) => void
  className?: string
}

const pointOf = (event: React.PointerEvent<HTMLDivElement>): PdfRegionPoint => {
  const bounds = event.currentTarget.getBoundingClientRect()
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
}

export const PdfRegionOverlay = ({
  onRegion,
  className
}: PdfRegionOverlayProps): React.JSX.Element => {
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
    if (rect) onRegion(rect)
  }

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
