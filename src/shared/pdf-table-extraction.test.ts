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
})
