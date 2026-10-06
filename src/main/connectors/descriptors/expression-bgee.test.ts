import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { EXPRESSION_BGEE_TOOLS } from './expression-bgee'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => EXPRESSION_BGEE_TOOLS.find((t) => t.id === id)!

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
// Bgee answers an unknown gene with HTTP 404 (the engine turns that into an "HTTP 404" error).
const notFound = (): Response =>
  ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    json: async () => ({})
  }) as unknown as Response

const run = async (
  args: Record<string, unknown>,
  responses: Response[]
): Promise<{ out: Record<string, unknown>; urls: string[] }> => {
  const fetchImpl = vi.fn()
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r)
  const out = (await new ParserEngine({ fetchImpl }).call(
    tool('bgee_gene_expression'),
    args,
    {}
  )) as Record<string, unknown>
  return { out, urls: fetchImpl.mock.calls.map((c) => c[0] as string) }
}

const BGEE =
  'https://www.bgee.org/api/index.php?page=gene&action=expression&gene_id=ENSG00000141510&species_id=9606&display_type=json'

// Live 2026-10 envelope (trimmed to two calls), matching Bgee's real shape.
const ENVELOPE = {
  code: 200,
  status: 'SUCCESS',
  message: 'Gene expression for gene: ENSG00000141510 - TP53',
  data: {
    requestedCallType: 'EXPRESSED',
    requestedDataTypes: ['RNA-Seq'],
    requestedConditionParameters: ['Anat. entity', 'Cell type'],
    calls: [
      {
        condition: { anatEntity: { id: 'UBERON:0003053', name: 'ventricular zone' } },
        expressionScore: { expressionScore: '95.11', expressionScoreConfidence: 'high' },
        fdr: '<= 1.00e-14',
        dataTypesWithData: ['RNA-Seq'],
        expressionState: 'expressed',
        expressionQuality: 'gold',
        clusterIndex: 0
      },
      {
        condition: { cellType: { id: 'CL:0000000', name: 'cell' } },
        expressionState: 'not expressed'
      }
    ],
    gene: { geneId: 'ENSG00000141510', name: 'TP53', species: { id: 9606, name: 'human' } }
  }
}

describe('expression / bgee_gene_expression', () => {
  it('sends the Ensembl gene + taxon id and maps calls (service scores passed through)', async () => {
    const { out, urls } = await run({ gene_id: 'ENSG00000141510', species_id: '9606' }, [
      okJson(ENVELOPE)
    ])
    expect(urls[0]).toBe(BGEE)
    expect(out).toEqual({
      gene: { id: 'ENSG00000141510', name: 'TP53', species: { id: 9606, name: 'human' } },
      service_message: 'Gene expression for gene: ENSG00000141510 - TP53',
      call_type: 'EXPRESSED',
      data_types: ['RNA-Seq'],
      condition_parameters: ['Anat. entity', 'Cell type'],
      total_calls: 2,
      counts_by_state: { expressed: 1, 'not expressed': 1 },
      truncated: false,
      note: out.note,
      calls: [
        {
          anatomical_entity: { id: 'UBERON:0003053', name: 'ventricular zone' },
          cell_type: null,
          expression_state: 'expressed',
          expression_score: '95.11',
          score_confidence: 'high',
          fdr: '<= 1.00e-14',
          quality: 'gold',
          data_types: ['RNA-Seq'],
          cluster_index: 0
        },
        {
          anatomical_entity: null,
          cell_type: { id: 'CL:0000000', name: 'cell' },
          expression_state: 'not expressed',
          expression_score: undefined,
          score_confidence: undefined,
          fdr: undefined,
          quality: undefined,
          data_types: [],
          cluster_index: undefined
        }
      ]
    })
    expect(String(out.note)).toContain('NOT recomputed locally')
    // The score stays the service's string (no numeric coercion).
    expect(typeof (out.calls as Array<{ expression_score?: unknown }>)[0]!.expression_score).toBe(
      'string'
    )
  })

  it('caps calls at max_records and flags truncation', async () => {
    const { out } = await run({ gene_id: 'ENSG00000141510', species_id: '9606', max_records: 1 }, [
      okJson(ENVELOPE)
    ])
    expect(out).toMatchObject({ total_calls: 2, truncated: true })
    expect((out.calls as unknown[]).length).toBe(1)
  })

  it('refuses a bare gene symbol before the request (it would read as "not found")', async () => {
    await expect(run({ gene_id: 'TP53', species_id: '9606' }, [])).rejects.toThrow(
      /gene_id must be an Ensembl gene id/
    )
  })

  it('refuses a non-numeric species_id before the request', async () => {
    await expect(run({ gene_id: 'ENSG00000141510', species_id: 'human' }, [])).rejects.toThrow(
      /species_id must be a positive NCBI taxon id/
    )
  })

  it('names an unknown gene from the service 404', async () => {
    await expect(
      run({ gene_id: 'ENSG00000000001', species_id: '9606' }, [notFound()])
    ).rejects.toThrow(/Gene ENSG00000000001 is not in Bgee for species 9606 \(HTTP 404\)/)
  })

  it('registers the tool under the expression connector', () => {
    expect(tool('bgee_gene_expression').connector).toBe('expression')
  })
})

// Live self-test against the real Bgee service. Off by default; run with LIVE_API=1.
describe.skipIf(!process.env.LIVE_API)('expression / bgee_gene_expression (LIVE)', () => {
  it('returns real expression calls for human TP53', async () => {
    const out = (await new ParserEngine({ timeoutMs: 120_000 }).call(
      tool('bgee_gene_expression'),
      { gene_id: 'ENSG00000141510', species_id: '9606', max_records: 5 },
      {}
    )) as Record<string, unknown>
    expect((out.gene as Record<string, unknown>).id).toBe('ENSG00000141510')
    expect(Number(out.total_calls)).toBeGreaterThan(0)
    expect((out.calls as unknown[]).length).toBeGreaterThan(0)
  }, 60_000)

  it('resolves a mouse gene across species', async () => {
    const out = (await new ParserEngine({ timeoutMs: 120_000 }).call(
      tool('bgee_gene_expression'),
      { gene_id: 'ENSMUSG00000059552', species_id: '10090', max_records: 3 },
      {}
    )) as Record<string, unknown>
    expect((out.gene as Record<string, unknown>).species).toMatchObject({ id: 10090 })
    expect(Number(out.total_calls)).toBeGreaterThan(0)
  }, 60_000)
})
