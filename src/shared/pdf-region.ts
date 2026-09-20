import { isBookmarkRect, type BookmarkRect } from './bookmark'

// Turning a drag into a bookmarkable region.
//
// The rule lives here rather than in the PDF surface for the same reason the pick session does: the only
// part worth testing is the arithmetic, and the view should own nothing but the pointer events. A drag
// is expressed in the page's own pixel box and comes back normalized to 0..1, which is what survives a
// zoom change, a window resize, and a different display.
//
// Two refusals are deliberate: a drag that is smaller than the minimum is a click, not a region, and a
// page with no measurable box cannot produce coordinates at all. Both return undefined instead of a
// degenerate rectangle, because a bookmark that highlights nothing is worse than one that was refused.

export const PDF_REGION_MIN_EXTENT = 0.005

export type PdfRegionPoint = { x: number; y: number }
export type PdfRegionBounds = { width: number; height: number }

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

// Four decimals is finer than any display can show (a 1000 px page resolves 0.001) and keeps the stored
// rectangle comparable across runs instead of accumulating float noise.
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000

export const normalizePdfRegionDrag = (
  start: PdfRegionPoint,
  end: PdfRegionPoint,
  bounds: PdfRegionBounds
): BookmarkRect | undefined => {
  if (!(bounds.width > 0) || !(bounds.height > 0)) return undefined
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return undefined

  const left = clamp01(Math.min(start.x, end.x) / bounds.width)
  const top = clamp01(Math.min(start.y, end.y) / bounds.height)
  const right = clamp01(Math.max(start.x, end.x) / bounds.width)
  const bottom = clamp01(Math.max(start.y, end.y) / bounds.height)

  const rect: BookmarkRect = {
    x: round4(left),
    y: round4(top),
    width: round4(right - left),
    height: round4(bottom - top)
  }

  if (rect.width < PDF_REGION_MIN_EXTENT || rect.height < PDF_REGION_MIN_EXTENT) return undefined
  // The shared validator has the final say; a rectangle it would reject must never leave this function.
  return isBookmarkRect(rect) ? rect : undefined
}
