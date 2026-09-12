// Figure-to-Data (v1.55 unit 1): the deterministic half of digitising a plot — mapping pixel
// coordinates to data values through axis anchors — plus the provenance contract that keeps the
// output honest (G5):
//   * every extracted value is 'estimated', never presented as an original measurement;
//   * the source (file, page, figure reference) and the fit/calibration method travel with it;
//   * the uncertainty implied by the anchor spacing is reported rather than hidden;
//   * the output is routed to review by default, not straight into a manuscript.
// Pixel picking (by the user or a vision model) is an input; this module never invents pixels.

export type AxisScaleKind = 'linear' | 'log'

export type AxisAnchor = {
  /** Pixel coordinate along the axis, in the source image's coordinate space. */
  pixel: number
  /** The data value that pixel corresponds to (read off the axis label). */
  value: number
}

export type AxisCalibration = {
  kind: AxisScaleKind
  anchorA: AxisAnchor
  anchorB: AxisAnchor
}

export type DigitizationProvenance = {
  /** Where the figure came from: the PDF/managed file path. */
  sourcePath: string
  /** 1-based page number in the source. */
  page: number
  /** Figure/panel reference as printed (e.g. 'Fig. 3B'). */
  figureRef?: string
  /** How the mapping was obtained. */
  method: 'anchor-calibration' | 'model-fit'
  /** Model identity when method is 'model-fit'. */
  methodDetail?: string
}

export type DigitizedPoint = {
  x: number
  y: number
  /** Pixel position the value came from, so a reviewer can re-check it. */
  pixel: { x: number; y: number }
}

export type FigureDigitizationResult = {
  provenance: DigitizationProvenance
  points: DigitizedPoint[]
  /** Always true: these numbers were read off a picture, not measured. */
  estimated: true
  /** G5: the output belongs in review before it is used anywhere else. */
  requiresReview: true
  /** Smallest resolvable step implied by the anchors, per axis. */
  resolution: { x: number; y: number }
  notes: string[]
}

export class FigureDigitizationError extends Error {}

const assertCalibration = (calibration: AxisCalibration, axis: 'x' | 'y'): void => {
  const { anchorA, anchorB, kind } = calibration
  if (anchorA.pixel === anchorB.pixel) {
    throw new FigureDigitizationError(
      `${axis}-axis anchors share the same pixel; pick two distinct ticks`
    )
  }
  if (anchorA.value === anchorB.value) {
    throw new FigureDigitizationError(
      `${axis}-axis anchors share the same value; the calibration is degenerate`
    )
  }
  if (kind === 'log') {
    if (anchorA.value <= 0 || anchorB.value <= 0) {
      throw new FigureDigitizationError(
        `${axis}-axis is logarithmic: anchor values must be positive`
      )
    }
  }
}

export const mapPixelToValue = (
  calibration: AxisCalibration,
  pixel: number,
  axis: 'x' | 'y'
): number => {
  assertCalibration(calibration, axis)
  const { anchorA, anchorB, kind } = calibration
  const span = anchorB.pixel - anchorA.pixel
  const fraction = (pixel - anchorA.pixel) / span
  if (kind === 'linear') {
    return anchorA.value + fraction * (anchorB.value - anchorA.value)
  }
  const logA = Math.log10(anchorA.value)
  const logB = Math.log10(anchorB.value)
  return 10 ** (logA + fraction * (logB - logA))
}

export const axisResolution = (calibration: AxisCalibration, axis: 'x' | 'y'): number => {
  assertCalibration(calibration, axis)
  const { anchorA, anchorB, kind } = calibration
  const pixelSpan = Math.abs(anchorB.pixel - anchorA.pixel)
  if (kind === 'linear') {
    return Math.abs(anchorB.value - anchorA.value) / pixelSpan
  }
  // On a log axis one pixel is a constant factor; report the value step at the smaller anchor.
  const smaller = Math.min(Math.abs(anchorA.value), Math.abs(anchorB.value))
  const decades = Math.abs(Math.log10(anchorB.value) - Math.log10(anchorA.value))
  const decadesPerPixel = decades / pixelSpan
  return smaller * (10 ** decadesPerPixel - 1)
}

export const digitizeSeries = (input: {
  provenance: DigitizationProvenance
  xAxis: AxisCalibration
  yAxis: AxisCalibration
  /** Points picked in the image (pixels); the caller supplies them, this module only converts. */
  picks: { x: number; y: number }[]
  /** Extra honesty notes from the caller (e.g. 'error bars not digitised'). */
  notes?: string[]
}): FigureDigitizationResult => {
  if (input.picks.length === 0) {
    throw new FigureDigitizationError('no picks supplied; nothing to digitise')
  }
  const points = input.picks.map((pick) => ({
    x: mapPixelToValue(input.xAxis, pick.x, 'x'),
    y: mapPixelToValue(input.yAxis, pick.y, 'y'),
    pixel: { x: pick.x, y: pick.y }
  }))
  return {
    provenance: input.provenance,
    points,
    estimated: true,
    requiresReview: true,
    resolution: {
      x: axisResolution(input.xAxis, 'x'),
      y: axisResolution(input.yAxis, 'y')
    },
    notes: input.notes ?? []
  }
}

const formatNumber = (value: number): string =>
  Math.abs(value) >= 1000 || (Math.abs(value) < 0.01 && value !== 0)
    ? value.toExponential(3)
    : Number(value.toFixed(4)).toString()

// Rendered next to (or instead of) any table produced from the extraction: the numbers are only
// usable when this text accompanies them.
export const formatDigitizationProvenance = (result: FigureDigitizationResult): string => {
  const ref = result.provenance.figureRef ? ` ${result.provenance.figureRef}` : ''
  const method =
    result.provenance.method === 'model-fit'
      ? `model-fit${result.provenance.methodDetail ? ` (${result.provenance.methodDetail})` : ''}`
      : 'anchor-calibration'
  const lines = [
    `数据来源：${result.provenance.sourcePath} 第 ${result.provenance.page} 页${ref}（图回归估计，非原始测量）`,
    `提取方式：${method}`,
    `标定分辨率：x ±${formatNumber(result.resolution.x)}，y ±${formatNumber(result.resolution.y)}（受锚点像素间距限制）`,
    `状态：estimated · 需审查（不得直接进入正文，先进审查 Finding）`
  ]
  if (result.notes.length > 0) {
    lines.push(`注意事项：${result.notes.join('；')}`)
  }
  return lines.join('\n')
}

// G5 guard: a value is only admissible outside review when it is (and is labelled) estimated AND
// carries its source. Returns the problems that block such use.
export const auditDigitizationForUse = (result: FigureDigitizationResult): string[] => {
  const problems: string[] = []
  if (result.estimated !== true) problems.push('结果未标记为 estimated')
  if (!result.provenance.sourcePath?.trim()) problems.push('缺少来源文件')
  if (!Number.isFinite(result.provenance.page) || result.provenance.page < 1) {
    problems.push('缺少有效页码')
  }
  if (result.points.length === 0) problems.push('没有任何数据点')
  if (result.requiresReview !== true) problems.push('未路由到审查')
  return problems
}
