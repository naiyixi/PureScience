import { describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import type { ToolDescriptor } from '../types'
import { VARIANTS_CADD_TOOLS } from './variants-cadd'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const tool = (id: string): ToolDescriptor => VARIANTS_CADD_TOOLS.find((t) => t.id === id)!

const run = async (
  id: string,
  args: Record<string, unknown>,
  body: unknown
): Promise<{ out: unknown; url: string }> => {
  const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(body))
  const out = await new ParserEngine({ fetchImpl }).call(tool(id), args, {})
  const [url] = fetchImpl.mock.calls[0] as [string]
  return { out, url }
}

describe('variants-cadd', () => {
  it('exports the 2 tools in order, all under the variants connector', () => {
    expect(VARIANTS_CADD_TOOLS.map((t) => t.id)).toEqual([
      'cadd_score_variant',
      'cadd_score_at_position'
    ])
    expect(VARIANTS_CADD_TOOLS.every((t) => t.connector === 'variants')).toBe(true)
  })

  it('cadd_score_variant: queries the position endpoint with ref/alt, parses string scores into numbers + band', async () => {
    const { out, url } = await run(
      'cadd_score_variant',
      { chrom: '7', pos: 55249071, ref: 'c', alt: 't' },
      [{ Alt: 'T', Chrom: '7', PHRED: '29.5', Pos: '55249071', RawScore: '4.210661', Ref: 'C' }]
    )
    expect(url).toBe('https://cadd.gs.washington.edu/api/v1.0/GRCh37-v1.6/7:55249071_C_T')
    expect(out).toMatchObject({
      variant_id: '7:55249071:C:T',
      phred_score: 29.5,
      raw_score: 4.210661,
      severity_band: 'medium-high (top 1%)'
    })
  })

  it('cadd_score_variant: honors an explicit version override', async () => {
    const { url } = await run(
      'cadd_score_variant',
      { chrom: '7', pos: 55249071, ref: 'C', alt: 'T', version: 'GRCh38-v1.7' },
      []
    )
    expect(url).toBe('https://cadd.gs.washington.edu/api/v1.0/GRCh38-v1.7/7:55249071_C_T')
  })

  it('cadd_score_variant: reports found:false on an empty array (no score for build/allele)', async () => {
    const { out } = await run(
      'cadd_score_variant',
      { chrom: '7', pos: 55249071, ref: 'C', alt: 'T' },
      []
    )
    expect(out).toMatchObject({ variant_id: '7:55249071:C:T', found: false })
  })

  it('cadd_score_variant: rejects invalid chromosomes, alleles, and versions', async () => {
    const fetchImpl = vi.fn()
    const engine = new ParserEngine({ fetchImpl })
    await expect(
      engine.call(tool('cadd_score_variant'), { chrom: 'Z', pos: 1, ref: 'A', alt: 'G' }, {})
    ).rejects.toThrow(/invalid chromosome/)
    await expect(
      engine.call(tool('cadd_score_variant'), { chrom: '1', pos: 1, ref: 'X', alt: 'G' }, {})
    ).rejects.toThrow(/DNA allele/)
    await expect(
      engine.call(
        tool('cadd_score_variant'),
        { chrom: '1', pos: 1, ref: 'A', alt: 'G', version: 'bogus' },
        {}
      )
    ).rejects.toThrow(/unknown CADD version/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('cadd_score_at_position: returns all three SNV alternatives at a position', async () => {
    const { out, url } = await run('cadd_score_at_position', { chrom: '5', pos: 2003402 }, [
      { Alt: 'A', Chrom: '5', PHRED: '0.850', Pos: '2003402', RawScore: '-0.251851', Ref: 'C' },
      { Alt: 'G', Chrom: '5', PHRED: '1.200', Pos: '2003402', RawScore: '-0.1', Ref: 'C' },
      { Alt: 'T', Chrom: '5', PHRED: '2.5', Pos: '2003402', RawScore: '0.3', Ref: 'C' }
    ])
    expect(url).toBe('https://cadd.gs.washington.edu/api/v1.0/GRCh37-v1.6/5:2003402')
    expect(out).toMatchObject({
      chrom: '5',
      pos: 2003402,
      version: 'GRCh37-v1.6',
      count: 3,
      scores: [
        { variant_id: '5:2003402:C:A', phred_score: 0.85, severity_band: 'low' },
        { variant_id: '5:2003402:C:G', phred_score: 1.2 },
        { variant_id: '5:2003402:C:T', phred_score: 2.5 }
      ]
    })
  })
})
