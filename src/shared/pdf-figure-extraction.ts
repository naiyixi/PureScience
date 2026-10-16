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

/** 候选从哪来：图像放置，还是页面的路径几何。读者要能分辨，否则矢量簇会被当成一张位图。 */
export type PdfFigureOrigin = 'image' | 'vector'

export type PdfFigureCandidate = {
  page: number
  /** 1-based within its page, in reading order (top to bottom). */
  index: number
  x: number
  y: number
  width: number
  height: number
  origin: PdfFigureOrigin
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
  input: {
    page: number
    images: readonly PdfImagePlacement[]
    /** 路径几何聚出来的候选（见 pdfVectorFigurePlacementsFromOperations）；缺席就是没有。 */
    vector?: readonly PdfImagePlacement[]
    items: readonly PdfTextItem[]
  },
  overrides: Partial<PdfFigureExtractionOptions> = {}
): PdfFigureExtraction => {
  const options = { ...DEFAULTS, ...overrides }
  const figures: PdfFigureCandidate[] = []
  let skippedSmall = 0

  // Reading order: top of the page first, and left before right on the same band. Both sources share the
  // ordering, so the index of a candidate is its reading position on the page regardless of where the
  // geometry came from.
  const placements = [
    ...input.images.map((placement) => ({ placement, origin: 'image' as const })),
    ...(input.vector ?? []).map((placement) => ({ placement, origin: 'vector' as const }))
  ]
    .filter(({ placement }) => placement.width > 0 && placement.height > 0)
    .sort(
      (left, right) => right.placement.y - left.placement.y || left.placement.x - right.placement.x
    )

  for (const { placement, origin } of placements) {
    if (isSmall(placement, options)) {
      skippedSmall += 1
      continue
    }
    const caption = captionFor(placement, input.items, options)
    figures.push({
      page: input.page,
      index: figures.length + 1,
      origin,
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
  // 路径绘制的原始数字串（`OPS.constructPath` 的 args，未经任何数学处理）。矢量画的图 —— 流程图、森林图、
  // 决策树 —— 在文字层里几乎只剩轴标注，而它们**根本不产出图像放置**，所以此前连候选都不是：这一类证据
  // 缺口让「判不出」成了真机上的常态（见 U4 的真机读数）。点留在这里、矩阵也留在这里，几何运算集中一处。
  | { kind: 'path'; points: readonly number[] }

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

// 矢量图候选：把页面的**路径绘制**聚成盒。
//
// 为什么需要它：森林图、决策树、敏感性曲线这类图是**画出来的**，不是图像放置 —— 它们此前连候选都不是，
// 于是「这张图是什么」在真机上无从判起（U4 的实机读数：7 张候选全判不出）。判据一个字没动：这里只补齐
// **证据来源**，让图框存在，框内的文字项（轴标注与数值本来就是文字层里的字）才有机会投票。
//
// 每条阈值都是显式且可校准的，不藏在魔法数里：
// - 细过 minStrokeThickness 的路径 = 规则线 / 表格线；
// - 盖住 ≥ fullPageRatio 页面的路径 = 整页边框 / 底色；
// - 间距 ≤ clusterGap 的盒并成一簇（一张矢量图常常是上百条路径画的）；
// - 一簇要够大（面积 ≥ minAreaRatio 页面、两边各 ≥ minSide）才算一张图。
export type PdfVectorFigureOptions = {
  minStrokeThickness: number
  fullPageRatio: number
  clusterGap: number
  minAreaRatio: number
  minSide: number
}

export const DEFAULT_VECTOR_FIGURE_OPTIONS: PdfVectorFigureOptions = {
  minStrokeThickness: 2,
  fullPageRatio: 0.9,
  clusterGap: 8,
  minAreaRatio: 0.04,
  minSide: 60
}

type Box = { x: number; y: number; width: number; height: number }

// `OPS.constructPath` 的 args[1] 是一个**打包流**：每条指令先给一个码，再给若干坐标数字。
// 文法不是猜的 —— 在本机真机语料（PRX009 的森林图，157 条路径）上按「必须恰好读完」验证：
// 0=移动(2 个坐标)、1=连线(2)、2=曲线(6)，其余码为收尾码(0)。157/157 恰好消费完。
const PATH_OP_ARITY: Record<number, number> = { 0: 2, 1: 2, 2: 6 }

const boxFromPoints = (
  points: readonly number[],
  matrix: readonly [number, number, number, number, number, number]
): Box | undefined => {
  const [a, b, c, d, e, f] = matrix
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let seen = 0
  let index = 0
  while (index < points.length) {
    const code = points[index]
    const width = PATH_OP_ARITY[code] ?? 0
    index += 1
    // 曲线把控制点也当点读 —— 只会把盒子撑大（保守外扩），不会裁小，所以「框内文字」判定只会多算、不漏算。
    for (let offset = 0; offset + 1 < width; offset += 2) {
      const x = Number(points[index + offset])
      const y = Number(points[index + offset + 1])
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      const dx = a * x + c * y + e
      const dy = b * x + d * y + f
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue
      seen += 1
      if (dx < minX) minX = dx
      if (dy < minY) minY = dy
      if (dx > maxX) maxX = dx
      if (dy > maxY) maxY = dy
    }
    index += width
  }
  if (seen === 0) return undefined
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

const boxesTouch = (left: Box, right: Box, gap: number): boolean =>
  left.x - gap <= right.x + right.width &&
  right.x - gap <= left.x + left.width &&
  left.y - gap <= right.y + right.height &&
  right.y - gap <= left.y + left.height

const unionBox = (left: Box, right: Box): Box => {
  const x = Math.min(left.x, right.x)
  const y = Math.min(left.y, right.y)
  return {
    x,
    y,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y
  }
}

export const pdfVectorFigurePlacementsFromOperations = (
  operations: readonly PdfPaintOperation[],
  page: { width: number; height: number },
  overrides: Partial<PdfVectorFigureOptions> = {}
): { placements: PdfImagePlacement[]; skippedPaths: number; skippedClusters: number } => {
  const options = { ...DEFAULT_VECTOR_FIGURE_OPTIONS, ...overrides }
  const pageArea = page.width > 0 && page.height > 0 ? page.width * page.height : 0
  const boxes: Box[] = []
  let skippedPaths = 0
  let current: readonly [number, number, number, number, number, number] = IDENTITY

  for (const operation of operations) {
    if (operation.kind === 'transform') {
      current = operation.matrix
      continue
    }
    if (operation.kind !== 'path') continue
    const box = boxFromPoints(operation.points, current)
    if (!box) continue
    const thin = box.width < options.minStrokeThickness || box.height < options.minStrokeThickness
    const wholePage = pageArea > 0 && (box.width * box.height) / pageArea >= options.fullPageRatio
    if (thin || wholePage) {
      skippedPaths += 1
      continue
    }
    boxes.push(box)
  }

  // 聚簇：并到不再变化为止 —— 一次合并出来的大盒子可能又碰到第三批路径。
  let clusters = boxes.slice()
  for (;;) {
    const merged: Box[] = []
    const used = new Array<boolean>(clusters.length).fill(false)
    let changed = false
    for (let i = 0; i < clusters.length; i += 1) {
      if (used[i]) continue
      let box = clusters[i]
      used[i] = true
      for (let j = i + 1; j < clusters.length; j += 1) {
        if (used[j]) continue
        if (!boxesTouch(box, clusters[j], options.clusterGap)) continue
        box = unionBox(box, clusters[j])
        used[j] = true
        changed = true
      }
      merged.push(box)
    }
    clusters = merged
    if (!changed) break
  }

  const placements: PdfImagePlacement[] = []
  let skippedClusters = 0
  for (const cluster of clusters) {
    const areaOk =
      pageArea > 0 && (cluster.width * cluster.height) / pageArea >= options.minAreaRatio
    const sizeOk = cluster.width >= options.minSide && cluster.height >= options.minSide
    if (!areaOk || !sizeOk) {
      skippedClusters += 1
      continue
    }
    placements.push({
      x: cluster.x,
      y: cluster.y,
      width: cluster.width,
      height: cluster.height
    })
  }

  return { placements, skippedPaths, skippedClusters }
}

// What a reader has to check before quoting a figure. Every figure carries at least the axis-aligned
// caveat, because a rotated placement is reported as the box it would occupy rather than as its exact
// quadrilateral; an associated caption says it was found near the picture, not that the document tied it.
export const auditPdfFigureForUse = (figure: PdfFigureCandidate): string[] => {
  const warnings: string[] = [
    'bbox: axis-aligned box from the page transform (rotation and skew are not modelled)'
  ]
  if (figure.origin === 'vector') {
    // 路径画出来的盒子是保守外扩：曲线的控制点也算进包围盒，所以它只会比图形本身略大。
    warnings.push(
      'bbox-origin: vector paths (curve control points included, so the box can only be larger)'
    )
  }
  if (figure.caption === undefined) {
    warnings.push('caption: none found near this figure')
  } else {
    warnings.push(
      `caption: associated by proximity (${figure.captionSource}); confirm it labels this figure`
    )
  }
  return warnings
}
