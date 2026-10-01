import { describe, expect, it } from 'vitest'

import {
  axisAlignedRotationOf,
  normalizePageOrientation,
  readPageOrientation,
  type AxisAlignedRotation,
  type PdfPlacedTextItem,
  type PdfTextMatrix
} from './pdf-page-rotation'
import {
  explainTableRejection,
  extractPdfTableCandidates,
  measureTableShape,
  type PdfTextItem
} from './pdf-table-extraction'

const item = (text: string, x: number, y: number, width = text.length * 5): PdfTextItem => ({
  text,
  x,
  y,
  width,
  height: 10
})

// A real 6x4 grid as it sits on an upright page: columns 80 points apart, rows 14.
const COLUMNS = [40, 120, 200, 280]
const ROW_TEXTS = [
  ['Gene', 'log2FC', 'p-value', 'adjP'],
  ['geneA', '2.31', '0.004', '0.011'],
  ['geneB', '-1.05', '0.021', '0.038'],
  ['geneC', '0.87', '0.130', '0.170'],
  ['geneD', '3.42', '0.001', '0.003'],
  ['geneE', '-2.10', '0.008', '0.019']
]
const uprightItems: PdfTextItem[] = ROW_TEXTS.flatMap((cells, rowIndex) =>
  cells.map((text, columnIndex) => item(text, COLUMNS[columnIndex], 700 - rowIndex * 14))
)

const SCALE = 11

// Places an upright item through a text matrix of the given orientation, and moves the item's own
// coordinates to where that matrix puts it — which is exactly what the parser reads (`e` and `f`).
const matrixFor = (rotation: AxisAlignedRotation, x: number, y: number): PdfTextMatrix => {
  switch (rotation) {
    case 0:
      return [SCALE, 0, 0, SCALE, x, y]
    case 90:
      return [0, SCALE, -SCALE, 0, -y, x]
    case 180:
      return [-SCALE, 0, 0, -SCALE, -x, -y]
    case 270:
      return [0, -SCALE, SCALE, 0, y, -x]
  }
}

const placedPage = (
  items: readonly PdfTextItem[],
  rotation: AxisAlignedRotation
): PdfPlacedTextItem[] =>
  items.map((entry) => {
    const matrix = matrixFor(rotation, entry.x, entry.y)
    return { item: { ...entry, x: matrix[4], y: matrix[5] }, matrix }
  })

const labelAt = (text: string, x: number, y: number, angleDegrees: number): PdfPlacedTextItem => {
  const radians = (angleDegrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return { item: item(text, x, y), matrix: [cos, sin, -sin, cos, x, y] }
}

describe('PDF page rotation', () => {
  it('reads the four axis-aligned rotations from the text matrix, at any scale', () => {
    expect(axisAlignedRotationOf([1, 0, 0, 1, 10, 20])).toBe(0)
    expect(axisAlignedRotationOf([0, 11, -11, 0, 300, 120])).toBe(90)
    expect(axisAlignedRotationOf([-3, 0, 0, -3, 5, 5])).toBe(180)
    expect(axisAlignedRotationOf([0, -2.5, 2.5, 0, 1, 1])).toBe(270)
    // Float dust from a producer that computed the matrix with a cosine: still 90.
    expect(axisAlignedRotationOf([6.1e-17, 11, -11, 6.1e-17, 0, 0])).toBe(90)
  })

  it('refuses angles that are not an orientation', () => {
    expect(axisAlignedRotationOf([0.4226, 0.9063, -0.9063, 0.4226, 0, 0])).toBeNull() // 65 degrees
    expect(axisAlignedRotationOf([0.7071, 0.7071, -0.7071, 0.7071, 0, 0])).toBeNull() // 45 degrees
    expect(axisAlignedRotationOf([0, 0, 0, 0, 0, 0])).toBeNull() // degenerate
    expect(axisAlignedRotationOf([Number.NaN, 1, 0, 0, 0, 0])).toBeNull()
  })

  it('does not let figure labels decide a page: upright stays upright', () => {
    const page = [
      ...placedPage(uprightItems, 0),
      labelAt('dose', 10, 10, 65),
      labelAt('time', 30, 10, 45)
    ]

    const reading = readPageOrientation(page)

    expect(reading.rotation).toBe(0)
    expect(reading.offAxisItems).toBe(2)
    expect(reading.counts).toEqual([
      { angle: 0, items: 24 },
      { angle: 90, items: 0 },
      { angle: 180, items: 0 },
      { angle: 270, items: 0 }
    ])
  })

  it('requires a strict majority of axis-aligned items before it turns a page', () => {
    const tie = [
      ...placedPage(uprightItems.slice(0, 12), 0),
      ...placedPage(uprightItems.slice(12), 90)
    ]
    expect(readPageOrientation(tie).rotation).toBe(0)

    const majority = [
      ...placedPage(uprightItems.slice(0, 4), 0),
      ...placedPage(uprightItems.slice(4), 90)
    ]
    expect(readPageOrientation(majority).rotation).toBe(90)
  })

  it('leaves an upright page exactly as it was read — the same items, not copies', () => {
    const page: PdfPlacedTextItem[] = uprightItems.map((entry) => ({
      item: entry,
      matrix: [1, 0, 0, 1, entry.x, entry.y]
    }))

    const { items, reading } = normalizePageOrientation(page)

    expect(reading.rotation).toBe(0)
    expect(items).toHaveLength(page.length)
    items.forEach((entry, index) => {
      expect(entry).toBe(page[index].item)
    })
  })

  it('records the defect it exists for: rotated, the true 6x4 grid reads as 4 rows by 1 column', () => {
    const rotatedItems = placedPage(uprightItems, 90).map((entry) => entry.item)

    const shape = measureTableShape(rotatedItems)
    expect(shape.itemCount).toBe(24)
    expect(shape.columns).toBe(1)
    expect(shape.rows).toHaveLength(4)
    expect(shape.spanningRows).toBe(0)
    expect(extractPdfTableCandidates(1, rotatedItems)).toEqual([])
    expect(explainTableRejection(1, { items: rotatedItems, pageText: 'x' })).toMatchObject({
      reason: 'too-few-columns',
      counts: { itemCount: 24, rows: 4, columns: 1, spanningRows: 0 }
    })
  })

  it('reads the rotated page as its real 6x4 table once the rotation is normalized', () => {
    const { items, reading } = normalizePageOrientation(placedPage(uprightItems, 90))

    expect(reading.rotation).toBe(90)
    expect(measureTableShape(items).columns).toBe(4)

    const [candidate] = extractPdfTableCandidates(4, items)
    expect(candidate).toBeDefined()
    expect(candidate.columnCount).toBe(4)
    expect(candidate.rows).toEqual(ROW_TEXTS)
  })

  it('round-trips a half turn and a three-quarter turn', () => {
    for (const rotation of [90, 180, 270] as const) {
      const { items, reading } = normalizePageOrientation(placedPage(uprightItems, rotation))

      expect(reading.rotation).toBe(rotation)
      expect(items.map((entry) => [entry.text, entry.x, entry.y])).toEqual(
        uprightItems.map((entry) => [entry.text, entry.x, entry.y])
      )
      expect(extractPdfTableCandidates(2, items)[0]?.rows).toEqual(ROW_TEXTS)
    }
  })

  it('never leaves a negative zero in the rewritten coordinates', () => {
    const { items } = normalizePageOrientation(placedPage(uprightItems, 90))

    for (const entry of items) {
      expect(Object.is(entry.x, -0)).toBe(false)
      expect(Object.is(entry.y, -0)).toBe(false)
    }
  })
})
