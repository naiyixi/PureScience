import type { PdfTextItem } from './pdf-table-extraction'

// Figures and their captions, from what a PDF actually carries.
//
// A PDF has no "figure" object: it has image placements and text. So a figure here is a placement big
// enough to be a picture, and its caption is a label the style itself wrote ("Figure 3", "Fig. 2", "图 3")
// found near it. Two refusals are deliberate and named rather than smoothed over: a placement below the
// minimum size is decoration (rules, logos, icons) and is skipped by count, and a figure with no label
// nearby is reported as a figure without a caption instead of being given an invented one.
//
// The rule this file follows throughout: report what the document says, count what it does not, and never
// let a caption be attached to a figure the document did not put it next to.

export type PdfImagePlacement = {
  /** PDF user-space point (origin bottom-left), as the page's own operators place it. */
  x: number
  y: number
  width: number
  height: number
}

export type PdfFigureCaptionSource = 'below' | 'above' | 'none'

export type PdfFigureCandidate = {
  page: number
  /** 1-based within its page, in reading order (top to bottom). */
  index: number
  x: number
  y: number
  width: number
  height: number
  caption?: string
  captionSource: PdfFigureCaptionSource
  /** Distance in points between the placement edge and the caption baseline, when there is one. */
  captionDistance?: number
}

export type PdfFigureExtractionOptions = {
  minWidth: number
  minHeight: number
  captionMaxDistance: number
  captionMaxChars: number
}

export type PdfFigureExtraction = {
  figures: PdfFigureCandidate[]
  /** Placements the reader would not call a figure, counted rather than silently dropped. */
  skippedSmall: number
  /** Figures with no label near them; named so the caller can say so instead of implying otherwise. */
  withoutCaption: number
}

const DEFAULTS: PdfFigureExtractionOptions = {
  minWidth: 60,
  minHeight: 60,
  captionMaxDistance: 72,
  captionMaxChars: 300
}

// "Figure 3", "Fig. 2a", "FIGURE 4", "图 3", "圖 3" — the label has to open the line to count, because a
// mid-sentence mention is a reference in the prose, not the caption itself.
const CAPTION_PATTERN = /^\s*(fig(?:ure)?\.?\s*\d+[a-z]?|圖\s*\d+[a-z]?|图\s*\d+[a-z]?)\b/i

export const pdfFigureCaptionStarts = (text: string): boolean => CAPTION_PATTERN.test(text)

const overlapsHorizontally = (figure: PdfImagePlacement, item: PdfTextItem): boolean =>
  item.x < figure.x + figure.width && item.x + item.width > figure.x

const isSmall = (placement: PdfImagePlacement, options: PdfFigureExtractionOptions): boolean =>
  placement.width < options.minWidth || placement.height < options.minHeight

type CaptionCandidate = {
  text: string
  source: Exclude<PdfFigureCaptionSource, 'none'>
  distance: number
}

// Items sharing a baseline belong to the same line, so a caption split across text items is read as one
// string; the line is capped so a paragraph that happens to start with "Figure 2" cannot swallow the page.
const lineOf = (items: readonly PdfTextItem[], anchor: PdfTextItem): string => {
  const sameLine = items
    .filter((item) => Math.abs(item.y - anchor.y) < 2)
    .sort((left, right) => left.x - right.x)
  return sameLine
    .map((item) => item.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const captionFor = (
  figure: PdfImagePlacement,
  items: readonly PdfTextItem[],
  options: PdfFigureExtractionOptions
): CaptionCandidate | undefined => {
  const candidates: CaptionCandidate[] = []
  for (const item of items) {
    if (!overlapsHorizontally(figure, item)) continue
    const line = lineOf(items, item)
    if (!pdfFigureCaptionStarts(line)) continue
    // A caption below the picture sits under it (smaller y in PDF space); one above sits over its top.
    if (item.y <= figure.y) {
      const distance = figure.y - item.y
      if (distance <= options.captionMaxDistance)
        candidates.push({ text: line, source: 'below', distance })
    } else if (item.y >= figure.y + figure.height) {
      const distance = item.y - (figure.y + figure.height)
      if (distance <= options.captionMaxDistance)
        candidates.push({ text: line, source: 'above', distance })
    }
  }
  return candidates.sort((left, right) => left.distance - right.distance)[0]
}

export const extractPdfFigureCandidates = (
  input: { page: number; images: readonly PdfImagePlacement[]; items: readonly PdfTextItem[] },
  overrides: Partial<PdfFigureExtractionOptions> = {}
): PdfFigureExtraction => {
  const options = { ...DEFAULTS, ...overrides }
  const figures: PdfFigureCandidate[] = []
  let skippedSmall = 0

  // Reading order: top of the page first, and left before right on the same band.
  const placements = [...input.images]
    .filter((placement) => placement.width > 0 && placement.height > 0)
    .sort((left, right) => right.y - left.y || left.x - right.x)

  for (const placement of placements) {
    if (isSmall(placement, options)) {
      skippedSmall += 1
      continue
    }
    const caption = captionFor(placement, input.items, options)
    figures.push({
      page: input.page,
      index: figures.length + 1,
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      ...(caption
        ? {
            caption: caption.text.slice(0, options.captionMaxChars),
            captionSource: caption.source,
            captionDistance: Math.round(caption.distance * 10) / 10
          }
        : { captionSource: 'none' as const })
    })
  }

  return {
    figures,
    skippedSmall,
    withoutCaption: figures.filter((figure) => figure.captionSource === 'none').length
  }
}

// Image placements as the page's own drawing operations describe them. Kept here, away from pdf.js, so the
// arithmetic that turns a graphics matrix into a rectangle is testable without a PDF: the service feeds
// these operations from the operator list, and this function decides what a placement is.
//
// Only translation and scale are read. A rotated or skewed matrix still yields the axis-aligned box the
// page would occupy, which is recorded as a limitation rather than presented as the exact quadrilateral.

export type PdfPaintOperation =
  | { kind: 'transform'; matrix: readonly [number, number, number, number, number, number] }
  | { kind: 'image' }

const IDENTITY: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0]

export const pdfImagePlacementsFromOperations = (
  operations: readonly PdfPaintOperation[]
): PdfImagePlacement[] => {
  const placements: PdfImagePlacement[] = []
  let current: readonly [number, number, number, number, number, number] = IDENTITY

  for (const operation of operations) {
    if (operation.kind === 'transform') {
      current = operation.matrix
      continue
    }
    const [, , , , x, y] = current
    const width = Math.abs(current[0])
    const height = Math.abs(current[3])
    // A transform with no scale paints nothing a reader could see, so it is not a figure either.
    if (width <= 0 || height <= 0) continue
    placements.push({ x, y, width, height })
  }

  return placements
}

// What a reader has to check before quoting a figure. Every figure carries at least the axis-aligned
// caveat, because a rotated placement is reported as the box it would occupy rather than as its exact
// quadrilateral; an associated caption says it was found near the picture, not that the document tied it.
export const auditPdfFigureForUse = (figure: PdfFigureCandidate): string[] => {
  const warnings: string[] = [
    'bbox: axis-aligned box from the page transform (rotation and skew are not modelled)'
  ]
  if (figure.caption === undefined) {
    warnings.push('caption: none found near this figure')
  } else {
    warnings.push(
      `caption: associated by proximity (${figure.captionSource}); confirm it labels this figure`
    )
  }
  return warnings
}
