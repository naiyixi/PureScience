import { describe, expect, it } from 'vitest'

import {
  FigureDigitizationError,
  auditDigitizationForUse,
  axisResolution,
  digitizeSeries,
  formatDigitizationProvenance,
  mapPixelToValue,
  type AxisCalibration,
  type DigitizationProvenance
} from './figure-to-data'

const linearX: AxisCalibration = {
  kind: 'linear',
  anchorA: { pixel: 100, value: 0 },
  anchorB: { pixel: 500, value: 40 }
}

const linearY: AxisCalibration = {
  kind: 'linear',
  anchorA: { pixel: 400, value: 0 },
  anchorB: { pixel: 200, value: 10 }
}

const logY: AxisCalibration = {
  kind: 'log',
  anchorA: { pixel: 400, value: 0.1 },
  anchorB: { pixel: 200, value: 10 }
}

const provenance: DigitizationProvenance = {
  sourcePath: 'data/paper.pdf',
  page: 3,
  figureRef: 'Fig. 3B',
  method: 'anchor-calibration'
}

describe('figure-to-data: axis mapping', () => {
  it('interpolates linearly between anchors and extrapolates past them', () => {
    expect(mapPixelToValue(linearX, 100, 'x')).toBe(0)
    expect(mapPixelToValue(linearX, 500, 'x')).toBe(40)
    expect(mapPixelToValue(linearX, 300, 'x')).toBe(20)
    expect(mapPixelToValue(linearX, 600, 'x')).toBe(50)
  })

  it('interpolates logarithmically on a log axis', () => {
    // 0.1 at pixel 400, 10 at pixel 200 → the midpoint is 1 (geometric mean).
    expect(mapPixelToValue(logY, 300, 'y')).toBeCloseTo(1, 10)
    expect(mapPixelToValue(logY, 400, 'y')).toBeCloseTo(0.1, 10)
    expect(mapPixelToValue(logY, 200, 'y')).toBeCloseTo(10, 10)
  })

  it('rejects degenerate calibrations instead of guessing', () => {
    expect(() =>
      mapPixelToValue(
        { kind: 'linear', anchorA: { pixel: 10, value: 0 }, anchorB: { pixel: 10, value: 5 } },
        10,
        'x'
      )
    ).toThrow(FigureDigitizationError)
    expect(() =>
      mapPixelToValue(
        { kind: 'linear', anchorA: { pixel: 10, value: 3 }, anchorB: { pixel: 20, value: 3 } },
        10,
        'x'
      )
    ).toThrow(/degenerate/)
    expect(() =>
      mapPixelToValue(
        { kind: 'log', anchorA: { pixel: 10, value: 0 }, anchorB: { pixel: 20, value: 10 } },
        10,
        'y'
      )
    ).toThrow(/positive/)
  })

  it('reports resolution from the anchor spacing', () => {
    expect(axisResolution(linearX, 'x')).toBeCloseTo(40 / 400, 10)
    // One pixel on this log axis spans two decades over 200 px.
    const perPixelDecades = 2 / 200
    expect(axisResolution(logY, 'y')).toBeCloseTo(0.1 * (10 ** perPixelDecades - 1), 10)
  })
})

describe('figure-to-data: digitisation and G5 provenance', () => {
  it('converts picks into values and always marks them estimated and review-bound', () => {
    const result = digitizeSeries({
      provenance,
      xAxis: linearX,
      yAxis: linearY,
      picks: [
        { x: 300, y: 300 },
        { x: 500, y: 200 }
      ]
    })

    expect(result.points[0]).toEqual({ x: 20, y: 5, pixel: { x: 300, y: 300 } })
    expect(result.points[1]).toEqual({ x: 40, y: 10, pixel: { x: 500, y: 200 } })
    expect(result.estimated).toBe(true)
    expect(result.requiresReview).toBe(true)
    expect(result.notes).toEqual([])
  })

  it('refuses to produce anything from zero picks', () => {
    expect(() => digitizeSeries({ provenance, xAxis: linearX, yAxis: linearY, picks: [] })).toThrow(
      /no picks/
    )
  })

  it('states source, method, resolution and the estimated/review status in the provenance text', () => {
    const result = digitizeSeries({
      provenance: { ...provenance, method: 'model-fit', methodDetail: 'plot2data-v0' },
      xAxis: linearX,
      yAxis: logY,
      picks: [{ x: 300, y: 300 }],
      notes: ['误差棒未提取']
    })
    const text = formatDigitizationProvenance(result)
    expect(text).toContain('data/paper.pdf 第 3 页 Fig. 3B')
    expect(text).toContain('图回归估计，非原始测量')
    expect(text).toContain('model-fit (plot2data-v0)')
    expect(text).toContain('estimated · 需审查')
    expect(text).toContain('误差棒未提取')
  })

  it('audits the G5 invariants before a value can be used outside review', () => {
    const good = digitizeSeries({
      provenance,
      xAxis: linearX,
      yAxis: linearY,
      picks: [{ x: 300, y: 300 }]
    })
    expect(auditDigitizationForUse(good)).toEqual([])

    const noSource = {
      ...good,
      provenance: { ...provenance, sourcePath: '  ' }
    }
    expect(auditDigitizationForUse(noSource)).toContain('缺少来源文件')

    const noPage = { ...good, provenance: { ...provenance, page: 0 } }
    expect(auditDigitizationForUse(noPage)).toContain('缺少有效页码')

    expect(auditDigitizationForUse({ ...good, points: [] })).toContain('没有任何数据点')
  })
})
