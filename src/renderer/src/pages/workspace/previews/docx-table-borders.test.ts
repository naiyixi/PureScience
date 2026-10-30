// @vitest-environment jsdom
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { applyDocxTableBorders, readDocxTableFacts } from './docx-table-borders'
import { readDocxPartText } from './office-package'

/**
 * The comparison this file exists for: what a `.docx` *says* about its tables versus what the preview
 * *shows*. Every case renders the real bytes with the real vendor renderer — nothing here is mocked —
 * and then re-applies the authored rules through the same two calls the preview makes.
 */

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

const buildDocx = (body: string, stylesXml?: string): Uint8Array => {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${WORD_NS}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(documentXml),
    'word/_rels/document.xml.rels': strToU8(DOCUMENT_RELS)
  }
  if (stylesXml) files['word/styles.xml'] = strToU8(stylesXml)
  // Stored, not deflated: jsdom's Blob stream is not a Node stream, so the inflate path that every
  // real preview takes (validateOfficePackage inflates each entry) cannot run under this environment.
  // The rules under test are unaffected — they are read from the part's text either way.
  return zipSync(files, { level: 0 })
}

const GRID = '<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>'

const paragraph = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`

const simpleTable = (tblProperties: string, rows: string[][]): string =>
  `<w:tbl><w:tblPr>${tblProperties}</w:tblPr>${GRID}${rows
    .map(
      (cells) =>
        `<w:tr>${cells.map((cell) => `<w:tc><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`
    )
    .join('')}</w:tbl>`

const DOC_DEFAULTS = `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>`

// The vendor renderer is imported lazily so this file's jsdom environment is in place first.
const renderDocx = async (bytes: Uint8Array): Promise<HTMLDivElement> => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const { renderAsync } = await import('docx-preview')
  await renderAsync(bytes, host, host, {
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    renderAltChunks: false,
    renderComments: false,
    useBase64URL: true
  })
  return host
}

const reconcile = async (
  host: HTMLElement,
  bytes: Uint8Array
): Promise<ReturnType<typeof applyDocxTableBorders>> => {
  const documentXml = await readDocxPartText(bytes, 'word/document.xml')
  const stylesXml = await readDocxPartText(bytes, 'word/styles.xml')
  expect(documentXml).toBeDefined()
  return applyDocxTableBorders(host, readDocxTableFacts(documentXml ?? '', stylesXml))
}

type Edge = 'top' | 'right' | 'bottom' | 'left'

const toHex = (value: string): string => {
  const match = value.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
  if (!match) return value.toLowerCase()
  return `#${match
    .slice(1)
    .map((channel) => Number.parseInt(channel, 10).toString(16).padStart(2, '0'))
    .join('')}`
}

// Reads the rendered edge the way a reader sees it: thickness, kind, colour.
const renderedEdge = (cell: Element, edge: Edge): string => {
  const style = (cell as HTMLElement).style
  const width = style.getPropertyValue(`border-${edge}-width`)
  const kind = style.getPropertyValue(`border-${edge}-style`)
  const color = style.getPropertyValue(`border-${edge}-color`)
  if (!kind || kind === 'none') return 'none'
  return `${width} ${kind} ${toHex(color)}`
}

const cellAt = (
  host: HTMLElement,
  tableIndex: number,
  row: number,
  column: number
): HTMLTableCellElement => {
  const table = host.querySelectorAll('table')[tableIndex]
  return table.rows[row].cells[column]
}

describe('docx table border fidelity', () => {
  it('draws the rules a table declares only between its cells', async () => {
    const bytes = buildDocx(
      simpleTable(
        `<w:tblBorders>
          <w:insideH w:val="dotted" w:sz="8" w:color="FF00FF"/>
          <w:insideV w:val="dotted" w:sz="8" w:color="FF00FF"/>
        </w:tblBorders>`,
        [
          ['A1', 'A2'],
          ['B1', 'B2']
        ]
      )
    )
    const host = await renderDocx(bytes)

    // Recorded before the pass: the vendor renderer drops inner-only rules entirely.
    expect(renderedEdge(cellAt(host, 0, 0, 0), 'right')).toBe('none')
    expect(renderedEdge(cellAt(host, 0, 0, 0), 'bottom')).toBe('none')

    const application = await reconcile(host, bytes)

    expect(application).toMatchObject({
      tablesInSource: 1,
      tablesRendered: 1,
      tablesReconciled: 1,
      cellsTouched: 4,
      edgesApplied: 8,
      unpairedCells: 0
    })
    // Every cell keeps the table's frame absent, exactly as authored, and draws the inner grid.
    expect(renderedEdge(cellAt(host, 0, 0, 0), 'top')).toBe('none')
    expect(renderedEdge(cellAt(host, 0, 0, 0), 'right')).toBe('1pt dotted #ff00ff')
    expect(renderedEdge(cellAt(host, 0, 0, 0), 'bottom')).toBe('1pt dotted #ff00ff')
    expect(renderedEdge(cellAt(host, 0, 1, 1), 'left')).toBe('1pt dotted #ff00ff')
    expect(renderedEdge(cellAt(host, 0, 1, 1), 'right')).toBe('none')
    expect(renderedEdge(cellAt(host, 0, 1, 1), 'bottom')).toBe('none')
  })

  it('keeps a heavy frame and a hairline grid apart', async () => {
    const bytes = buildDocx(
      simpleTable(
        `<w:tblBorders>
          <w:top w:val="double" w:sz="24" w:color="00AA00"/>
          <w:left w:val="double" w:sz="24" w:color="00AA00"/>
          <w:bottom w:val="double" w:sz="24" w:color="00AA00"/>
          <w:right w:val="double" w:sz="24" w:color="00AA00"/>
          <w:insideH w:val="single" w:sz="4" w:color="999999"/>
          <w:insideV w:val="single" w:sz="4" w:color="999999"/>
        </w:tblBorders>`,
        [
          ['A1', 'A2'],
          ['B1', 'B2']
        ]
      )
    )
    const host = await renderDocx(bytes)
    // Recorded before the pass: the frame's weight is painted on the internal rules too.
    expect(renderedEdge(cellAt(host, 0, 0, 0), 'right')).toBe('3pt double #00aa00')

    const application = await reconcile(host, bytes)
    expect(application.edgesApplied).toBe(16)

    expect(renderedEdge(cellAt(host, 0, 0, 0), 'top')).toBe('3pt double #00aa00')
    expect(renderedEdge(cellAt(host, 0, 0, 0), 'left')).toBe('3pt double #00aa00')
    expect(renderedEdge(cellAt(host, 0, 0, 0), 'right')).toBe('0.5pt solid #999999')
    expect(renderedEdge(cellAt(host, 0, 0, 0), 'bottom')).toBe('0.5pt solid #999999')
    expect(renderedEdge(cellAt(host, 0, 1, 1), 'right')).toBe('3pt double #00aa00')
    expect(renderedEdge(cellAt(host, 0, 1, 1), 'bottom')).toBe('3pt double #00aa00')
    expect(renderedEdge(cellAt(host, 0, 1, 1), 'top')).toBe('0.5pt solid #999999')
    expect(renderedEdge(cellAt(host, 0, 1, 1), 'left')).toBe('0.5pt solid #999999')
  })

  it('resolves the frame a table takes from its table style', async () => {
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${WORD_NS}">${DOC_DEFAULTS}
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>
<w:top w:val="single" w:sz="4" w:color="auto"/>
<w:left w:val="single" w:sz="4" w:color="auto"/>
<w:bottom w:val="single" w:sz="4" w:color="auto"/>
<w:right w:val="single" w:sz="4" w:color="auto"/>
<w:insideH w:val="single" w:sz="4" w:color="auto"/>
<w:insideV w:val="single" w:sz="4" w:color="auto"/>
</w:tblBorders></w:tblPr></w:style>
</w:styles>`
    const bytes = buildDocx(
      simpleTable('<w:tblStyle w:val="TableGrid"/>', [
        ['D1', 'D2'],
        ['E1', 'E2']
      ]),
      styles
    )
    const host = await renderDocx(bytes)
    // Recorded before the pass: a styled table renders with no rules at all.
    expect(renderedEdge(cellAt(host, 0, 0, 0), 'top')).toBe('none')
    expect(renderedEdge(cellAt(host, 0, 0, 0), 'right')).toBe('none')

    const application = await reconcile(host, bytes)
    expect(application.tablesReconciled).toBe(1)
    expect(renderedEdge(cellAt(host, 0, 0, 0), 'top')).toBe('0.5pt solid #000000')
    expect(renderedEdge(cellAt(host, 0, 0, 0), 'right')).toBe('0.5pt solid #000000')
    expect(renderedEdge(cellAt(host, 0, 1, 1), 'bottom')).toBe('0.5pt solid #000000')
  })

  it('lets a cell keep the rule it declares for itself', async () => {
    const table = `<w:tbl><w:tblPr><w:tblBorders>
        <w:top w:val="single" w:sz="4" w:color="000000"/>
        <w:insideH w:val="single" w:sz="4" w:color="999999"/>
        <w:insideV w:val="single" w:sz="4" w:color="999999"/>
      </w:tblBorders></w:tblPr>${GRID}
      <w:tr>
        <w:tc><w:tcPr><w:tcBorders><w:right w:val="thick" w:sz="24" w:color="0000FF"/></w:tcBorders></w:tcPr>${paragraph('C1')}</w:tc>
        <w:tc>${paragraph('C2')}</w:tc>
      </w:tr>
    </w:tbl>`
    const bytes = buildDocx(table)
    const host = await renderDocx(bytes)

    await reconcile(host, bytes)

    // The cell's own 3pt blue rule survives the table's inner grid.
    expect(renderedEdge(cellAt(host, 0, 0, 0), 'right')).toBe('3pt solid #0000ff')
    expect(renderedEdge(cellAt(host, 0, 0, 1), 'left')).toBe('0.5pt solid #999999')
  })

  it('adds nothing to a table whose author declared nothing', async () => {
    const bytes = buildDocx(simpleTable('', [['F1', 'F2']]))
    const host = await renderDocx(bytes)

    const application = await reconcile(host, bytes)

    expect(application.tablesReconciled).toBe(0)
    expect(application.edgesApplied).toBe(0)
    for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
      expect(renderedEdge(cellAt(host, 0, 0, 0), edge)).toBe('none')
    }
  })

  it('reads a vertically merged cell as one cell and draws no rule through it', async () => {
    const table = `<w:tbl><w:tblPr><w:tblBorders>
        <w:top w:val="double" w:sz="24" w:color="00AA00"/>
        <w:bottom w:val="double" w:sz="24" w:color="00AA00"/>
        <w:insideH w:val="single" w:sz="4" w:color="999999"/>
        <w:insideV w:val="single" w:sz="4" w:color="999999"/>
      </w:tblBorders></w:tblPr>${GRID}
      <w:tr>
        <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${paragraph('Span')}</w:tc>
        <w:tc>${paragraph('r0c1')}</w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
        <w:tc>${paragraph('r1c1')}</w:tc>
      </w:tr>
    </w:tbl>`
    const bytes = buildDocx(table)
    const host = await renderDocx(bytes)

    const documentXml = await readDocxPartText(bytes, 'word/document.xml')
    const facts = readDocxTableFacts(documentXml ?? '')
    // Three cells in the file, and the merged one spans both rows.
    expect(facts[0].cells).toHaveLength(3)
    expect(facts[0].cells[0]).toMatchObject({ row: 0, column: 0, rowSpan: 2, columnSpan: 1 })

    const application = applyDocxTableBorders(host, facts)

    expect(application.unpairedCells).toBe(0)
    expect(application.tablesReconciled).toBe(1)
    const merged = cellAt(host, 0, 0, 0)
    expect(merged.rowSpan).toBe(2)
    // The merge's own bottom edge is the table's frame, not an inner rule.
    expect(renderedEdge(merged, 'bottom')).toBe('3pt double #00aa00')
    expect(renderedEdge(merged, 'right')).toBe('0.5pt solid #999999')
  })

  it('reports a grid it could not pair instead of guessing cell rules', async () => {
    const bytes = buildDocx(
      simpleTable(
        '<w:tblBorders><w:insideV w:val="single" w:sz="4" w:color="999999"/></w:tblBorders>',
        [['G1', 'G2']]
      )
    )
    const host = await renderDocx(bytes)
    const falsified = [
      { ...readDocxTableFacts((await readDocxPartText(bytes, 'word/document.xml')) ?? '')[0] }
    ]
    // Claim one more source cell than the document renders: the pass must say so, not shift rules.
    falsified[0].cells = [
      ...falsified[0].cells,
      { row: 0, column: 2, columnSpan: 1, rowSpan: 1, borders: {} }
    ]

    const application = applyDocxTableBorders(host, falsified)

    expect(application.unpairedCells).toBe(1)
    expect(renderedEdge(cellAt(host, 0, 0, 0), 'right')).toBe('0.5pt solid #999999')
  })
})

describe('readDocxPartText', () => {
  it('returns a part’s text and reports a missing part as absent', async () => {
    const bytes = buildDocx(paragraph('hello'))

    await expect(readDocxPartText(bytes, 'word/document.xml')).resolves.toContain('hello')
    await expect(readDocxPartText(bytes, 'word/styles.xml')).resolves.toBeUndefined()
  })

  it('reports bytes that are not a package as absent rather than throwing', async () => {
    await expect(
      readDocxPartText(new Uint8Array([1, 2, 3]), 'word/document.xml')
    ).resolves.toBeUndefined()
  })
})
