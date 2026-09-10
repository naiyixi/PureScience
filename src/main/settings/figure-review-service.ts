// Figure correctness rules engine: the pure-logic core behind figure_review. Seven rules with
// no aesthetic content (mirrors the reference figure-style skill's correctness section):
// data fidelity (excluded rows must not leak into summary statistics), label economy, colour
// threading, chart-by-data-shape, render-then-verify, log-axis tick sanity, and source-artifact
// discipline (figure ships with its plotting script, readable font floor). Deterministic and
// fully testable.

import type { FigurePanel, FigureReviewResult, FigureViolation } from '../../shared/figure'
import {
  FIGURE_MAX_LABELS_PER_AXIS,
  FIGURE_MAX_SERIES_COLORS,
  FIGURE_MIN_FONT_PT,
  FIGURE_RULE_CHART_BY_SHAPE,
  FIGURE_RULE_COLOR_THREADING,
  FIGURE_RULE_DATA_FIDELITY,
  FIGURE_RULE_LABEL_ECONOMY,
  FIGURE_RULE_LOG_AXIS_SANITY,
  FIGURE_RULE_RENDER_VERIFY,
  FIGURE_RULE_SOURCE_ARTIFACT
} from '../../shared/figure'

export const reviewFigure = (panels: FigurePanel[], _figureNote?: string): FigureReviewResult => {
  const violations: FigureViolation[] = []
  for (const panel of panels) {
    violations.push(...checkDataFidelity(panel))
    violations.push(...checkLabelEconomy(panel))
    violations.push(...checkColorThreading(panel))
    violations.push(...checkChartByShape(panel))
    violations.push(...checkRenderVerify(panel))
    violations.push(...checkLogAxisSanity(panel))
    violations.push(...checkSourceArtifact(panel))
  }
  return {
    panels: panels.length,
    violations,
    clean: violations.length === 0
  }
}

// Rule 1: rows excluded from a panel must not leak into its summary statistics.
const checkDataFidelity = (panel: FigurePanel): FigureViolation[] => {
  const violations: FigureViolation[] = []
  const excluded = panel.excludedRows ?? 0
  if (excluded > 0 && panel.summaryUsedExcluded) {
    violations.push({
      rule: FIGURE_RULE_DATA_FIDELITY,
      panelId: panel.id,
      severity: 'error',
      message: `Panel ${panel.id}: ${excluded} excluded row(s) were still included in the summary statistics — excluded data must never feed means/counts/percentages.`
    })
  }
  if (
    excluded > 0 &&
    panel.summaryUsedExcluded === undefined &&
    panel.note?.toLowerCase().includes('summary')
  ) {
    violations.push({
      rule: FIGURE_RULE_DATA_FIDELITY,
      panelId: panel.id,
      severity: 'warning',
      message: `Panel ${panel.id}: ${excluded} row(s) excluded and a summary is mentioned — confirm the summary excludes them (set summary_used_excluded=false to clear).`
    })
  }
  return violations
}

// Rule 2: axes/series need labels, and labels must stay sparse enough not to collide.
const checkLabelEconomy = (panel: FigurePanel): FigureViolation[] => {
  const violations: FigureViolation[] = []
  const labels = panel.labelCount ?? 0
  if (labels === 0 && panel.chartType !== 'heatmap') {
    violations.push({
      rule: FIGURE_RULE_LABEL_ECONOMY,
      panelId: panel.id,
      severity: 'error',
      message: `Panel ${panel.id}: no labels reported — every axis and series must carry a label.`
    })
  }
  if (labels > FIGURE_MAX_LABELS_PER_AXIS) {
    violations.push({
      rule: FIGURE_RULE_LABEL_ECONOMY,
      panelId: panel.id,
      severity: 'warning',
      message: `Panel ${panel.id}: ${labels} labels is dense (cap ~${FIGURE_MAX_LABELS_PER_AXIS}) — rotate, abbreviate, or move to a legend to avoid collisions.`
    })
  }
  return violations
}

// Rule 3: the same category keeps the same colour; palettes stay small enough to distinguish.
const checkColorThreading = (panel: FigurePanel): FigureViolation[] => {
  const violations: FigureViolation[] = []
  const series = panel.seriesCount ?? 0
  if (series > FIGURE_MAX_SERIES_COLORS) {
    violations.push({
      rule: FIGURE_RULE_COLOR_THREADING,
      panelId: panel.id,
      severity: 'error',
      message: `Panel ${panel.id}: ${series} series exceeds ${FIGURE_MAX_SERIES_COLORS} — distinct hues above ~8 are indistinguishable; group or facet instead.`
    })
  }
  if (
    series > 1 &&
    panel.chartType === 'line' &&
    panel.dataShape.timeSeries &&
    panel.note?.toLowerCase().includes('same colour')
  ) {
    violations.push({
      rule: FIGURE_RULE_COLOR_THREADING,
      panelId: panel.id,
      severity: 'warning',
      message: `Panel ${panel.id}: note mentions shared colours across panels — verify the same category actually maps to the same hue everywhere.`
    })
  }
  return violations
}

// Rule 4: chart type must fit the data shape.
const checkChartByShape = (panel: FigurePanel): FigureViolation[] => {
  const violations: FigureViolation[] = []
  const { timeSeries, categorical, distribution, relationship } = panel.dataShape

  if (timeSeries && panel.chartType !== 'line' && panel.chartType !== 'bar') {
    violations.push({
      rule: FIGURE_RULE_CHART_BY_SHAPE,
      panelId: panel.id,
      severity: 'warning',
      message: `Panel ${panel.id}: data is a time series but drawn as ${panel.chartType} — a line (or bar for discrete intervals) shows the ordering best.`
    })
  }
  if (categorical && !['bar', 'box', 'heatmap'].includes(panel.chartType)) {
    violations.push({
      rule: FIGURE_RULE_CHART_BY_SHAPE,
      panelId: panel.id,
      severity: 'warning',
      message: `Panel ${panel.id}: categorical comparison drawn as ${panel.chartType} — bars (or box/heatmap for distributions across categories) fit better.`
    })
  }
  if (distribution && panel.chartType !== 'histogram' && panel.chartType !== 'box') {
    violations.push({
      rule: FIGURE_RULE_CHART_BY_SHAPE,
      panelId: panel.id,
      severity: 'warning',
      message: `Panel ${panel.id}: distribution data drawn as ${panel.chartType} — a histogram or box plot shows the shape.`
    })
  }
  if (relationship && panel.chartType !== 'scatter') {
    violations.push({
      rule: FIGURE_RULE_CHART_BY_SHAPE,
      panelId: panel.id,
      severity: 'warning',
      message: `Panel ${panel.id}: relationship between continuous variables drawn as ${panel.chartType} — a scatter (with trend) shows it best.`
    })
  }
  return violations
}

// Rule 5: render and visually inspect before done.
const checkRenderVerify = (panel: FigurePanel): FigureViolation[] => {
  if (panel.rendered) return []
  return [
    {
      rule: FIGURE_RULE_RENDER_VERIFY,
      panelId: panel.id,
      severity: 'error',
      message: `Panel ${panel.id}: not rendered/verified — render the figure and visually inspect each panel (overlaps, clipped labels, cutoff bars) before finalizing.`
    }
  ]
}

// Rule 6: declared log-scale tick labels must be positive numbers in strict order, so a
// mislabeled decade (annotating 0.05 where the value is 0.4) is caught before publication.
const checkLogAxisSanity = (panel: FigurePanel): FigureViolation[] => {
  const violations: FigureViolation[] = []
  for (const ticks of panel.axisTicks ?? []) {
    if (ticks.scale !== 'log' || ticks.labels.length === 0) continue
    const parsed = ticks.labels.map((label) => Number.parseFloat(label.replace(/,/g, '').trim()))
    const invalid = ticks.labels.filter(
      (_, index) => !Number.isFinite(parsed[index]) || parsed[index] <= 0
    )
    if (invalid.length > 0) {
      violations.push({
        rule: FIGURE_RULE_LOG_AXIS_SANITY,
        panelId: panel.id,
        severity: 'warning',
        message: `Panel ${panel.id}: ${ticks.axis}-axis is log-scale but tick label(s) ${invalid
          .map((label) => `"${label}"`)
          .join(
            ', '
          )} are not positive numbers — a log axis can never carry zero, negative, or mislabeled ticks.`
      })
      continue
    }
    const ordered = parsed.every((value, index) => index === 0 || value > parsed[index - 1])
    if (!ordered) {
      violations.push({
        rule: FIGURE_RULE_LOG_AXIS_SANITY,
        panelId: panel.id,
        severity: 'warning',
        message: `Panel ${panel.id}: ${ticks.axis}-axis log tick labels are not in strictly increasing order (${ticks.labels.join(
          ' < '
        )}) — re-check the tick values before shipping; a shifted label reads as wrong data.`
      })
    }
  }
  return violations
}

// Rule 7: every shipped figure keeps both the rendered image and the script that produced it,
// and stays legible at column width.
const checkSourceArtifact = (panel: FigurePanel): FigureViolation[] => {
  const violations: FigureViolation[] = []
  if (panel.chartType !== 'other') {
    const missing: string[] = []
    if (!panel.renderedImagePath?.trim()) missing.push('.png image path (rendered_image_path)')
    if (!panel.sourceScriptPath?.trim()) missing.push('.py source path (source_script_path)')
    if (missing.length > 0) {
      violations.push({
        rule: FIGURE_RULE_SOURCE_ARTIFACT,
        panelId: panel.id,
        severity: 'warning',
        message: `Panel ${panel.id}: figure is missing ${missing.join(
          ' and '
        )} — every shipped figure keeps its image and the plotting script together so the plot stays reproducible.`
      })
    }
  }
  if (panel.fontPt !== undefined && panel.fontPt > 0 && panel.fontPt < FIGURE_MIN_FONT_PT) {
    violations.push({
      rule: FIGURE_RULE_SOURCE_ARTIFACT,
      panelId: panel.id,
      severity: 'warning',
      message: `Panel ${panel.id}: smallest font ${panel.fontPt}pt is below the ~${FIGURE_MIN_FONT_PT}pt readability floor — raise the base font (rcParams['font.size']) before shipping.`
    })
  }
  return violations
}
