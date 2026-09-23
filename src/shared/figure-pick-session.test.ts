import { describe, expect, it } from 'vitest'

import { FigureDigitizationError, type DigitizationProvenance } from './figure-to-data'
import {
  addAnchor,
  addPick,
  buildDigitization,
  canPickPoints,
  startPickSession,
  toDigitizationCsv,
  undoPick,
  type PickSessionState
} from './figure-pick-session'

const provenance: DigitizationProvenance = {
  sourcePath: 'data/paper.pdf',
  page: 4,
  figureRef: 'Fig. 4A',
  method: 'anchor-calibration'
}

const calibrated = (): PickSessionState => {
  let state = startPickSession()
  expect(state.phase).toBe('anchors-x')
  state = addAnchor(state, 'x', { pixel: 100, value: 0 })
  expect(state.phase).toBe('anchors-x')
  state = addAnchor(state, 'x', { pixel: 500, value: 40 })
  expect(state.phase).toBe('anchors-y')
  state = addAnchor(state, 'y', { pixel: 400, value: 0 })
  state = addAnchor(state, 'y', { pixel: 200, value: 10 })
  expect(state.phase).toBe('picking')
  return state
}

describe('figure pick session', () => {
  it('walks the phases in order and only then allows picking', () => {
    let state = startPickSession()
    expect(canPickPoints(state)).toBe(false)

    state = addAnchor(state, 'x', { pixel: 100, value: 0 })
    expect(() => addAnchor(state, 'y', { pixel: 400, value: 0 })).toThrow(
      /Calibrate both x-axis anchors first/
    )
    expect(() => addPick(state, { x: 10, y: 10 })).toThrow(/Calibration is incomplete/)

    state = addAnchor(state, 'x', { pixel: 500, value: 40 })
    state = addAnchor(state, 'y', { pixel: 400, value: 0 })
    state = addAnchor(state, 'y', { pixel: 200, value: 10 })
    expect(canPickPoints(state)).toBe(true)
  })

  it('rejects duplicate anchors and malformed coordinates instead of guessing', () => {
    const state = addAnchor(startPickSession(), 'x', { pixel: 100, value: 0 })
    expect(() => addAnchor(state, 'x', { pixel: 100, value: 5 })).toThrow(/cannot share a pixel/)
    expect(() => addAnchor(state, 'x', { pixel: Number.NaN, value: 5 })).toThrow(
      FigureDigitizationError
    )
    const picking = ['x', 'x', 'y', 'y'].reduce(
      (acc, axis, index) =>
        addAnchor(acc, axis as 'x' | 'y', { pixel: 100 + index * 100, value: index }),
      startPickSession()
    )
    expect(() => addPick(picking, { x: Number.POSITIVE_INFINITY, y: 1 })).toThrow(/must be finite/)
  })

  it('refuses to digitise before both axes are calibrated', () => {
    const state = addAnchor(startPickSession(), 'x', { pixel: 100, value: 0 })
    expect(() => buildDigitization(state, provenance)).toThrow(/Calibration is incomplete/)
  })

  it('digitises picked points and supports undo', () => {
    let state = calibrated()
    expect(() => undoPick(state)).not.toThrow()

    state = addPick(state, { x: 300, y: 300 })
    state = addPick(state, { x: 500, y: 200 })
    expect(state.phase).toBe('ready')

    const result = buildDigitization(state, provenance)
    expect(result.points).toHaveLength(2)
    expect(result.points[0]).toEqual({ x: 20, y: 5, pixel: { x: 300, y: 300 } })

    state = undoPick(state)
    expect(state.picks).toHaveLength(1)
    expect(state.phase).toBe('ready')
    expect(buildDigitization(state, provenance).points).toHaveLength(1)
  })

  it('exports CSV that carries the estimation provenance and the audit verdict', () => {
    let state = calibrated()
    state = addPick(state, { x: 300, y: 300 })
    const csv = toDigitizationCsv(buildDigitization(state, provenance))

    expect(csv).toContain('# source: data/paper.pdf page 4 Fig. 4A')
    expect(csv).toContain('# status: estimated · needs review')
    expect(csv).toContain('# audit: passed (still needs review before use)')
    expect(csv).toContain('x,y,pixel_x,pixel_y')
    expect(csv).toContain('20,5,300,300')
  })

  it('marks a CSV as unusable when the provenance is incomplete', () => {
    let state = calibrated()
    state = addPick(state, { x: 300, y: 300 })
    const csv = toDigitizationCsv(
      buildDigitization(state, { ...provenance, sourcePath: '', page: 0 })
    )
    expect(csv).toContain('# audit: unusable')
    expect(csv).toContain('missing source file')
    expect(csv).toContain('missing a valid page number')
  })
})
