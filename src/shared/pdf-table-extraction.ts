// Local PDF table extraction from the text layer, and the export formats it feeds.
//
// What this is: deterministic geometry over the page's text items — rows by vertical position, columns by
// horizontal gaps. No model, no OCR, no images.
//
// What this is NOT, and the contract says so at every exit: an authoritative reading of the table. A
// text-layer block with aligned numbers is a CANDIDATE. Every export therefore carries its provenance and
// the instruction to compare it with the source page, and `auditPdfTableCandidateForUse` names the reasons
// it must not be pasted into a manuscript unchecked. That is the difference this app can honestly offer:
// the competitor's exporter hands over a table; ours hands over a table that says where it came from and
// what it cannot vouch for.
export type PdfTextItem = {
  text: string
  /** Page coordinate in points: left edge, baseline, width, height. */
  x: number
  y: number
  width: number
  height: number
}

export type PdfTableConfidence = 'low' | 'medium' | 'high'

export type PdfTableCandidate = {
  page: number
  /** Always 'candidate': nothing here is a verified transcription of the page. */
  status: 'candidate'
  method: 'text-layer-row-column-clustering'
  rows: readonly (readonly string[])[]
  columnCount: number
  confidence: PdfTableConfidence
  evidence: {
    itemCount: number
    rowCount: number
    /** The gap width that separated the columns on this page, in points. */
    columnGapPoints: number
  }
}

export type PdfTableExtractionOptions = {
  /** Items whose baselines are within this many points are the same row. */
  rowTolerancePoints?: number
  /** A horizontal gap wider than this separates two columns. */
  columnGapPoints?: number
  /** A block needs at least this many rows and columns to be worth calling a table. */
  minRows?: number
  minColumns?: number
}

const DEFAULTS = {
  rowTolerancePoints: 2.5,
  columnGapPoints: 12,
  minRows: 2,
  minColumns: 2
} as const

const cellText = (items: readonly PdfTextItem[]): string =>
  items
    .map((item) => item.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

type Row = { y: number; items: PdfTextItem[] }

// Groups items into visual rows by baseline. Ordering inside a row is by x, so the reading order matches
// the page even when the text layer emits items out of order.
const groupRows = (items: readonly PdfTextItem[], tolerance: number): Row[] => {
  const rows: Row[] = []
  for (const item of [...items].sort((left, right) => right.y - left.y || left.x - right.x)) {
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance)
    if (row) {
      row.items.push(item)
      continue
    }
    rows.push({ y: item.y, items: [item] })
  }
  return rows.map((row) => ({
    y: row.y,
    items: [...row.items].sort((left, right) => left.x - right.x)
  }))
}

type Cell = { x: number; text: string }

// Splits one row into cells wherever the horizontal gap exceeds the threshold.
const splitRow = (row: Row, gapPoints: number): Cell[] => {
  const cells: Cell[] = []
  let current: PdfTextItem[] = []
  let start = 0
  let previousEnd: number | undefined

  for (const item of row.items) {
    if (previousEnd !== undefined && item.x - previousEnd > gapPoints) {
      cells.push({ x: start, text: cellText(current) })
      current = []
    }
    if (current.length === 0) start = item.x
    current.push(item)
    previousEnd = item.x + item.width
  }
  if (current.length > 0) cells.push({ x: start, text: cellText(current) })
  return cells
}

// Column positions are read off the whole block, not just the widest row: a row that leaves a column
// empty must still land in the right columns, or every value after the gap shifts left into a wrong
// column — a silent corruption of the table rather than a visible blank.
const columnAnchors = (rows: readonly (readonly Cell[])[], tolerance: number): number[] => {
  const anchors: number[] = []
  for (const start of rows
    .flat()
    .map((cell) => cell.x)
    .sort((left, right) => left - right)) {
    const last = anchors.at(-1)
    if (last === undefined || start - last > tolerance) anchors.push(start)
  }
  return anchors
}

const placeInColumns = (
  cells: readonly Cell[],
  anchors: readonly number[],
  tolerance: number
): string[] => {
  const placed = anchors.map(() => '')
  for (const cell of cells) {
    let nearest = 0
    for (let index = 1; index < anchors.length; index += 1) {
      if (Math.abs(anchors[index] - cell.x) < Math.abs(anchors[nearest] - cell.x)) nearest = index
    }
    // A cell further from every anchor than the tolerance is not silently dropped: it is appended to the
    // cell on its left, which keeps the text on the page and keeps the column count honest.
    if (Math.abs(anchors[nearest] - cell.x) > tolerance) {
      placed[nearest] = placed[nearest] ? `${placed[nearest]} ${cell.text}` : cell.text
      continue
    }
    placed[nearest] = placed[nearest] ? `${placed[nearest]} ${cell.text}` : cell.text
  }
  return placed
}

const confidenceFor = (rows: readonly (readonly string[])[]): PdfTableConfidence => {
  const counts = new Set(rows.map((row) => row.length))
  if (counts.size === 1 && rows.length >= 3) return 'high'
  if (counts.size <= 2) return 'medium'
  return 'low'
}

/**
 * Extracts table candidates from one page's text items. Empty cells inside a row are kept: a missing value
 * in a column is information, and silently shifting the remaining cells left would corrupt the table.
 */
export const extractPdfTableCandidates = (
  page: number,
  items: readonly PdfTextItem[],
  options: PdfTableExtractionOptions = {}
): PdfTableCandidate[] => {
  const rowTolerancePoints = options.rowTolerancePoints ?? DEFAULTS.rowTolerancePoints
  const columnGapPoints = options.columnGapPoints ?? DEFAULTS.columnGapPoints
  const minRows = options.minRows ?? DEFAULTS.minRows
  const minColumns = options.minColumns ?? DEFAULTS.minColumns

  const usable = items.filter((item) => item.text.trim() !== '')
  if (usable.length === 0) return []

  const grouped = groupRows(usable, rowTolerancePoints)
  const anchors = columnAnchors(
    grouped.map((row) => splitRow(row, columnGapPoints)),
    Math.max(1, columnGapPoints / 2)
  )
  const rows = grouped.map((row) =>
    placeInColumns(splitRow(row, columnGapPoints), anchors, Math.max(1, columnGapPoints / 2))
  )
  const columnCount = anchors.length
  // Enough rows must actually SPAN the columns: spaced prose on one line followed by a single item is not
  // a table, and calling it one would invent structure the page does not have.
  const spanningRows = rows.filter(
    (row) => row.filter((cell) => cell !== '').length >= minColumns
  ).length
  if (rows.length < minRows || columnCount < minColumns || spanningRows < minRows) return []

  return [
    {
      page,
      status: 'candidate',
      method: 'text-layer-row-column-clustering',
      rows,
      columnCount,
      confidence: confidenceFor(rows),
      evidence: { itemCount: usable.length, rowCount: rows.length, columnGapPoints }
    }
  ]
}

/** Mandatory on every export: nothing downstream may treat the extraction as a transcription. */
export const PDF_TABLE_MANDATORY_LABELS = ['candidate-extraction', 'verify-against-source'] as const

/**
 * Why this candidate must not be used unchecked. Always returns at least the mandatory two reasons — an
 * empty list would read as "safe to cite as-is".
 */
export const auditPdfTableCandidateForUse = (candidate: PdfTableCandidate): string[] => {
  const reasons: string[] = [...PDF_TABLE_MANDATORY_LABELS]
  const counts = new Set(candidate.rows.map((row) => row.length))
  if (counts.size > 1) reasons.push('ragged-rows')
  if (candidate.confidence === 'low') reasons.push('low-confidence')
  if (candidate.columnCount < 3) reasons.push('narrow-table')
  return reasons
}

const provenanceLines = (candidate: PdfTableCandidate): string[] => [
  `page ${candidate.page}`,
  `method ${candidate.method}`,
  `${candidate.rows.length} rows x ${candidate.columnCount} columns`,
  `confidence ${candidate.confidence}`,
  ...auditPdfTableCandidateForUse(candidate).map((reason) => `reason ${reason}`)
]

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Markdown table with a provenance blockquote above it. */
export const toMarkdownTable = (candidate: PdfTableCandidate): string => {
  const header = candidate.rows[0] ?? []
  const separator = header.map(() => '---')
  const body = candidate.rows.slice(1)
  return [
    ...provenanceLines(candidate).map((line) => `> ${line}`),
    '',
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`)
  ].join('\n')
}

/** TSV with `# ` provenance comments first: a spreadsheet import keeps them, and they cannot be missed. */
export const toTsv = (candidate: PdfTableCandidate): string =>
  [
    ...provenanceLines(candidate).map((line) => `# ${line}`),
    ...candidate.rows.map((row) => row.join('\t'))
  ].join('\n')

/** HTML table with a caption carrying the same provenance. Cells are escaped: page text is untrusted. */
export const toHtmlTable = (candidate: PdfTableCandidate): string =>
  [
    '<table>',
    `<caption>${escapeHtml(provenanceLines(candidate).join('; '))}</caption>`,
    ...candidate.rows.map(
      (row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`
    ),
    '</table>'
  ].join('\n')
