import { describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import type { ToolDescriptor } from '../types'
import { CANCER_MODELS_TOOLS } from './cancer-models'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const tool = (id: string): ToolDescriptor => CANCER_MODELS_TOOLS.find((t) => t.id === id)!

// Runs a DepMap tool against a mocked GraphQL POST, returning output + the POSTed body.
async function runDepmap(
  id: string,
  args: Record<string, unknown>,
  body: unknown
): Promise<{ out: unknown; query: string; variables: Record<string, unknown> }> {
  const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(body))
  const out = await new ParserEngine({ fetchImpl }).call(tool(id), args, {})
  const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
  const parsed = JSON.parse(init.body as string) as {
    query: string
    variables: Record<string, unknown>
  }
  return { out, query: parsed.query, variables: parsed.variables }
}

describe('cancer-models DepMap tools', () => {
  it('exposes the two DepMap tools under the cancer_models connector', () => {
    const ids = CANCER_MODELS_TOOLS.map((t) => t.id)
    expect(ids).toContain('depmap_search_cell_line')
    expect(ids).toContain('depmap_dependencies_for_gene')
    const depmap = CANCER_MODELS_TOOLS.filter((t) => t.id.startsWith('depmap_'))
    expect(depmap.every((t) => t.connector === 'cancer_models')).toBe(true)
  })

  it('depmap_search_cell_line: POSTs the GraphQL query and merges direct + alias rows', async () => {
    const { out, query, variables } = await runDepmap(
      'depmap_search_cell_line',
      { query: 'A549' },
      {
        data: {
          cellLines: [{ model_id: 'ACH-000681', cell_line_name: 'A549', disease: 'Lung Cancer', lineage: 'Lung', sex: 'Male' }],
          cellLinesByAlias: []
        }
      }
    )
    expect(query).toContain('cellLines(modelId: $q)')
    expect(variables).toEqual({ q: 'A549' })
    expect(out).toMatchObject({
      query: 'A549',
      count: 1,
      cell_lines: [{ model_id: 'ACH-000681', cell_line_name: 'A549', disease: 'Lung Cancer' }]
    })
  })

  it('depmap_dependencies_for_gene: sorts by ascending Chronos (most dependent first)', async () => {
    const { out, variables } = await runDepmap(
      'depmap_dependencies_for_gene',
      { gene_symbol: 'KRAS' },
      {
        data: {
          gene: {
            id: 'KRAS',
            dependencies: [
              { model_id: 'ACH-1', cell_line_name: 'B', disease: 'Pancreas', chronos_score: -0.8 },
              { model_id: 'ACH-2', cell_line_name: 'A', disease: 'Colon', chronos_score: 0.2 },
              { model_id: 'ACH-3', cell_line_name: 'C', disease: 'Lung', chronos_score: -1.2 }
            ]
          }
        }
      }
    )
    expect(variables).toEqual({ g: 'KRAS' })
    expect(out).toMatchObject({
      gene_symbol: 'KRAS',
      found: true,
      count: 3,
      dependencies: [
        { model_id: 'ACH-3', chronos_score: -1.2 },
        { model_id: 'ACH-1', chronos_score: -0.8 },
        { model_id: 'ACH-2', chronos_score: 0.2 }
      ]
    })
  })

  it('depmap_dependencies_for_gene: reports found:false for unknown genes', async () => {
    const { out } = await runDepmap('depmap_dependencies_for_gene', { gene_symbol: 'ZZZ' }, {
      data: { gene: null }
    })
    expect(out).toMatchObject({ gene_symbol: 'ZZZ', found: false, count: 0, dependencies: [] })
  })

  it('depmap_dependencies_for_gene: rejects an empty gene symbol', async () => {
    const fetchImpl = vi.fn()
    const engine = new ParserEngine({ fetchImpl })
    await expect(
      engine.call(tool('depmap_dependencies_for_gene'), { gene_symbol: '  ' }, {})
    ).rejects.toThrow(/gene_symbol is required/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
