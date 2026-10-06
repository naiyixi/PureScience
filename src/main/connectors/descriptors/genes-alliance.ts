import type { ToolDescriptor } from '../types'

// Alliance of Genome Resources search API (api.alliancegenome.org). The `/search` endpoint returns a
// heterogeneous result set plus per-facet aggregations; this tool pins the server-side category to
// `gene_search_result` and reports both the applied filter and the species facet so a short list can
// be told apart from a narrow query. The returned `curie` (e.g. RGD:2218, HGNC:1100) is the identifier
// the Alliance gene endpoint and every cross-reference use — the numeric `id` is internal and is not
// exposed as the primary key.
const ALLIANCE_BASE = 'https://www.alliancegenome.org/api'
const GENE_CATEGORY = 'gene_search_result'

type Obj = Record<string, unknown>
const asObj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const strArr = (v: unknown): string[] =>
  asArr(v)
    .map((x) => str(x))
    .filter((s): s is string => Boolean(s))

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  const base = Number.isFinite(n) && v != null && v !== '' ? Math.trunc(n) : def
  return Math.min(hi, Math.max(lo, base))
}

type AllianceFacet = { key?: string; values?: Array<{ key?: string; total?: number }> }
type AllianceResult = {
  symbol?: string
  name?: string
  curie?: string
  id?: string
  species?: string
  soTermName?: string
  category?: string
  diseases?: string[]
  synonyms?: string[]
  automatedGeneDescription?: string
  geneDescription?: string
  crossReferences?: string[]
}

const geneRow = (r: AllianceResult): Obj => ({
  curie: r.curie ?? r.id,
  symbol: r.symbol,
  name: r.name,
  species: r.species ?? null,
  so_term_name: r.soTermName ?? null,
  diseases: strArr(r.diseases),
  synonyms: strArr(r.synonyms),
  cross_references: strArr(r.crossReferences),
  automated_gene_description: r.automatedGeneDescription ?? null,
  gene_description: r.geneDescription ?? null,
  alliance_url: r.curie ? `https://www.alliancegenome.org/gene/${r.curie}` : null
})

// "Genes across model organisms" — the Alliance search entry point. One tool: search genes by
// symbol/name/synonym and return the cross-species rows with their disease associations and
// cross-references, plus the species facet the service used to organise the matches.
export const GENES_ALLIANCE_TOOLS: ToolDescriptor[] = [
  {
    id: 'alliance_search_genes',
    connector: 'genes',
    description:
      'Search genes across the Alliance of Genome Resources model organisms (human, mouse, rat, zebrafish, fly, worm, yeast, Xenopus) by symbol, name or synonym. Pins the server-side result category to genes and returns, per matching gene, its Alliance CURIE (the identifier the gene endpoint and all cross-references use), symbol, full name, species, SO term, disease associations, synonyms, cross-references and the automated/gene description. An optional `species` narrows the page client-side (the count filtered is reported) and the service\'s own species facet is echoed. Args: query (required); species (e.g. "Homo sapiens"); limit (<=100); page (1-based). Returns {query, category, species_filter, total, page, limit, n_returned, truncated, species_facet, genes:[...]}.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gene symbol, name or synonym, e.g. "BRCA1".' },
        species: {
          type: 'string',
          description: 'Client-side species filter, e.g. "Homo sapiens", "Mus musculus".'
        },
        limit: { type: 'integer', default: 20 },
        page: { type: 'integer', default: 1 }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '{query, category:"gene_search_result", species_filter:str|null, total (service total for the category), page, limit, n_returned, truncated, species_facet:[{species, total}], genes:[{curie, symbol, name, species, so_term_name, diseases:[str], synonyms:[str], cross_references:[str], automated_gene_description, gene_description, alliance_url}]}. `alliance_url` is the reader-navigable page for `curie`.',
    example:
      'const result = await host.mcp("genes", "alliance_search_genes", {"query": "BRCA1", "limit": 5})',
    run: async (ctx, a) => {
      const query = String(a.query).trim()
      if (!query) throw new Error('query must be a non-empty gene symbol, name or synonym')
      const limit = clampInt(a.limit, 20, 1, 100)
      const page = clampInt(a.page, 1, 1, 1_000_000)
      const speciesFilter = a.species != null ? String(a.species).trim() : ''

      const resp = asObj(
        await ctx.fetchJson(
          `${ALLIANCE_BASE}/search?q=${encodeURIComponent(query)}&category=${GENE_CATEGORY}&limit=${limit}&page=${page}`
        )
      )
      const rows = asArr(resp.results).map((r) => geneRow(r as AllianceResult))
      const filtered = speciesFilter
        ? rows.filter((g) => String(g.species ?? '').toLowerCase() === speciesFilter.toLowerCase())
        : rows

      // Echo the service's own species facet (aggregations[species]) — the applied server-side
      // condition, not our client-side filter.
      const facets = asArr(resp.aggregations).map((x) => x as AllianceFacet)
      const speciesFacet = (facets.find((f) => f.key === 'species')?.values ?? [])
        .filter((v): v is { key: string; total?: number } => typeof v.key === 'string')
        .map((v) => ({ species: v.key, total: typeof v.total === 'number' ? v.total : null }))

      const total = typeof resp.total === 'number' ? resp.total : rows.length
      return {
        query,
        category: GENE_CATEGORY,
        species_filter: speciesFilter || null,
        total,
        page,
        limit,
        n_returned: filtered.length,
        truncated: total > (page - 1) * limit + filtered.length,
        species_facet: speciesFacet,
        genes: filtered
      }
    }
  }
]
