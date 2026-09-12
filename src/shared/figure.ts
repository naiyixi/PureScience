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
  'returns violations per panel. Seven checks: (1) DATA FIDELITY — rows you excluded must not ' +
  'leak into summary statistics (tell the engine whether the summary used excluded data); ' +
  '(2) LABEL ECONOMY — every axis/series must be labeled, and labels must not be so dense they ' +
  'collide; (3) COLOUR THREADING — the same category must carry the same colour across panels ' +
  'and the palette must stay small enough to distinguish; (4) CHART BY DATA SHAPE — the chart ' +
  'type must fit the data (time series → line, categorical comparison → bar, distribution → ' +
  'histogram/box, relationship → scatter); (5) RENDER VERIFY — the figure must be rendered and ' +
  'each panel visually inspected before it is considered done; (6) LOG AXIS SANITY — declared ' +
  'log-scale tick labels must be positive numbers in strict order (a decade axis annotated ' +
  '"0.05" where the value is "0.4" fails here); (7) SOURCE ARTIFACT — every shipped figure keeps ' +
  'both its image (.png) and the script (.py) that produced it, and text no smaller than ~6pt. ' +
  'Run this before finalizing any figure; fix the violations and re-run. ' +
  'Pass the evidence for checks 6 and 7 IN THE ARGUMENTS — the engine only sees what you ' +
  'send: `axis_ticks` (per-axis declared tick labels) for check 6, and `rendered_image_path` + ' +
  '`source_script_path` + `font_pt` for check 7. Describing them only in prose does not reach ' +
  'the engine.'

// The seven correctness rules (stable ids for structured results).
export const FIGURE_RULE_DATA_FIDELITY = 'data_fidelity'
export const FIGURE_RULE_LABEL_ECONOMY = 'label_economy'
export const FIGURE_RULE_COLOR_THREADING = 'color_threading'
export const FIGURE_RULE_CHART_BY_SHAPE = 'chart_by_shape'
export const FIGURE_RULE_RENDER_VERIFY = 'render_verify'
export const FIGURE_RULE_LOG_AXIS_SANITY = 'log_axis_sanity'
export const FIGURE_RULE_SOURCE_ARTIFACT = 'source_artifact'

export const FIGURE_RULES = [
  FIGURE_RULE_DATA_FIDELITY,
  FIGURE_RULE_LABEL_ECONOMY,
  FIGURE_RULE_COLOR_THREADING,
  FIGURE_RULE_CHART_BY_SHAPE,
  FIGURE_RULE_RENDER_VERIFY,
  FIGURE_RULE_LOG_AXIS_SANITY,
  FIGURE_RULE_SOURCE_ARTIFACT
] as const
export type FigureRule = (typeof FIGURE_RULES)[number]

// Hard bounds used by the label/colour heuristics.
export const FIGURE_MAX_SERIES_COLORS = 8
export const FIGURE_MAX_LABELS_PER_AXIS = 12
// Below this point size a figure is unreadable when scaled to column width (Nature-style baseline ~8pt).
export const FIGURE_MIN_FONT_PT = 6

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
  // LOG AXIS SANITY: declared axis tick labels, so mislabeled log scales (e.g. decade ticks
  // annotated 0.05 where the value is 0.4) can be caught before a figure ships.
  axisTicks?: {
    axis: 'x' | 'y'
    scale: 'linear' | 'log'
    labels: string[]
  }[]
  // SOURCE ARTIFACT: the shipped figure must keep both its raster output and the script that
  // produced it, so the plot is reproducible and auditable.
  renderedImagePath?: string
  sourceScriptPath?: string
  // LEGIBILITY: the smallest font size used in the figure, in points.
  fontPt?: number
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
  'Two further checks apply to every shipped figure: (6) LOG AXIS SANITY — declare the tick ' +
    'labels of any log-scale axis via the `axis_ticks` argument (per axis: scale, labels); they ' +
    'must be positive numbers in strict order, so a mislabeled decade (annotating 0.4 as 0.05) ' +
    'is caught before publication; (7) SOURCE ARTIFACT — keep both the rendered image (.png) ' +
    'and the plotting script (.py) for every figure and pass their paths as ' +
    '`rendered_image_path` and `source_script_path`, plus `font_pt` for the smallest font used, ' +
    'which must stay at ~6pt or larger so the figure stays readable at column width. Declaring ' +
    'these in prose does not reach the rule engine — only the arguments do.',
  'Fix every error-severity violation and re-run figure_review before declaring a figure ' +
    'done; warnings are judgment calls but should be resolved deliberately.',
  '</purescience_figure_instructions>'
].join('\n')
