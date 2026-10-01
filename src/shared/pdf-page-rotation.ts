// Un-rotating a page whose text was placed with a rotated text matrix.
//
// Measured, not assumed (docs/evidence/r4-u3-rotation-investigation.md):
//  - A page's `/Rotate` entry is NOT a defect. The reader already hands back content coordinates, and the
//    same table on a `/Rotate 90` page measures exactly like the upright one (same candidate, same
//    textHash). Nothing here touches that case.
//  - A rotated CONTENT MATRIX (`Tm` at 90/180/270) IS a defect. Every item's "left edge / baseline /
//    width" premise then lies — in the measured fixture a real 6x4 table came out as 4 rows by 1 column
//    and was reported as "not a table" (`too-few-columns`).
//
// Only axis-aligned angles (0/90/180/270) vote. A chart label at 65 degrees is not a page orientation, and
// letting it vote would rotate an upright page out from under itself (the real corpus is full of 45-65
// degree axis labels inside figures). The page is rotated as a WHOLE — one orientation per page — never
// item by item: item-by-item would drop differently oriented text into one column model, and the same
// corpus shows that mixing is the normal case, not the exception.
import type { PdfTextItem } from './pdf-table-extraction'

/** The six values of a PDF text matrix: `[a, b, c, d, e, f]`. */
export type PdfTextMatrix = readonly [number, number, number, number, number, number]

/** A positioned text item together with the matrix it was placed with. */
export type PdfPlacedTextItem = { item: PdfTextItem; matrix: PdfTextMatrix }

export type AxisAlignedRotation = 0 | 90 | 180 | 270

export const AXIS_ALIGNED_ROTATIONS: readonly AxisAlignedRotation[] = [0, 90, 180, 270]

/**
 * The item's own axis-aligned rotation, or `null` when its baseline is not axis-aligned (a figure's 45/65
 * degree label) — those neither vote nor count as the page's orientation.
 *
 * The angle is read from the baseline direction `(a, b)` of the text matrix, so any scale is fine.
 */
export const axisAlignedRotationOf = (matrix: PdfTextMatrix): AxisAlignedRotation | null => {
  const [a, b] = matrix
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  // A degenerate matrix has no direction to read.
  if (a === 0 && b === 0) return null
  const degrees = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360
  const nearestMultipleOf90 = Math.round(degrees / 90) * 90
  // Half a degree of slack for the producer's own float dust; anything further off is not an orientation.
  if (Math.abs(degrees - nearestMultipleOf90) > 0.5) return null
  return (nearestMultipleOf90 % 360) as 0 | 90 | 180 | 270
}

export type PageOrientationReading = {
  /** The angle that normalization would undo; 0 means the page is left exactly as it was read. */
  rotation: AxisAlignedRotation
  /** The vote as counted, in the fixed order 0/90/180/270 — axis-aligned items only. */
  counts: { angle: AxisAlignedRotation; items: number }[]
  /** Items whose rotation is not axis-aligned: reported, never allowed to decide. */
  offAxisItems: number
}

/** Reads a page's orientation. Pure: it never rewrites the items it was given. */
export const readPageOrientation = (
  placed: readonly PdfPlacedTextItem[]
): PageOrientationReading => {
  const counts = new Map<AxisAlignedRotation, number>([
    [0, 0],
    [90, 0],
    [180, 0],
    [270, 0]
  ])
  let offAxisItems = 0
  for (const { matrix } of placed) {
    const angle = axisAlignedRotationOf(matrix)
    if (angle === null) {
      offAxisItems += 1
      continue
    }
    counts.set(angle, (counts.get(angle) ?? 0) + 1)
  }

  const axisAlignedTotal = placed.length - offAxisItems
  let winner: AxisAlignedRotation = 0
  let winnerCount = 0
  for (const angle of AXIS_ALIGNED_ROTATIONS) {
    const count = counts.get(angle) ?? 0
    if (count > winnerCount) {
      winner = angle
      winnerCount = count
    }
  }
  // A STRICT majority, and only a non-zero one: a tie (or a split vote) leaves the page alone. When a
  // handful of rotated chart labels sit inside an upright page, upright still wins and nothing moves.
  const rotated = winner !== 0 && winnerCount * 2 > axisAlignedTotal

  return {
    rotation: rotated ? winner : 0,
    counts: AXIS_ALIGNED_ROTATIONS.map((angle) => ({ angle, items: counts.get(angle) ?? 0 })),
    offAxisItems
  }
}

const TRIG: Record<AxisAlignedRotation, readonly [number, number]> = {
  0: [1, 0],
  90: [0, 1],
  180: [-1, 0],
  270: [0, -1]
}

/** Keeps `-0` (which `0 * -x` produces) out of the coordinates and out of any comparison or snapshot. */
const clean = (value: number): number => (value === 0 ? 0 : value)

/**
 * Rotates the page's items back to upright so that "left edge / baseline / width" are true again.
 *
 * Returns the items untouched — the very same objects, in the same order — when the page is upright, and
 * the reading that produced that decision either way, so a caller can say WHY coordinates were rewritten.
 */
export const normalizePageOrientation = (
  placed: readonly PdfPlacedTextItem[]
): { items: PdfTextItem[]; reading: PageOrientationReading } => {
  const reading = readPageOrientation(placed)
  if (reading.rotation === 0) {
    return { items: placed.map((entry) => entry.item), reading }
  }
  const [cos, sin] = TRIG[reading.rotation]
  const items = placed.map(({ item }) => ({
    ...item,
    x: clean(cos * item.x + sin * item.y),
    y: clean(-sin * item.x + cos * item.y)
  }))
  return { items, reading }
}
