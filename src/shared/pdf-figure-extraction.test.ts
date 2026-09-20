import { describe, expect, it } from 'vitest'

import {
  extractPdfFigureCandidates,
  pdfFigureCaptionStarts,
  pdfImagePlacementsFromOperations
} from './pdf-figure-extraction'
import type { PdfTextItem } from './pdf-table-extraction'

// What the extractor promises: a picture big enough to be a figure is reported with the label the document
// put next to it, decoration is counted instead of reported, and a figure the document left unlabelled is
// reported as unlabelled rather than given a caption it never had.

const image = (
  overrides: Partial<{ x: number; y: number; width: number; height: number }> = {}
): { x: number; y: number; width: number; height: number } => ({
  x: 100,
  y: 400,
  width: 200,
  height: 150,
  ...overrides
})

const text = (overrides: Partial<PdfTextItem> & { text: string }): PdfTextItem => ({
  x: 100,
  y: 380,
  width: 200,
  height: 10,
  ...overrides
})

describe('pdfFigureCaptionStarts', () => {
  it('recognises the label at the start of a line in the styles that label figures', () => {
    expect(pdfFigureCaptionStarts('Figure 3. Measured response')).toBe(true)
    expect(pdfFigureCaptionStarts('Fig. 2a — calibration')).toBe(true)
    expect(pdfFigureCaptionStarts('图 3 测量结果')).toBe(true)
    expect(pdfFigureCaptionStarts('圖 4 校準')).toBe(true)
  })

  // A reference inside a sentence is not the caption of the picture it happens to sit near.
  it('does not treat a mention in the middle of a sentence as a caption', () => {
    expect(pdfFigureCaptionStarts('as shown in Figure 3, the response grows')).toBe(false)
    expect(pdfFigureCaptionStarts('see 图 3')).toBe(false)
  })
})

describe('extractPdfFigureCandidates', () => {
  it('attaches the caption under the picture, in reading order', () => {
    const result = extractPdfFigureCandidates({
      page: 2,
      images: [image()],
      items: [text({ text: 'Figure 3. Measured response', y: 380 })]
    })

    expect(result.figures).toHaveLength(1)
    expect(result.figures[0]).toMatchObject({
      page: 2,
      index: 1,
      caption: 'Figure 3. Measured response',
      captionSource: 'below'
    })
    expect(result.withoutCaption).toBe(0)
  })

  it('reads a caption split across text items as one line', () => {
    const result = extractPdfFigureCandidates({
      page: 1,
      images: [image()],
      items: [
        text({ text: 'Figure 1.', x: 100, y: 380, width: 40 }),
        text({ text: 'Split caption text', x: 145, y: 380, width: 120 })
      ]
    })

    expect(result.figures[0].caption).toBe('Figure 1. Split caption text')
  })

  it('accepts a caption above the picture when the style puts it there', () => {
    const result = extractPdfFigureCandidates({
      page: 1,
      images: [image()],
      items: [text({ text: 'Figure 5. Above the picture', y: 565 })]
    })

    expect(result.figures[0]).toMatchObject({
      captionSource: 'above',
      caption: 'Figure 5. Above the picture'
    })
  })

  // Close beats far: a second, unrelated label further down the page must not win.
  it('prefers the nearest caption', () => {
    const result = extractPdfFigureCandidates({
      page: 1,
      images: [image()],
      items: [
        text({ text: 'Figure 7. Far away', y: 340 }),
        text({ text: 'Figure 6. Right below', y: 392 })
      ]
    })

    expect(result.figures[0].caption).toBe('Figure 6. Right below')
  })

  it('reports a figure the document left unlabelled as unlabelled', () => {
    const result = extractPdfFigureCandidates({
      page: 1,
      images: [image()],
      items: [text({ text: 'Ordinary prose next to the picture.' })]
    })

    expect(result.figures).toHaveLength(1)
    expect(result.figures[0].captionSource).toBe('none')
    expect(result.figures[0].caption).toBeUndefined()
    expect(result.withoutCaption).toBe(1)
  })

  it('counts decoration instead of calling it a figure', () => {
    const result = extractPdfFigureCandidates({
      page: 1,
      images: [image(), image({ width: 12, height: 12, x: 20, y: 700 })],
      items: []
    })

    expect(result.figures).toHaveLength(1)
    expect(result.skippedSmall).toBe(1)
  })

  it('ignores a caption that belongs to the prose column beside the picture', () => {
    const result = extractPdfFigureCandidates({
      page: 1,
      images: [image({ x: 100, width: 200 })],
      // Same baseline distance, but horizontally outside the picture.
      items: [text({ text: 'Figure 9. Other column', x: 420, width: 150, y: 380 })]
    })

    expect(result.figures[0].captionSource).toBe('none')
  })

  it('orders figures top to bottom and numbers them within the page', () => {
    const result = extractPdfFigureCandidates({
      page: 4,
      images: [image({ y: 200 }), image({ y: 600 })],
      items: []
    })

    expect(result.figures.map((figure) => figure.y)).toEqual([600, 200])
    expect(result.figures.map((figure) => figure.index)).toEqual([1, 2])
  })
})

describe('pdfImagePlacementsFromOperations', () => {
  it('turns a scale-and-translate matrix into the picture box', () => {
    const placements = pdfImagePlacementsFromOperations([
      { kind: 'transform', matrix: [200, 0, 0, 150, 72, 400] },
      { kind: 'image' }
    ])
    expect(placements).toEqual([{ x: 72, y: 400, width: 200, height: 150 }])
  })

  // The page's matrix is state: a later image is placed by the transform in force when it is painted.
  it('uses the transform in force for each image, not only the first', () => {
    const placements = pdfImagePlacementsFromOperations([
      { kind: 'transform', matrix: [200, 0, 0, 150, 72, 400] },
      { kind: 'image' },
      { kind: 'transform', matrix: [100, 0, 0, 80, 300, 120] },
      { kind: 'image' }
    ])
    expect(placements).toEqual([
      { x: 72, y: 400, width: 200, height: 150 },
      { x: 300, y: 120, width: 100, height: 80 }
    ])
  })

  it('reads a mirrored matrix as a positive box rather than a negative one', () => {
    const placements = pdfImagePlacementsFromOperations([
      { kind: 'transform', matrix: [-200, 0, 0, -150, 500, 600] },
      { kind: 'image' }
    ])
    expect(placements).toEqual([{ x: 500, y: 600, width: 200, height: 150 }])
  })

  it('skips a paint with no scale behind it', () => {
    const placements = pdfImagePlacementsFromOperations([
      { kind: 'transform', matrix: [0, 0, 0, 0, 10, 10] },
      { kind: 'image' }
    ])
    expect(placements).toEqual([])
  })

  it('places an image painted with no transform at all in unit space', () => {
    expect(pdfImagePlacementsFromOperations([{ kind: 'image' }])).toEqual([
      { x: 0, y: 0, width: 1, height: 1 }
    ])
  })
})
