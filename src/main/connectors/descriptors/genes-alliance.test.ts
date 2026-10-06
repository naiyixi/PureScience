import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { GENES_ALLIANCE_TOOLS } from './genes-alliance'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => GENES_ALLIANCE_TOOLS.find((t) => t.id === id)!

const jsonRes = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    headers: { get: () => null }
  }) as unknown as Response
const engine = (fetchImpl: typeof fetch): ParserEngine =>
  new ParserEngine({ fetchImpl, retries: 0 })

type GeneRow = {
  curie: string
  alliance_url: string
  diseases: string[]
  cross_references: string[]
}
type SearchOut = {
  category: string
  total: number
  n_returned: number
  truncated: boolean
  species_filter: string | null
  species_facet: Array<{ species: string; total: number | null }>
  genes: GeneRow[]
}

// Shape captured live from /api/search?category=gene_search_result.
const SEARCH = {
  total: 136,
  aggregations: [
    {
      key: 'species',
      values: [
        { key: 'Homo sapiens', total: 41 },
        { key: 'Mus musculus', total: 15 }
      ]
    },
    { key: 'biotypes', values: [{ key: 'protein_coding_gene', total: 93 }] }
  ],
  results: [
    {
      symbol: 'BRCA1',
      name: 'BRCA1, DNA repair associated',
      curie: 'HGNC:1100',
      id: 999,
      species: 'Homo sapiens',
      soTermName: 'protein_coding_gene',
      category: 'gene_search_result',
      diseases: ['breast cancer'],
      synonyms: ['RNF53'],
      crossReferences: ['UniProtKB:P38398'],
      automatedGeneDescription: 'Enables chromatin binding activity.',
      geneDescription: null
    },
    {
      symbol: 'Brca1',
      name: 'BRCA1, DNA repair associated',
      curie: 'MGI:104537',
      species: 'Mus musculus',
      soTermName: 'protein_coding_gene',
      diseases: [],
      synonyms: [],
      crossReferences: []
    }
  ]
}

describe('alliance_search_genes', () => {
  it('pins category=gene_search_result and maps cross-species gene rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(SEARCH))
    const out = (await engine(fetchImpl).call(
      tool('alliance_search_genes'),
      { query: 'BRCA1', limit: 2 },
      {}
    )) as SearchOut

    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/search?q=BRCA1&category=gene_search_result&limit=2&page=1')
    expect(out.category).toBe('gene_search_result')
    expect(out.total).toBe(136)
    expect(out.n_returned).toBe(2)
    // 136 total > (page 1 => 0) + 2 returned.
    expect(out.truncated).toBe(true)
    expect(out.species_facet).toEqual([
      { species: 'Homo sapiens', total: 41 },
      { species: 'Mus musculus', total: 15 }
    ])
    expect(out.genes[0].curie).toBe('HGNC:1100')
    expect(out.genes[0].alliance_url).toBe('https://www.alliancegenome.org/gene/HGNC:1100')
    expect(out.genes[0].diseases).toEqual(['breast cancer'])
    expect(out.genes[0].cross_references).toEqual(['UniProtKB:P38398'])
  })

  it('applies the species filter client-side and reports it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(SEARCH))
    const out = (await engine(fetchImpl).call(
      tool('alliance_search_genes'),
      { query: 'BRCA1', species: 'Mus musculus' },
      {}
    )) as SearchOut
    expect(out.species_filter).toBe('Mus musculus')
    expect(out.n_returned).toBe(1)
    expect(out.genes[0].curie).toBe('MGI:104537')
  })

  it('rejects an empty query by name without a fetch', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(tool('alliance_search_genes'), { query: '   ' }, {})
    ).rejects.toThrow(/query must be a non-empty/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
