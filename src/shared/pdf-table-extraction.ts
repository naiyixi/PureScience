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

export type PdfTableMethod =
  // Geometry: rows by baseline, columns by x gaps (needs positioned items).
  | 'text-layer-row-column-clustering'
  // Gaps the text layer already encodes: columns separated by runs of two or more spaces. A weaker claim
  // than coordinates — the stored page text has no x positions — and the method name says exactly that.
  | 'text-layer-whitespace-clustering'

export type PdfTableCandidate = {
  page: number
  /** Always 'candidate': nothing here is a verified transcription of the page. */
  status: 'candidate'
  method: PdfTableMethod
  rows: readonly (readonly string[])[]
  columnCount: number
  confidence: PdfTableConfidence
  /**
   * The line that names this table, when the page has one adjacent to it ("Table 2. …"), with where it sat.
   * Absent means no caption was found — not that the table has none: a table without a caption field must not
   * be read as a table whose caption was dropped.
   */
  caption?: string
  captionPosition?: 'above' | 'below'
  evidence: {
    itemCount: number
    rowCount: number
    /** The gap width that separated the columns on this page, in points. */
    columnGapPoints: number
    /**
     * How many physical lines were folded into the row above as a wrapped header. Reported instead of
     * silently applied: a reader comparing the candidate with the page needs to know the row count changed.
     */
    joinedHeaderRows?: number
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
export const groupRows = (items: readonly PdfTextItem[], tolerance: number): Row[] => {
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

export type Cell = { x: number; end: number; text: string }

// Splits one row into cells wherever the horizontal gap exceeds the threshold.
export const splitRow = (row: Row, gapPoints: number): Cell[] => {
  const cells: Cell[] = []
  let current: PdfTextItem[] = []
  let start = 0
  let previousEnd: number | undefined

  for (const item of row.items) {
    if (previousEnd !== undefined && item.x - previousEnd > gapPoints) {
      cells.push({ x: start, end: previousEnd, text: cellText(current) })
      current = []
    }
    if (current.length === 0) start = item.x
    current.push(item)
    previousEnd = item.x + item.width
  }
  if (current.length > 0)
    cells.push({ x: start, end: previousEnd ?? start, text: cellText(current) })
  return cells
}

// Column positions are read off the whole block, not just the widest row: a row that leaves a column
// empty must still land in the right columns, or every value after the gap shifts left into a wrong
// column — a silent corruption of the table rather than a visible blank.
export const columnAnchors = (rows: readonly (readonly Cell[])[], tolerance: number): number[] => {
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

const nearestAnchor = (anchors: readonly number[], x: number): number => {
  let best = anchors[0] ?? 0
  for (const anchor of anchors) {
    if (Math.abs(anchor - x) < Math.abs(best - x)) best = anchor
  }
  return best
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
// The extents a set of cells occupies per anchor: what the merge guard measures between two columns.
export const columnExtents = (
  rows: readonly (readonly Cell[])[],
  anchors: readonly number[],
  tolerance: number
): { start: number; end: number }[] =>
  anchors.map((anchor) => {
    let start = Number.POSITIVE_INFINITY
    let end = Number.NEGATIVE_INFINITY
    for (const cell of rows.flat()) {
      if (Math.abs(nearestAnchor(anchors, cell.x) - anchor) > tolerance) continue
      if (nearestAnchor(anchors, cell.x) !== anchor) continue
      start = Math.min(start, cell.x)
      end = Math.max(end, cell.end)
    }
    return Number.isFinite(start) ? { start, end } : { start: anchor, end: anchor }
  })

export const mergeSplitColumns = (
  rows: readonly (readonly string[])[],
  anchors: readonly number[],
  extents: readonly { start: number; end: number }[],
  gapPoints: number
): { rows: string[][]; anchors: number[] } => {
  const placed = rows.map((row) => [...row])
  const spans = extents.map((extent) => ({ ...extent }))
  const dropped = anchors.map(() => false)

  // A column split into several anchors needs several merges, so a merge RETRIES the same column against
  // its new neighbour instead of moving on: advancing after one merge is what left a real table short of a
  // column when its values were spread over more than two anchors.
  let left = 0
  while (left < anchors.length) {
    if (dropped[left]) {
      left += 1
      continue
    }
    let right = left + 1
    while (right < anchors.length && dropped[right]) right += 1
    if (right >= anchors.length) break

    // Two signals, both required. The columns have to be close enough that they cannot be two columns
    // (same threshold the splitter uses), and no row may ever fill both — a real pair of columns is filled
    // together at least once, so a pair that never is, is one column that was split.
    const tooFarApart = spans[right]!.start - spans[left]!.end > gapPoints
    const bothFilled = placed.some((row) => row[left]!.trim() !== '' && row[right]!.trim() !== '')
    if (tooFarApart || bothFilled) {
      left += 1
      continue
    }

    for (const row of placed) {
      if (row[left]!.trim() === '' && row[right]!.trim() !== '') row[left] = row[right]!
      else if (row[left]!.trim() !== '' && row[right]!.trim() !== '') {
        row[left] = `${row[left]!} ${row[right]!}`
      }
      row[right] = ''
    }
    spans[left] = {
      start: Math.min(spans[left]!.start, spans[right]!.start),
      end: Math.max(spans[left]!.end, spans[right]!.end)
    }
    dropped[right] = true
  }

  return {
    rows: placed.map((row) => row.filter((_, index) => !dropped[index])),
    anchors: anchors.filter((_, index) => !dropped[index])
  }
}

/**
 * Joins a wrapped header line into the line above it, which is how a two-line column title ("Mean annual\nprecipitation") stops looking like two rows of data.
 *
 * Deliberately conservative, and the limits are the point:
 * - only inside the leading header block, i.e. before the first row that fills every column. A short row
 *   further down is a legitimate row of its own (a footnote, a subtotal) and merging it would invent data;
 * - every filled cell of the candidate line must sit in a column the line above also fills, and at least one
 *   column must be filled in both — that is what makes it the same cells wrapped, not a new row;
 * - a line that fills only columns the line above left empty is NOT joined. That shape is a spanning
 *   sub-header (multi-level header), a different recovery step, and treating it as a wrap would misplace it.
 *
 * `joined` reports the indices that were folded in, so the caller can say how many rows the page's own
 * layout did not actually contain.
 */
export const joinWrappedHeaderRows = (
  rows: readonly (readonly string[])[]
): { rows: string[][]; joined: number[] } => {
  const output: string[][] = []
  const joined: number[] = []
  let headerOpen = true

  for (const [index, row] of rows.entries()) {
    const filled = row.map((cell) => cell.trim() !== '')
    const previous = output[output.length - 1]

    if (headerOpen && index > 0 && previous && filled.some(Boolean)) {
      const previousFilled = previous.map((cell) => cell.trim() !== '')
      const sharesAColumn = filled.some(
        (isFilled, column) => isFilled && previousFilled[column] === true
      )
      // A STRICT subset: the candidate line fills fewer columns than the line above. Two lines that both
      // fill every column have the same shape as two data rows, and this function only sees shapes — the
      // geometry that could tell them apart lives in the positional path. Refusing is the honest answer.
      const fillsFewer = filled.filter(Boolean).length < previousFilled.filter(Boolean).length

      if (sharesAColumn && fillsFewer) {
        let insideAbove = true
        for (const [column, isFilled] of filled.entries()) {
          if (isFilled && previousFilled[column] !== true) {
            insideAbove = false
            break
          }
        }
        if (insideAbove) {
          for (const [column, isFilled] of filled.entries()) {
            if (!isFilled) continue
            const addition = row[column]?.trim() ?? ''
            previous[column] = `${previous[column]?.trim() ?? ''} ${addition}`.trim()
          }
          joined.push(index)
          continue
        }
      }
    }

    // The header block ends at the SECOND consecutive full row, not the first. A wrapped title makes its
    // first physical line full and the second partial, so closing on the first would refuse exactly the case
    // this function exists for; two full rows in a row is the earliest point data can have started.
    const previousWasFull = (previous ?? []).every((cell) => cell.trim() !== '')
    output.push([...row])
    if (filled.every(Boolean) && previousWasFull) headerOpen = false
  }

  return { rows: output, joined }
}

// "Table 2", "Tab. 3", "表 2" — the shapes a caption actually opens with. Kept narrow on purpose: a loose
// pattern would start calling ordinary sentences captions.
const TABLE_CAPTION_PATTERN = /^\s*(table|tab\.?|表)\s*[0-9ivx]{1,4}\s*[.:：、]?\s*(\S|$)/i

/**
 * The caption nearest to a table's rows, with its position. Only a single text item is considered a caption:
 * a caption split across items on one line is not stitched together here, because guessing which fragments
 * belong together is exactly the kind of invention the rest of this module refuses. Items INSIDE the table's
 * own vertical range are ignored (a cell that happens to read "Table 4" is data, not a caption), and a match
 * further away than the distance budget is not a caption either.
 */
export const findTableCaption = (
  items: readonly PdfTextItem[],
  rowBaselines: readonly number[],
  options: { maxDistancePoints?: number } = {}
): { text: string; position: 'above' | 'below' } | undefined => {
  if (rowBaselines.length === 0) return undefined
  const maxDistance = options.maxDistancePoints ?? 28
  const top = Math.min(...rowBaselines)
  const bottom = Math.max(...rowBaselines)

  let best: { text: string; position: 'above' | 'below'; distance: number } | undefined
  for (const item of items) {
    const text = item.text.trim()
    if (!TABLE_CAPTION_PATTERN.test(text)) continue
    if (item.y >= top && item.y <= bottom) continue

    const position = item.y > bottom ? 'below' : 'above'
    const distance = position === 'below' ? item.y - bottom : top - item.y
    if (distance > maxDistance) continue
    if (!best || distance < best.distance) best = { text, position, distance }
  }

  return best ? { text: best.text, position: best.position } : undefined
}

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
  const cellsByRow = grouped.map((row) => splitRow(row, columnGapPoints))
  const columnTolerance = Math.max(1, columnGapPoints / 2)
  const merged = mergeSplitColumns(
    cellsByRow.map((cells) => placeInColumns(cells, anchors, columnTolerance)),
    anchors,
    columnExtents(cellsByRow, anchors, columnTolerance),
    columnGapPoints
  )
  // Wrapped header lines are folded in before the row gates: a two-line title is one row on the page, and
  // counting it as two would both inflate the row count and split a header cell in half.
  const joinedHeaders = joinWrappedHeaderRows(merged.rows)
  const rows = joinedHeaders.rows
  const columnCount = merged.anchors.length
  const caption = findTableCaption(
    usable,
    grouped.map((row) => row.y)
  )
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
      ...(caption ? { caption: caption.text, captionPosition: caption.position } : {}),
      evidence: {
        itemCount: usable.length,
        rowCount: rows.length,
        columnGapPoints,
        ...(joinedHeaders.joined.length > 0
          ? { joinedHeaderRows: joinedHeaders.joined.length }
          : {})
      }
    }
  ]
}

export type PdfTextTableOptions = {
  minRows?: number
  minColumns?: number
  /** How many consecutive spaces separate two columns in this producer's output. */
  minGapSpaces?: number
}

type LineShape = { cells: string[]; gaps: number[] }

// Splits one line on runs of spaces and remembers WHERE each gap starts. The positions are what make a
// column a column: a table's separators line up down the block, while prose that happens to carry double
// spacing puts them wherever the sentence ended.
const shapeOf = (line: string, minGapSpaces: number): LineShape => {
  const cells: string[] = []
  const gaps: number[] = []
  const pattern = new RegExp(String.raw`\s{${minGapSpaces},}`, 'g')
  let cursor = 0
  for (const match of line.matchAll(pattern)) {
    const start = match.index ?? 0
    // Padding before the first cell is indentation, not a column boundary.
    if (line.slice(cursor, start).trim() === '') {
      cursor = start + match[0].length
      continue
    }
    cells.push(line.slice(cursor, start).trim())
    gaps.push(start)
    cursor = start + match[0].length
  }
  const tail = line.slice(cursor).trim()
  if (tail !== '') cells.push(tail)
  return { cells, gaps }
}

// Characters the separators may drift by and still count as the same column (proportional text layers
// shift a column by a character or two; prose shifts it by whole words).
const COLUMN_ALIGNMENT_TOLERANCE = 2

const alignedWith = (shape: LineShape, reference: LineShape): boolean =>
  shape.cells.length === reference.cells.length &&
  shape.gaps.length === reference.gaps.length &&
  shape.gaps.every(
    (gap, index) => Math.abs(gap - reference.gaps[index]) <= COLUMN_ALIGNMENT_TOLERANCE
  )

/**
 * Text-layer mode: many producers separate table columns with runs of two or more spaces, and a stored page
 * string is all that is available (no coordinates). A candidate here is a rigid grid — consecutive lines
 * that all split into the SAME number of cells, at least 2x2 — because that is what distinguishes a table
 * from prose that merely contains double spacing after a sentence. Anything weaker is not reported: a
 * fabricated table would be worse than none.
 */
export const extractPdfTableCandidatesFromText = (
  page: number,
  text: string,
  options: PdfTextTableOptions = {}
): PdfTableCandidate[] => {
  const minRows = options.minRows ?? DEFAULTS.minRows
  const minColumns = options.minColumns ?? DEFAULTS.minColumns
  const minGapSpaces = options.minGapSpaces ?? 2

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
  if (lines.length < minRows) return []

  const candidates: PdfTableCandidate[] = []
  let run: { shapes: LineShape[]; columns: number } | undefined

  const flush = (): void => {
    if (!run || run.shapes.length < minRows || run.columns < minColumns) {
      run = undefined
      return
    }
    const joinedHeaders = joinWrappedHeaderRows(run.shapes.map((shape) => shape.cells))
    const rows = joinedHeaders.rows
    candidates.push({
      page,
      status: 'candidate',
      method: 'text-layer-whitespace-clustering',
      rows,
      columnCount: run.columns,
      confidence: confidenceFor(rows),
      evidence: {
        itemCount: rows.reduce((total, row) => total + row.length, 0),
        rowCount: rows.length,
        columnGapPoints: minGapSpaces,
        ...(joinedHeaders.joined.length > 0
          ? { joinedHeaderRows: joinedHeaders.joined.length }
          : {})
      }
    })
    run = undefined
  }

  for (const line of lines) {
    const shape = shapeOf(line, minGapSpaces)
    if (run && alignedWith(shape, run.shapes[0])) {
      run.shapes.push(shape)
      continue
    }
    flush()
    if (shape.cells.length >= minColumns) run = { shapes: [shape], columns: shape.cells.length }
  }
  flush()

  return candidates
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
