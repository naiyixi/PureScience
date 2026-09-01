// Shared identity + prompt contract for the agent-facing figure-review MCP server. This is the
// "publication-grade figure pipeline" capability: a pure-rule correctness checklist for
// scientific figures, mirroring the reference product's figure-style skill (§1-3,8,9 are
// correctness rules with no aesthetic content, applicable everywhere). The agent describes each
// panel of a figure; figure_review runs the five correctness checks and returns violations —
// data fidelity (excluded rows must not leak into summary statistics), label economy, colour
// threading, chart-by-data-shape, and a render-then-verify self-check. Pure rules, no external
// model, fully testable.

export const FIGURE_MCP_SERVER_NAME = 'purescience-figure'

export const FIGURE_REVIEW_TOOL_NAME = 'figure_review'

export const FIGURE_REVIEW_TOOL_DESCRIPTION =
  'Reviews a scientific figure against the publication-grade correctness checklist (no ' +
  'aesthetic judgment). Pass the panels of the figure as structured descriptions; the check ' +
  'returns violations per panel. Five checks: (1) DATA FIDELITY — rows you excluded must not ' +
  'leak into summary statistics (tell the engine whether the summary used excluded data); ' +
  '(2) LABEL ECONOMY — every axis/series must be labeled, and labels must not be so dense they ' +
  'collide; (3) COLOUR THREADING — the same category must carry the same colour across panels ' +
  'and the palette must stay small enough to distinguish; (4) CHART BY DATA SHAPE — the chart ' +
  'type must fit the data (time series → line, categorical comparison → bar, distribution → ' +
  'histogram/box, relationship → scatter); (5) RENDER VERIFY — the figure must be rendered and ' +
  'each panel visually inspected before it is considered done. Run this before finalizing any ' +
  'figure; fix the violations and re-run.'

// The five correctness rules (stable ids for structured results).
export const FIGURE_RULE_DATA_FIDELITY = 'data_fidelity'
export const FIGURE_RULE_LABEL_ECONOMY = 'label_economy'
export const FIGURE_RULE_COLOR_THREADING = 'color_threading'
export const FIGURE_RULE_CHART_BY_SHAPE = 'chart_by_shape'
export const FIGURE_RULE_RENDER_VERIFY = 'render_verify'

export const FIGURE_RULES = [
  FIGURE_RULE_DATA_FIDELITY,
  FIGURE_RULE_LABEL_ECONOMY,
  FIGURE_RULE_COLOR_THREADING,
  FIGURE_RULE_CHART_BY_SHAPE,
  FIGURE_RULE_RENDER_VERIFY
] as const
export type FigureRule = (typeof FIGURE_RULES)[number]

// Hard bounds used by the label/colour heuristics.
export const FIGURE_MAX_SERIES_COLORS = 8
export const FIGURE_MAX_LABELS_PER_AXIS = 12

// A structured description of one panel of a figure.
export type FigurePanel = {
  // Stable panel id (e.g. "A", "B", "a").
  id: string
  // Short title ("Survival by treatment").
  title?: string
  // Chart type: line, bar, scatter, histogram, box, heatmap, other.
  chartType: 'line' | 'bar' | 'scatter' | 'histogram' | 'box' | 'heatmap' | 'other'
  // Data shape hints used by the chart-by-shape check.
  dataShape: {
    // True when the x-axis is time/ordered.
    timeSeries?: boolean
    // True when the primary comparison is between categories.
    categorical?: boolean
    // True when the panel shows a distribution.
    distribution?: boolean
    // True when the panel shows a relationship between two continuous variables.
    relationship?: boolean
  }
  // Number of distinct series/conditions drawn (for the colour check).
  seriesCount?: number
  // How many axis/legend labels the panel shows (for the label check).
  labelCount?: number
  // DATA FIDELITY: number of rows that were EXCLUDED from the panel.
  excludedRows?: number
  // DATA FIDELITY: set true when the panel's summary statistics (means, counts, %s) were
  // computed over a dataset that still contained the excluded rows.
  summaryUsedExcluded?: boolean
  // RENDER VERIFY: set true once the panel has actually been rendered and inspected.
  rendered?: boolean
  // Free-form note (e.g. "log scale", "n=12 per group").
  note?: string
}

export type FigureReviewRequest = {
  // Optional figure-level note (e.g. the paper's figure number).
  figureNote?: string
  panels: FigurePanel[]
}

export type FigureViolation = {
  rule: FigureRule
  panelId: string
  severity: 'error' | 'warning'
  message: string
}

export type FigureReviewResult = {
  panels: number
  violations: FigureViolation[]
  // True when no violations (each panel passes every rule it can be evaluated on).
  clean: boolean
}

// Rendered into the session prompt when the figure MCP is available.
export const FIGURE_MCP_SYSTEM_PROMPT_APPEND = [
  '<purescience_figure_instructions>',
  'Before finalizing ANY scientific figure, run figure_review with the panels described ' +
    'structurally (chart type, data shape, series count, labels, excluded rows, whether ' +
    'summaries used excluded data, whether it was rendered).',
  'The five correctness checks are rules, not taste: (1) excluded rows must not leak into ' +
    'summary statistics; (2) axes/series need labels and labels must not collide; (3) the same ' +
    'category keeps the same colour across panels and the palette stays distinguishable; ' +
    '(4) chart type fits the data shape (time → line, categorical comparison → bar, ' +
    'distribution → histogram/box, relationship → scatter); (5) render and visually inspect ' +
    'each panel.',
  'Fix every error-severity violation and re-run figure_review before declaring a figure ' +
    'done; warnings are judgment calls but should be resolved deliberately.',
  '</purescience_figure_instructions>'
].join('\n')
