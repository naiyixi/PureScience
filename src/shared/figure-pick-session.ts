// Figure digitisation session (v1.55 unit 3): the interaction state machine behind the picking UI,
// kept out of React so the rules are testable and the UI stays a thin shell.
//
// Flow: pick two x-axis anchors (pixel + value) → two y-axis anchors → pick data points → export.
// The session refuses to move on with a degenerate calibration, so the UI can never digitise from
// anchors that cannot define a scale. Exported CSV always carries the estimation provenance (G5).

import {
  FigureDigitizationError,
  auditDigitizationForUse,
  digitizeSeries,
  formatDigitizationProvenance,
  type AxisAnchor,
  type AxisScaleKind,
  type DigitizationProvenance,
  type FigureDigitizationResult
} from './figure-to-data'

export type PickSessionPhase = 'anchors-x' | 'anchors-y' | 'picking' | 'ready'

export type PickSessionState = {
  phase: PickSessionPhase
  xScale: AxisScaleKind
  yScale: AxisScaleKind
  xAnchors: AxisAnchor[]
  yAnchors: AxisAnchor[]
  picks: { x: number; y: number }[]
}

export const ANCHORS_PER_AXIS = 2

export const startPickSession = (
  options: { xScale?: AxisScaleKind; yScale?: AxisScaleKind } = {}
): PickSessionState => ({
  phase: 'anchors-x',
  xScale: options.xScale ?? 'linear',
  yScale: options.yScale ?? 'linear',
  xAnchors: [],
  yAnchors: [],
  picks: []
})

const validateAnchor = (anchor: AxisAnchor, existing: AxisAnchor[], axis: 'x' | 'y'): void => {
  if (!Number.isFinite(anchor.pixel) || !Number.isFinite(anchor.value)) {
    throw new FigureDigitizationError(
      `${axis}-axis anchor pixel and value must both be finite`,
      'figure.errorFiniteAnchor'
    )
  }
  if (existing.some((entry) => entry.pixel === anchor.pixel)) {
    throw new FigureDigitizationError(
      `${axis}-axis anchors cannot share a pixel`,
      'figure.errorDuplicateAnchor'
    )
  }
}

export const addAnchor = (
  state: PickSessionState,
  axis: 'x' | 'y',
  anchor: AxisAnchor
): PickSessionState => {
  if (axis === 'x') {
    if (state.phase !== 'anchors-x') {
      throw new FigureDigitizationError(
        'The x axis already has both anchors',
        'figure.errorAxisComplete'
      )
    }
    validateAnchor(anchor, state.xAnchors, 'x')
    const xAnchors = [...state.xAnchors, anchor]
    return {
      ...state,
      xAnchors,
      phase: xAnchors.length >= ANCHORS_PER_AXIS ? 'anchors-y' : 'anchors-x'
    }
  }

  if (state.phase !== 'anchors-y') {
    throw new FigureDigitizationError(
      'Calibrate both x-axis anchors first',
      'figure.errorNeedXAnchors'
    )
  }
  validateAnchor(anchor, state.yAnchors, 'y')
  const yAnchors = [...state.yAnchors, anchor]
  return {
    ...state,
    yAnchors,
    phase: yAnchors.length >= ANCHORS_PER_AXIS ? 'picking' : 'anchors-y'
  }
}

export const canPickPoints = (state: PickSessionState): boolean =>
  state.phase === 'picking' || state.phase === 'ready'

export const addPick = (
  state: PickSessionState,
  point: { x: number; y: number }
): PickSessionState => {
  if (!canPickPoints(state)) {
    throw new FigureDigitizationError(
      'Calibration is incomplete: two anchors per axis are required',
      'figure.errorCalibrationIncomplete'
    )
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new FigureDigitizationError(
      'Data point coordinates must be finite',
      'figure.errorPointFinite'
    )
  }
  return { ...state, picks: [...state.picks, point], phase: 'ready' }
}

export const undoPick = (state: PickSessionState): PickSessionState => {
  if (state.picks.length === 0) return state
  const picks = state.picks.slice(0, -1)
  return { ...state, picks, phase: picks.length === 0 ? 'picking' : 'ready' }
}

export const buildDigitization = (
  state: PickSessionState,
  provenance: DigitizationProvenance
): FigureDigitizationResult => {
  if (state.xAnchors.length < ANCHORS_PER_AXIS || state.yAnchors.length < ANCHORS_PER_AXIS) {
    throw new FigureDigitizationError(
      'Calibration is incomplete: x and y need two anchors each',
      'figure.errorAnchorsRequired'
    )
  }
  return digitizeSeries({
    provenance,
    xAxis: { kind: state.xScale, anchorA: state.xAnchors[0], anchorB: state.xAnchors[1] },
    yAxis: { kind: state.yScale, anchorA: state.yAnchors[0], anchorB: state.yAnchors[1] },
    picks: state.picks
  })
}

const csvValue = (value: number): string => {
  const rounded = Number(value.toPrecision(10))
  return Number.isFinite(rounded) ? String(rounded) : ''
}

// CSV that cannot be mistaken for raw measurements: the first lines carry the provenance, and the
// audit result is embedded so a downstream reader sees whether the file is admissible at all.
export const toDigitizationCsv = (result: FigureDigitizationResult): string => {
  const header = `# ${formatDigitizationProvenance(result).split('\n').join('\n# ')}`
  const problems = auditDigitizationForUse(result)
  const auditLine =
    problems.length === 0
      ? '# audit: passed (still needs review before use)'
      : `# audit: unusable — ${problems.join('; ')}`
  const rows = result.points.map(
    (point) => `${csvValue(point.x)},${csvValue(point.y)},${point.pixel.x},${point.pixel.y}`
  )
  return [header, auditLine, 'x,y,pixel_x,pixel_y', ...rows, ''].join('\n')
}
