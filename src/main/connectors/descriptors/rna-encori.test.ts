import { describe, expect, it, vi } from 'vitest'

import { ParserEngine } from '../engine'
import type { ToolDescriptor } from '../types'
import { RNA_ENCORI_TOOLS } from './rna-encori'

const tool = (id: string): ToolDescriptor => RNA_ENCORI_TOOLS.find((t) => t.id === id)!

const textRes = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as unknown as Response

// The service sends two comment lines, then its own header, then rows — with a column this reader does not
// document, which must stay visible in `columns` rather than being dropped.
const encoriTable = [
  '#please cite:',
  '#Keren Zhou et al. 2024, Nucleic Acids Research',
  'miRNAid\tmiRNAname\tgeneID\tgeneName\tbrandNewColumn',
  'MIMAT0000062\thsa-let-7a-5p\tENSG00000141510\tTP53\t9',
  'MIMAT0000076\thsa-miR-21-5p\tENSG00000141510\tTP53\t8'
].join('\n')

describe('encori_mirna_target', () => {
  it('returns the service own header and rows, keeping its citation lines', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(textRes(encoriTable))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('encori_mirna_target'),
      { target: 'TP53' },
      {}
    )) as {
      citation: string[]
      columns: string[]
      absent_columns: string[]
      n_rows_returned: number
      n_rows_in_response: number
      truncated: boolean
      rows: Array<Record<string, string>>
    }
    const url = String(fetchImpl.mock.calls[0][0])

    expect(url).toContain('/miRNATarget/?assembly=hg38&geneType=mRNA&miRNA=all')
    expect(url).toContain('&clipExpNum=1&degraExpNum=0&pancancerNum=0')
    expect(url).toContain('&target=TP53')
    // The citation the service asks for is carried, not dropped.
    expect(out.citation).toEqual(['please cite:', 'Keren Zhou et al. 2024, Nucleic Acids Research'])
    // Its header is quoted verbatim, including a column this reader does not document.
    expect(out.columns).toContain('brandNewColumn')
    // A documented column the service no longer sends is named rather than silently absent.
    expect(out.absent_columns).toContain('clipExpNum')
    expect(out.rows).toHaveLength(2)
    expect(out.rows[0].miRNAid).toBe('MIMAT0000062')
    expect(out.rows[1].miRNAname).toBe('hsa-miR-21-5p')
    // A row carries only the columns the header actually has.
    expect(out.rows[0].clipExpNum).toBeUndefined()
    expect(out.n_rows_in_response).toBe(2)
    expect(out.truncated).toBe(false)
  })

  it('caps rows but reports the count this response carried, so a short list says it is short', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(textRes(encoriTable))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('encori_mirna_target'),
      { target: 'TP53', max_rows: 1 },
      {}
    )) as { n_rows_returned: number; n_rows_in_response: number; truncated: boolean }

    expect(out.n_rows_returned).toBe(1)
    expect(out.n_rows_in_response).toBe(2)
    expect(out.truncated).toBe(true)
  })

  it('an empty table says the filters found nothing here, never that no interaction exists', async () => {
    const headerOnly = ['#please cite:', '#Someone 2024', 'miRNAid\tmiRNAname\tgeneID'].join('\n')
    const fetchImpl = vi.fn().mockResolvedValueOnce(textRes(headerOnly))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('encori_mirna_target'),
      { target: 'TP53', mirna: 'hsa-miR-21-5p' },
      {}
    )) as { rows: unknown[]; note?: string; n_rows_in_response: number }

    expect(out.rows).toEqual([])
    expect(out.n_rows_in_response).toBe(0)
    expect(out.note).toContain('not a statement that no interaction exists')
  })

  it('refuses an unnamed gene, an assembly it does not ship, and a gene type it does not offer, with no request', async () => {
    const fetchImpl = vi.fn()
    const missing = (await new ParserEngine({ fetchImpl }).call(
      tool('encori_mirna_target'),
      { target: '   ' },
      {}
    )) as { error: string }
    const assembly = (await new ParserEngine({ fetchImpl }).call(
      tool('encori_mirna_target'),
      { target: 'TP53', assembly: 'hg19' },
      {}
    )) as { error: string }
    const geneType = (await new ParserEngine({ fetchImpl }).call(
      tool('encori_mirna_target'),
      { target: 'TP53', gene_type: 'miRNA' },
      {}
    )) as { error: string }

    expect(missing.error).toBe('target-required')
    expect(assembly.error).toBe('unsupported-assembly')
    expect(geneType.error).toBe('unsupported-gene-type')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('an HTTP-200 outage body is refused by name, not parsed into rows', async () => {
    // The service answers 200 with its own PHP warning while its database is down.
    const outage = [
      '<br />',
      '<b>Warning</b>:  mysqli_connect(): (HY000/2002): Connection refused in <b>/www/wwwroot/html/encori/api/baseFunc.php</b> on line <b>18</b><br />',
      'Connect to database fail!'
    ].join('\n')
    const fetchImpl = vi.fn().mockResolvedValueOnce(textRes(outage))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('encori_mirna_target'),
      { target: 'TP53' },
      {}
    )) as {
      error: string
      message: string
      rows?: unknown
    }

    expect(out.error).toBe('source-unreadable')
    expect(out.message).toContain('Connect to database fail!')
    expect(out.rows).toBeUndefined()
  })
})
