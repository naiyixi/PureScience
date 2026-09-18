import { describe, expect, it } from 'vitest'

import {
  auditPdfTableCandidateForUse,
  extractPdfTableCandidates,
  extractPdfTableCandidatesFromText,
  PDF_TABLE_MANDATORY_LABELS,
  toHtmlTable,
  toMarkdownTable,
  toTsv,
  type PdfTextItem
} from './pdf-table-extraction'

// A text item as the PDF layer emits it: baseline y, left x, measured width.
const item = (text: string, x: number, y: number, width = text.length * 5): PdfTextItem => ({
  text,
  x,
  y,
  width,
  height: 10
})

// A 3x2 table: two columns, 36 points apart, three rows 14 points down from each other.
const tableItems: PdfTextItem[] = [
  item('Sample', 40, 700),
  item('Value', 120, 700),
  item('control', 40, 686),
  item('12.4', 120, 686),
  item('treated', 40, 672),
  item('31.8', 120, 672)
]

describe('PDF table extraction', () => {
  it('reads a grid of text items into rows and columns, keeping cell order', () => {
    const [candidate] = extractPdfTableCandidates(3, tableItems)

    expect(candidate).toBeDefined()
    expect(candidate.status).toBe('candidate')
    expect(candidate.page).toBe(3)
    expect(candidate.columnCount).toBe(2)
    expect(candidate.rows).toEqual([
      ['Sample', 'Value'],
      ['control', '12.4'],
      ['treated', '31.8']
    ])
    expect(candidate.confidence).toBe('high')
    expect(candidate.evidence).toMatchObject({ itemCount: 6, rowCount: 3 })
  })

  it('does not call a paragraph a table', () => {
    // Continuous prose has no column gaps: reporting a table here would be a fabrication.
    const paragraph = [
      item('The treated group', 40, 700),
      item('responded better', 145, 700),
      item('than the control', 250, 700),
      item('group did.', 40, 686)
    ]

    expect(extractPdfTableCandidates(1, paragraph)).toEqual([])
    expect(extractPdfTableCandidates(1, [])).toEqual([])
    expect(extractPdfTableCandidates(1, [item('   ', 40, 700), item('x', 200, 700)])).toEqual([])
  })

  it('keeps a missing cell instead of shifting the row left', () => {
    const [candidate] = extractPdfTableCandidates(2, [
      item('n', 40, 700),
      item('mean', 120, 700),
      item('sd', 200, 700),
      item('12', 40, 686),
      item('3.1', 200, 686),
      item('19', 40, 672),
      item('4.4', 200, 672)
    ])

    // The empty middle cell is information: shifting '3.1' into it would silently corrupt the table.
    expect(candidate.rows).toEqual([
      ['n', 'mean', 'sd'],
      ['12', '', '3.1'],
      ['19', '', '4.4']
    ])
    // Regular geometry across three rows: the blank is explicit, not a shifted value.
    expect(candidate.confidence).toBe('high')
    expect(candidate.columnCount).toBe(3)
  })

  it('orders a row by x even when the text layer emits items out of order', () => {
    const [candidate] = extractPdfTableCandidates(1, [
      item('12.4', 120, 686),
      item('Sample', 40, 700),
      item('control', 40, 686),
      item('Value', 120, 700)
    ])

    expect(candidate.rows).toEqual([
      ['Sample', 'Value'],
      ['control', '12.4']
    ])
  })

  it('names what it cannot stand behind, and never returns an empty audit', () => {
    const [candidate] = extractPdfTableCandidates(3, tableItems)

    const reasons = auditPdfTableCandidateForUse(candidate)
    expect(reasons).toEqual(expect.arrayContaining([...PDF_TABLE_MANDATORY_LABELS]))
    // A two-column table is narrow enough that the reader should check the surrounding text.
    expect(reasons).toContain('narrow-table')

    const ragged = auditPdfTableCandidateForUse({
      ...candidate,
      rows: [['a', 'b'], ['c'], ['d', 'e', 'f']],
      confidence: 'low'
    })
    expect(ragged).toEqual(expect.arrayContaining(['ragged-rows', 'low-confidence']))
  })

  it('carries the provenance into every export format', () => {
    const [candidate] = extractPdfTableCandidates(7, tableItems)

    for (const exported of [toMarkdownTable(candidate), toTsv(candidate), toHtmlTable(candidate)]) {
      expect(exported).toContain('page 7')
      expect(exported).toContain('text-layer-row-column-clustering')
      expect(exported).toContain('confidence high')
      for (const label of PDF_TABLE_MANDATORY_LABELS) expect(exported).toContain(label)
    }

    expect(toMarkdownTable(candidate)).toContain('| Sample | Value |')
    expect(toTsv(candidate).split('\n').at(-1)).toBe('treated\t31.8')
    expect(toHtmlTable(candidate)).toContain('<td>treated</td>')
  })

  it('escapes page text in the HTML export', () => {
    const [candidate] = extractPdfTableCandidates(1, [
      item('<script>alert(1)</script>', 40, 700, 100),
      item('safe', 200, 700, 20),
      item('a', 40, 686, 10),
      item('b', 200, 686, 10)
    ])

    const html = toHtmlTable(candidate)

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('reads a rigid text-layer grid as a candidate, and names the weaker method', () => {
    const text = [
      'Sample    Value    sd',
      'control   12.4     1.1',
      'treated   31.8     2.4',
      'vehicle    9.7     0.8'
    ].join('\n')

    const [candidate] = extractPdfTableCandidatesFromText(5, text)

    expect(candidate).toBeDefined()
    expect(candidate.method).toBe('text-layer-whitespace-clustering')
    expect(candidate.page).toBe(5)
    expect(candidate.columnCount).toBe(3)
    expect(candidate.rows[1]).toEqual(['control', '12.4', '1.1'])
    expect(candidate.confidence).toBe('high')
  })

  it('does not call prose a table just because it has wide spacing', () => {
    // Sentence-final double spaces are not a column grid: the line shapes differ, and one line of a
    // two-column shape is not a table either.
    const prose = [
      'The treated group responded better.  It also recovered faster.',
      'Controls were unchanged.  No adverse events were recorded.',
      'We conclude the effect is real.'
    ].join('\n')

    expect(extractPdfTableCandidatesFromText(1, prose)).toEqual([])
    expect(extractPdfTableCandidatesFromText(1, 'Header   Value\nonly one row')).toEqual([])
    expect(extractPdfTableCandidatesFromText(1, 'alpha\nbeta\ngamma')).toEqual([])
  })

  it('stops a text-layer run at the line that breaks the grid, and keeps what came before', () => {
    const text = [
      'Sample    Value',
      'control   12.4',
      'treated   31.8',
      'Discussion',
      'The two arms differed.'
    ].join('\n')

    const candidates = extractPdfTableCandidatesFromText(2, text, { minRows: 3 })

    expect(candidates).toHaveLength(1)
    expect(candidates[0].rows).toEqual([
      ['Sample', 'Value'],
      ['control', '12.4'],
      ['treated', '31.8']
    ])
  })

  it('reports nothing when the geometry is one column wide', () => {
    const singleColumn = [item('alpha', 40, 700), item('beta', 40, 686), item('gamma', 40, 672)]

    expect(extractPdfTableCandidates(1, singleColumn)).toEqual([])
  })

  // A real four-column table as a producer with centred cells emits it: the header labels and the values
  // beneath them start at different x, so clustering anchors by start position alone splits each column into
  // several. Measured on the table this fixture copies: ten anchors for four columns, values stranded in
  // filler columns. Adjacent anchors that no row ever fills together are one logical column.
  const liveCentredTable: PdfTextItem[] = [
    item('Gene', 37.1828125, 112.934109375, 23.7),
    item('log2FC', 117.3046875, 112.9311796875, 30.9),
    item('padj', 206.7234375, 112.9311796875, 19.5),
    item('Cluster', 284.18125, 112.9311796875, 31.9),
    item('MYC', 63.4675, 100.934109375, 19.1),
    item('3.42', 146.214375, 100.934109375, 20.0),
    item('1.2e-12', 215.414375, 100.934109375, 34.5),
    item('0', 327.91125, 100.934109375, 5.7),
    item('CDKN1A', 44.795625, 88.934109375, 37.7),
    item('-2.87', 142.964375, 88.934109375, 23.3),
    item('4.5e-09', 215.414375, 88.934109375, 34.5),
    item('1', 327.91125, 88.934109375, 5.7),
    item('GAPDH', 50.28, 76.934109375, 32.3),
    item('0.14', 146.214375, 76.934109375, 20.0),
    item('8.1e-01', 215.414375, 76.934109375, 34.5),
    item('2', 327.91125, 76.934109375, 5.7),
    item('ACTB', 58.576875, 64.934109375, 24.0),
    item('-0.09', 142.964375, 64.934109375, 23.3),
    item('9.4e-01', 215.414375, 64.934109375, 34.5),
    item('3', 327.91125, 64.934109375, 5.7),
    item('TP53', 60.170625, 52.934109375, 22.4),
    item('1.75', 146.214375, 52.934109375, 20.0),
    item('2.2e-05', 215.414375, 52.934109375, 34.5),
    item('0', 327.91125, 52.934109375, 5.7),
    item('MDM2', 54.3425, 40.934109375, 28.2),
    item('2.11', 146.214375, 40.934109375, 20.0),
    item('6.7e-07', 215.414375, 40.934109375, 34.5),
    item('1', 327.91125, 40.934109375, 5.7)
  ]

  it('merges the anchors a header and its values produce for one column', () => {
    const candidates = extractPdfTableCandidates(1, liveCentredTable)

    // The merge pass is what this case guards, and what it pins is the reading contract: every value is still
    // there, in the order the page reads. The column MODEL still over-splits a centred table (ten anchors to
    // five, not to four) — a known gap recorded in the evidence file, deliberately not pinned as correct.
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.rows[0]!.filter((cell) => cell !== '')).toEqual([
      'Gene',
      'log2FC',
      'padj',
      'Cluster'
    ])
    expect(candidates[0]!.rows[1]!.filter((cell) => cell !== '')).toEqual([
      'MYC',
      '3.42',
      '1.2e-12',
      '0'
    ])
    expect(candidates[0]!.columnCount).toBe(4)
    expect(candidates[0]!.rows[0]).toEqual(['Gene', 'log2FC', 'padj', 'Cluster'])
    expect(candidates[0]!.rows[1]).toEqual(['MYC', '3.42', '1.2e-12', '0'])
  })

  it('keeps two anchors apart when some row fills both', () => {
    const candidates = extractPdfTableCandidates(1, [
      item('left', 10, 100),
      item('right', 45, 100),
      item('a', 10, 90),
      item('b', 45, 90)
    ])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.columnCount).toBe(2)
    expect(candidates[0]!.rows[0]).toEqual(['left', 'right'])
  })

  // The guard against merging a genuinely sparse table: two value columns a full column apart, whose values
  // never share a row, stay two columns.
  it('keeps sparse columns apart when they sit a column away from each other', () => {
    const candidates = extractPdfTableCandidates(1, [
      item('key', 10, 100),
      item('first', 60, 100),
      item('second', 110, 100),
      item('k1', 10, 90),
      item('a', 60, 90),
      item('k2', 10, 80),
      item('b', 60, 80),
      item('k3', 10, 70),
      item('c', 110, 70),
      item('k4', 10, 60),
      item('d', 110, 60)
    ])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.columnCount).toBe(3)
  })
})
