import { SaxesParser } from 'saxes'

// Word tables carry two independent rule sets: the outline an author picks for the table's frame and
// the rules between cells. A renderer that folds both into one style draws a different table — a
// report's thin inner grid comes out as heavy as its outline, and a table whose rules only exist
// between cells loses every rule. This module reads the authored numbers from `word/document.xml`
// (plus the table styles `word/styles.xml` holds) and re-applies them to the rendered DOM, so the
// preview shows what the file says.

const WORD_NAMESPACE_FRAGMENT = 'wordprocessingml'

export type DocxBorderEdge = 'top' | 'left' | 'bottom' | 'right' | 'insideH' | 'insideV'
export type DocxBorderLineStyle =
  'solid' | 'double' | 'dotted' | 'dashed' | 'groove' | 'ridge' | 'inset' | 'outset' | 'none'

export type DocxBorderLine = {
  style: DocxBorderLineStyle
  widthPt: number
  color: string
}

export type DocxTableBorders = Partial<Record<DocxBorderEdge, DocxBorderLine>>
export type DocxCellBorders = Partial<Record<'top' | 'left' | 'bottom' | 'right', DocxBorderLine>>

export type DocxTableCellFact = {
  row: number
  column: number
  columnSpan: number
  rowSpan: number
  borders: DocxCellBorders
}

export type DocxTableBorderSource = 'table' | 'style' | 'none'

export type DocxTableFact = {
  borders: DocxTableBorders
  borderSource: DocxTableBorderSource
  styleId?: string
  cells: DocxTableCellFact[]
}

export type DocxTableBorderApplication = {
  tablesInSource: number
  tablesRendered: number
  tablesReconciled: number
  cellsTouched: number
  edgesApplied: number
  unpairedCells: number
}

// Word names widths in eighths of a point; CSS wants points. The decorative kinds carry their own
// weight, so the number only decides how thick the plain ones are.
const BORDER_STYLE_NAMES: Record<string, DocxBorderLineStyle> = {
  single: 'solid',
  thick: 'solid',
  double: 'double',
  dotted: 'dotted',
  dashed: 'dashed',
  dotdash: 'dashed',
  dotdotdash: 'dashed',
  groove: 'groove',
  ridge: 'ridge',
  inset: 'inset',
  outset: 'outset',
  threeDemboss: 'ridge',
  threeDengrave: 'groove',
  none: 'none',
  nil: 'none'
}

const TABLE_EDGE_NAMES = new Set<string>(['top', 'left', 'bottom', 'right', 'insideH', 'insideV'])
const CELL_EDGE_NAMES = new Set<string>(['top', 'left', 'bottom', 'right'])

type SaxAttributes = Record<
  string,
  { value: string; uri?: string; prefix?: string; local?: string }
>

const isWordElement = (uri: string | undefined): boolean =>
  Boolean(uri && uri.includes(WORD_NAMESPACE_FRAGMENT))

const readAttribute = (attributes: SaxAttributes, name: string): string | undefined => {
  for (const attribute of Object.values(attributes)) {
    if ((attribute.local ?? attribute.prefix) === name) return attribute.value
  }
  return undefined
}

// `w:auto` means "the application's text colour", which for a preview is black rather than no colour.
const normalizeBorderColor = (value: string | undefined): string => {
  if (!value || value === 'auto') return '#000000'
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : value
}

const toBorderLine = (attributes: SaxAttributes): DocxBorderLine | undefined => {
  const style = BORDER_STYLE_NAMES[readAttribute(attributes, 'val') ?? '']
  if (!style) return undefined
  if (style === 'none') return { style, widthPt: 0, color: normalizeBorderColor('auto') }
  const eighths = Number.parseInt(readAttribute(attributes, 'sz') ?? '', 10)
  const widthPt = Number.isFinite(eighths) && eighths > 0 ? eighths / 8 : 0.5
  return { style, widthPt, color: normalizeBorderColor(readAttribute(attributes, 'color')) }
}

type TableContext = {
  borders: DocxTableBorders
  styleId?: string
  cells: DocxTableCellFact[]
  row: number
  column: number
  pendingCell?: DocxTableCellFact
  /** Cells a vertical merge started in, keyed by the column the merge occupies. */
  merges: Map<number, DocxTableCellFact>
}

// Reads one XML part and reports every table it contains in document order, nested tables included —
// the same order the rendered DOM exposes. Element names are matched by their position under the
// innermost open `w:tbl`, so a nested table's properties can never be read as its parent's.
const collectDocumentTables = (xml: string): DocxTableFact[] => {
  const parser = new SaxesParser({ xmlns: true })
  const tables: DocxTableFact[] = []
  const contexts: TableContext[] = []
  const path: string[] = []
  let failed = false

  parser.on('opentag', (tag) => {
    if (failed) return
    const local = tag.local
    path.push(local)
    if (!isWordElement(tag.uri)) return

    if (local === 'tbl') {
      contexts.push({ borders: {}, cells: [], row: -1, column: 0, merges: new Map() })
      return
    }

    const context = contexts[contexts.length - 1]
    if (!context) return
    const tableDepth = path.lastIndexOf('tbl') + 1
    const relative = path.slice(tableDepth)

    if (relative.length === 2 && relative[0] === 'tblPr' && relative[1] === 'tblStyle') {
      context.styleId = readAttribute(tag.attributes, 'val') ?? context.styleId
      return
    }
    if (relative.length === 3 && relative[0] === 'tblPr' && relative[1] === 'tblBorders') {
      const edge = relative[2]
      if (!TABLE_EDGE_NAMES.has(edge)) return
      const line = toBorderLine(tag.attributes)
      if (line) context.borders[edge as DocxBorderEdge] = line
      return
    }
    if (relative.length === 1 && relative[0] === 'tr') {
      context.row += 1
      context.column = 0
      return
    }
    if (relative.length === 2 && relative[0] === 'tr' && relative[1] === 'tc') {
      context.pendingCell = {
        row: Math.max(context.row, 0),
        column: context.column,
        columnSpan: 1,
        rowSpan: 1,
        borders: {}
      }
      return
    }
    if (relative.length === 4 && relative[0] === 'tr' && relative[2] === 'tcPr') {
      const cell = context.pendingCell
      if (!cell) return
      const property = relative[3]
      if (property === 'gridSpan') {
        const span = Number.parseInt(readAttribute(tag.attributes, 'val') ?? '', 10)
        if (Number.isFinite(span) && span > 1) cell.columnSpan = span
        return
      }
      if (property === 'vMerge') {
        // A bare `w:vMerge` (or an explicit "continue") continues the cell above it.
        if (readAttribute(tag.attributes, 'val') === 'restart') {
          context.merges.set(cell.column, cell)
        } else {
          const anchor = context.merges.get(cell.column)
          if (anchor) anchor.rowSpan += 1
          // Continuation cells render as hidden elements and carry no rules of their own.
          cell.rowSpan = 0
        }
      }
      return
    }
    if (
      relative.length === 5 &&
      relative[0] === 'tr' &&
      relative[2] === 'tcPr' &&
      relative[3] === 'tcBorders'
    ) {
      const cell = context.pendingCell
      const edge = relative[4]
      if (!cell || !CELL_EDGE_NAMES.has(edge)) return
      const line = toBorderLine(tag.attributes)
      // A cell's own rule beats the table's, so it is kept for the caller to apply.
      if (line) cell.borders[edge as keyof DocxCellBorders] = line
    }
  })

  parser.on('closetag', (tag) => {
    if (failed) {
      path.pop()
      return
    }
    const local = tag.local
    const context = contexts[contexts.length - 1]
    if (local === 'tc' && context && isWordElement(tag.uri)) {
      const cell = context.pendingCell
      context.pendingCell = undefined
      if (cell) {
        context.column += cell.columnSpan
        if (cell.rowSpan > 0) context.cells.push(cell)
      }
    }
    if (local === 'tbl' && context && isWordElement(tag.uri)) {
      contexts.pop()
      tables.push({
        borders: context.borders,
        borderSource: Object.keys(context.borders).length > 0 ? 'table' : 'none',
        styleId: context.styleId,
        cells: context.cells
      })
    }
    path.pop()
  })

  parser.on('error', () => {
    // A document the vendor renderer already accepted must not lose its preview over this pass.
    failed = true
  })

  try {
    parser.write(xml).close()
  } catch {
    return tables
  }
  return tables
}

// Table styles resolve one level: a style's own `tblBorders`. Styles that only inherit from a base
// style are left as "no rules", which keeps the preview from inventing an outline it cannot source.
const readStyleTableBorders = (stylesXml: string): Map<string, DocxTableBorders> => {
  const parser = new SaxesParser({ xmlns: true })
  const styles = new Map<string, DocxTableBorders>()
  const path: string[] = []
  let styleId: string | undefined
  let styleType: string | undefined
  let borders: DocxTableBorders | undefined
  let styleDepth = -1

  parser.on('opentag', (tag) => {
    path.push(tag.local)
    if (!isWordElement(tag.uri)) return
    if (tag.local === 'style') {
      styleType = readAttribute(tag.attributes, 'type')
      styleId = readAttribute(tag.attributes, 'styleId')
      styleDepth = path.length
      borders = undefined
      return
    }
    if (styleDepth < 0 || styleType !== 'table') return
    const relative = path.slice(styleDepth)
    if (relative.length === 1 && relative[0] === 'tblPr') {
      borders = undefined
      return
    }
    if (relative.length === 2 && relative[0] === 'tblPr' && relative[1] === 'tblBorders') {
      borders = {}
      return
    }
    if (relative.length === 3 && relative[0] === 'tblPr' && relative[1] === 'tblBorders') {
      const edge = relative[2]
      if (!borders || !TABLE_EDGE_NAMES.has(edge)) return
      const line = toBorderLine(tag.attributes)
      if (line) borders[edge as DocxBorderEdge] = line
    }
  })

  parser.on('closetag', (tag) => {
    if (isWordElement(tag.uri) && tag.local === 'style' && styleDepth === path.length) {
      if (styleType === 'table' && styleId && borders && Object.keys(borders).length > 0) {
        styles.set(styleId, borders)
      }
      styleId = undefined
      styleType = undefined
      styleDepth = -1
      borders = undefined
    }
    path.pop()
  })

  parser.on('error', () => undefined)

  try {
    parser.write(stylesXml).close()
  } catch {
    return styles
  }
  return styles
}

/**
 * Reads every table's authored rules from the document XML, resolving a table style's borders when the
 * table itself declares none. Cells keep their grid placement so callers can honour per-cell rules.
 */
export const readDocxTableFacts = (documentXml: string, stylesXml?: string): DocxTableFact[] => {
  const tables = collectDocumentTables(documentXml)
  if (!stylesXml || tables.length === 0) return tables
  const styles = readStyleTableBorders(stylesXml)
  return tables.map((table) => {
    if (table.borderSource === 'table' || !table.styleId) return table
    const fromStyle = styles.get(table.styleId)
    if (!fromStyle) return table
    return { ...table, borders: fromStyle, borderSource: 'style' as const }
  })
}

const toCssBorder = (line: DocxBorderLine): string =>
  line.style === 'none' ? 'none' : `${line.widthPt}pt ${line.style} ${line.color}`

type RenderedCellPlacement = {
  cell: HTMLTableCellElement
  row: number
  column: number
  columnSpan: number
  rowSpan: number
}

const isHiddenCell = (cell: HTMLTableCellElement): boolean =>
  cell.hidden || cell.style.display === 'none'

const describeRenderedGrid = (table: HTMLTableElement): RenderedCellPlacement[] => {
  const placements: RenderedCellPlacement[] = []
  Array.from(table.rows).forEach((row, rowIndex) => {
    let column = 0
    for (const cell of Array.from(row.cells)) {
      const columnSpan = cell.colSpan > 0 ? cell.colSpan : 1
      if (!isHiddenCell(cell)) {
        placements.push({
          cell,
          row: rowIndex,
          column,
          columnSpan,
          rowSpan: cell.rowSpan > 0 ? cell.rowSpan : 1
        })
      }
      column += columnSpan
    }
  })
  return placements
}

const EDGE_PROPERTIES = {
  top: 'borderTop',
  right: 'borderRight',
  bottom: 'borderBottom',
  left: 'borderLeft'
} as const

const applyCellEdges = (
  placement: RenderedCellPlacement,
  table: DocxTableBorders,
  overrides: DocxCellBorders,
  rowCount: number,
  columnCount: number
): number => {
  const edges: Array<{ edge: keyof typeof EDGE_PROPERTIES; tableEdge: DocxBorderEdge }> = [
    { edge: 'top', tableEdge: placement.row === 0 ? 'top' : 'insideH' },
    {
      edge: 'bottom',
      tableEdge: placement.row + placement.rowSpan >= rowCount ? 'bottom' : 'insideH'
    },
    { edge: 'left', tableEdge: placement.column === 0 ? 'left' : 'insideV' },
    {
      edge: 'right',
      tableEdge: placement.column + placement.columnSpan >= columnCount ? 'right' : 'insideV'
    }
  ]

  let applied = 0
  for (const { edge, tableEdge } of edges) {
    const line = overrides[edge] ?? table[tableEdge]
    if (!line) continue
    placement.cell.style[EDGE_PROPERTIES[edge]] = toCssBorder(line)
    applied += 1
  }
  return applied
}

/**
 * Re-applies the authored table rules to the rendered document. Cells the renderer merged away stay
 * untouched, a cell's own rules beat the table's, and a table whose author declared no rules is left
 * exactly as rendered — the pass never adds an outline a file does not say.
 */
export const applyDocxTableBorders = (
  root: ParentNode,
  facts: DocxTableFact[]
): DocxTableBorderApplication => {
  const tables = Array.from(root.querySelectorAll('table'))
  const result: DocxTableBorderApplication = {
    tablesInSource: facts.length,
    tablesRendered: tables.length,
    tablesReconciled: 0,
    cellsTouched: 0,
    edgesApplied: 0,
    unpairedCells: 0
  }

  tables.forEach((table, index) => {
    const fact = facts[index]
    if (!fact || fact.borderSource === 'none') return
    const placements = describeRenderedGrid(table)
    if (placements.length === 0) return
    const rowCount = table.rows.length
    const columnCount = placements.reduce(
      (widest, placement) => Math.max(widest, placement.column + placement.columnSpan),
      0
    )
    // Pairing is positional: the source lists cells row-major and so does the DOM, so a count mismatch
    // means the renderer disagreed about the grid and per-cell overrides cannot be trusted.
    const paired = placements.length === fact.cells.length
    if (!paired) result.unpairedCells += Math.abs(placements.length - fact.cells.length)

    for (const [placementIndex, placement] of placements.entries()) {
      const sourceCell = paired ? fact.cells[placementIndex] : undefined
      const applied = applyCellEdges(
        placement,
        fact.borders,
        sourceCell?.borders ?? {},
        rowCount,
        columnCount
      )
      if (applied > 0) result.cellsTouched += 1
      result.edgesApplied += applied
    }
    result.tablesReconciled += 1
  })

  return result
}
