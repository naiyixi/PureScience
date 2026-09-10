// Figure correctness rules engine tests: each of the seven rules fires on the right input and
// stays silent on clean panels.

import { describe, expect, it } from 'vitest'

import { reviewFigure } from './figure-review-service'
import type { FigurePanel } from '../../shared/figure'

const cleanPanel = (overrides: Partial<FigurePanel> = {}): FigurePanel => ({
  id: 'A',
  chartType: 'bar',
  dataShape: { categorical: true },
  seriesCount: 3,
  labelCount: 6,
  rendered: true,
  renderedImagePath: 'figs/panel-a.png',
  sourceScriptPath: 'scripts/panel-a.py',
  ...overrides
})

describe('figure review rules engine', () => {
  it('passes a clean single panel', () => {
    const result = reviewFigure([cleanPanel()])
    expect(result.clean).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it('flags excluded rows leaking into summary statistics (data fidelity)', () => {
    const result = reviewFigure([cleanPanel({ excludedRows: 3, summaryUsedExcluded: true })])
    expect(result.clean).toBe(false)
    const fidelity = result.violations.find((v) => v.rule === 'data_fidelity')
    expect(fidelity?.severity).toBe('error')
    expect(fidelity?.message).toContain('excluded')
  })

  it('warns when exclusions exist and a summary is mentioned but not confirmed', () => {
    const result = reviewFigure([cleanPanel({ excludedRows: 3, note: 'summary stats in text' })])
    const fidelity = result.violations.find((v) => v.rule === 'data_fidelity')
    expect(fidelity?.severity).toBe('warning')
  })

  it('does not flag exclusions that stayed out of summaries', () => {
    const result = reviewFigure([cleanPanel({ excludedRows: 3, summaryUsedExcluded: false })])
    expect(result.violations).toHaveLength(0)
  })

  it('flags missing labels (label economy)', () => {
    const result = reviewFigure([cleanPanel({ labelCount: 0, chartType: 'bar' })])
    const label = result.violations.find((v) => v.rule === 'label_economy')
    expect(label?.severity).toBe('error')
    expect(label?.message).toContain('labels')
  })

  it('warns on dense labels', () => {
    const result = reviewFigure([cleanPanel({ labelCount: 20 })])
    const label = result.violations.find((v) => v.rule === 'label_economy')
    expect(label?.severity).toBe('warning')
  })

  it('flags too many series for the palette (colour threading)', () => {
    const result = reviewFigure([cleanPanel({ seriesCount: 12 })])
    const color = result.violations.find((v) => v.rule === 'color_threading')
    expect(color?.severity).toBe('error')
    expect(color?.message).toContain('8')
  })

  it('flags a time series drawn as scatter (chart by shape)', () => {
    const result = reviewFigure([
      cleanPanel({ chartType: 'scatter', dataShape: { timeSeries: true } })
    ])
    const shape = result.violations.find((v) => v.rule === 'chart_by_shape')
    expect(shape?.severity).toBe('warning')
  })

  it('flags an unrendered panel (render verify)', () => {
    const result = reviewFigure([cleanPanel({ rendered: false })])
    const render = result.violations.find((v) => v.rule === 'render_verify')
    expect(render?.severity).toBe('error')
    expect(render?.message).toContain('render')
  })

  it('aggregates violations across panels', () => {
    const result = reviewFigure([
      cleanPanel({ id: 'A', excludedRows: 2, summaryUsedExcluded: true }),
      cleanPanel({ id: 'B', rendered: false })
    ])
    expect(result.panels).toBe(2)
    expect(result.violations).toHaveLength(2)
    expect(result.violations.map((v) => v.panelId).sort()).toEqual(['A', 'B'])
  })

  it('skips label check for heatmaps without labels', () => {
    const result = reviewFigure([cleanPanel({ chartType: 'heatmap', labelCount: 0 })])
    const label = result.violations.find((v) => v.rule === 'label_economy')
    expect(label).toBeUndefined()
  })

  it('flags a log axis carrying a non-positive or unparsable tick label', () => {
    const result = reviewFigure([
      cleanPanel({
        chartType: 'scatter',
        dataShape: { relationship: true },
        axisTicks: [{ axis: 'y', scale: 'log', labels: ['0.05', '0', '0.2'] }]
      })
    ])
    const sanity = result.violations.find((v) => v.rule === 'log_axis_sanity')
    expect(sanity?.severity).toBe('warning')
    expect(sanity?.message).toContain('"0"')
  })

  it('flags log tick labels that are not strictly increasing (the shifted-decade mislabel)', () => {
    const result = reviewFigure([
      cleanPanel({
        chartType: 'line',
        dataShape: { timeSeries: true },
        seriesCount: 1,
        axisTicks: [{ axis: 'y', scale: 'log', labels: ['0.4', '0.05', '4'] }]
      })
    ])
    const sanity = result.violations.find((v) => v.rule === 'log_axis_sanity')
    expect(sanity?.severity).toBe('warning')
    expect(sanity?.message).toContain('strictly increasing')
  })

  it('accepts a properly ordered log axis', () => {
    const result = reviewFigure([
      cleanPanel({
        chartType: 'line',
        dataShape: { timeSeries: true },
        seriesCount: 1,
        axisTicks: [{ axis: 'y', scale: 'log', labels: ['0.05', '0.5', '5'] }]
      })
    ])
    expect(result.violations.find((v) => v.rule === 'log_axis_sanity')).toBeUndefined()
  })

  it('ignores linear axes entirely for the log sanity rule', () => {
    const result = reviewFigure([
      cleanPanel({
        axisTicks: [{ axis: 'x', scale: 'linear', labels: ['0', '-1', '2'] }]
      })
    ])
    expect(result.violations.find((v) => v.rule === 'log_axis_sanity')).toBeUndefined()
  })

  it('warns when a figure ships without its .png or .py companion artifact', () => {
    const result = reviewFigure([
      cleanPanel({ renderedImagePath: undefined, sourceScriptPath: 'scripts/panel-a.py' })
    ])
    const artifact = result.violations.find((v) => v.rule === 'source_artifact')
    expect(artifact?.severity).toBe('warning')
    expect(artifact?.message).toContain('.png')
  })

  it('warns when the smallest font falls below the readability floor', () => {
    const result = reviewFigure([cleanPanel({ fontPt: 4 })])
    const artifact = result.violations.find((v) => v.rule === 'source_artifact')
    expect(artifact?.severity).toBe('warning')
    expect(artifact?.message).toContain('readability floor')
  })

  it('does not demand companion artifacts for non-data panels', () => {
    const result = reviewFigure([
      cleanPanel({
        chartType: 'other',
        renderedImagePath: undefined,
        sourceScriptPath: undefined
      })
    ])
    expect(result.violations.find((v) => v.rule === 'source_artifact')).toBeUndefined()
  })
})
