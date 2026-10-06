import type { ToolDescriptor } from '../types'

// Pathway Commons (pc2) — a BioPAX aggregator federating Reactome, WikiPathways, BioGRID, CTD,
// SIGNOR, ... as pathways and molecular interactions. /search is its one read-only JSON surface
// (the /get and /graph routes answer RDF; the live /graph neighborhood query timed out).
//
// Verified live (2026-10): GET /search?q=TP53&type=Pathway&format=json&limit=2 answers
//   { numHits, maxHitsPerPage: 100, searchHit: [ { uri, biopaxClass, name, dataSource, organism,
//   pathway, numParticipants, numProcesses } ], pageNo, comment, version, providers, empty }.
// Two facts drive the code below:
//   1. An unknown `type` is answered with a bare HTTP 400, so the BioPAX-class whitelist is
//      enforced locally and a bad value is named here rather than turned into a 400.
//   2. The server silently caps a page at maxHitsPerPage (100), so a limit > 100 is refused with
//      guidance instead of being quietly clamped to 100.
const PC = 'https://www.pathwaycommons.org/pc2'
const MAX_HITS_PER_PAGE = 100
const DEFAULT_LIMIT = 25

// BioPAX class names /search accepts as `type` (verified live; case-insensitive). `Interaction` is
// a category that returns control/conversion/molecular-interaction rows, not a single class.
const SEARCH_TYPES = [
  'Pathway',
  'Protein',
  'PhysicalEntity',
  'Complex',
  'SmallMolecule',
  'Gene',
  'Interaction',
  'BiochemicalReaction',
  'Catalysis',
  'Conversion',
  'Control',
  'Transport',
  'Dna',
  'Rna',
  'MolecularInteraction',
  'GeneticInteraction',
  'Degradation',
  'TemplateReaction'
]

type PcHit = {
  uri?: string
  biopaxClass?: string
  name?: string
  dataSource?: string[]
  organism?: string[]
  numParticipants?: number
  numProcesses?: number
  pathway?: string[]
}
type PcSearchResponse = {
  numHits?: number
  maxHitsPerPage?: number
  searchHit?: PcHit[]
  pageNo?: number
  comment?: string
  version?: string
  providers?: string[]
  empty?: boolean
}

const enc = (s: string): string => encodeURIComponent(s)

// The service returns bioregistry / pc-namespaced URIs (e.g. "http://bioregistry.io/reactome:R-HSA-9723905",
// "pc14:reactome", "identifiers.org/uniprot/P04637"); translate them to the prefix:id a reader can
// query directly. This is the §1 "translate the service's internal id into a readable one" step.
function shortId(uri: string): string {
  let s = String(uri).replace(/^https?:\/\//i, '')
  s = s.replace(/^bioregistry\.io\//i, '')
  s = s.replace(/^pc\d+:/i, '')
  s = s.replace(/^identifiers\.org\//i, '')
  if (!s.includes(':')) {
    const m = s.match(/^([A-Za-z0-9_.-]+)\/(.+)$/)
    if (m) s = `${m[1]}:${m[2]}`
  }
  return s
}

// organism URIs resolve to ncbitaxon:<taxid>; surface the bare taxon id (9606) a reader expects.
function taxonId(uri: string): string {
  const s = shortId(uri)
  const m = s.match(/^ncbitaxon:(\d+)$/i)
  return m ? m[1] : s
}

// Case-insensitive match against the verified whitelist, returning the canonical spelling to send.
function canonicalType(value: unknown): string | undefined {
  const v = String(value).toLowerCase()
  return SEARCH_TYPES.find((t) => t.toLowerCase() === v)
}

export const PATHWAY_COMMONS_TOOLS: ToolDescriptor[] = [
  {
    id: 'search_pathway_commons',
    connector: 'genes',
    description:
      'Search Pathway Commons (BioPAX; Reactome, WikiPathways, BioGRID, CTD, SIGNOR, ...) for pathways, proteins, complexes, small molecules, genes, and molecular/genetic interactions by free text. `type` selects the BioPAX class (default "Pathway"; "Interaction" returns control/conversion/molecular-interaction rows). organism is an NCBI taxon id and datasource a provider name (e.g. "Reactome"); both filter server-side. Returns the page of hits with the true total, so more pages can be read with `page`. The service caps a page at 100 hits — a larger `limit` is refused rather than clamped.',
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query, e.g. "TP53", "apoptosis"' },
        type: {
          type: 'string',
          default: 'Pathway',
          description:
            'BioPAX class to search: Pathway, Protein, PhysicalEntity, Complex, SmallMolecule, Gene, Interaction, BiochemicalReaction, Catalysis, Conversion, Control, Transport, Dna, Rna, MolecularInteraction, GeneticInteraction, Degradation, TemplateReaction (case-insensitive).'
        },
        organism: { type: 'string', description: 'NCBI taxon id filter, e.g. "9606" (human)' },
        datasource: { type: 'string', description: 'Data-provider filter, e.g. "Reactome"' },
        limit: { type: 'integer', default: 25, description: 'Hits per page, 1–100.' },
        page: { type: 'integer', default: 0, description: 'Zero-based page number.' }
      },
      required: ['query']
    },
    required: ['query'],
    returns:
      '`{ query, type, page, filters: { type, organism, datasource }, resource_version, service_comment, total (API numHits), n_returned, max_hits_per_page, truncated, empty, hits: [ { name, biopax_class, identifier, uri, data_sources: [str], organism_taxids: [str], num_participants, num_processes, parent_pathways: [str] } ] }`. `identifier`/`data_sources`/`organism_taxids`/`parent_pathways` are the service URIs translated to reader-queryable `prefix:id` form; `truncated` is true when more hits remain beyond this page.',
    example:
      'const result = await host.mcp("genes", "search_pathway_commons", {"query": "TP53", "type": "Pathway", "organism": "9606", "limit": 25})',
    run: async (ctx, a) => {
      const query = String(a.query ?? '').trim()
      if (!query) throw new Error('query is required')
      const type = canonicalType(a.type ?? 'Pathway')
      if (!type) {
        throw new Error(
          `Unknown search type "${String(a.type)}". Allowed types: ${SEARCH_TYPES.join(', ')}`
        )
      }
      const limit = Number(a.limit ?? DEFAULT_LIMIT)
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HITS_PER_PAGE) {
        throw new Error(
          `limit must be an integer between 1 and ${MAX_HITS_PER_PAGE} (the server caps a page at ${MAX_HITS_PER_PAGE}); read further pages with the "page" argument instead of raising limit`
        )
      }
      const page = a.page == null ? 0 : Number(a.page)
      if (!Number.isInteger(page) || page < 0) throw new Error('page must be an integer >= 0')
      const organism =
        a.organism != null && String(a.organism).trim() !== ''
          ? String(a.organism).trim()
          : undefined
      const datasource =
        a.datasource != null && String(a.datasource).trim() !== ''
          ? String(a.datasource).trim()
          : undefined

      let url =
        `${PC}/search?q=${enc(query)}&type=${enc(type)}&format=json` +
        `&limit=${limit}&page=${page}`
      if (organism) url += `&organism=${enc(organism)}`
      if (datasource) url += `&datasource=${enc(datasource)}`

      const resp = (await ctx.fetchJson(url)) as PcSearchResponse
      const hits = resp.searchHit ?? []
      const total = resp.numHits ?? 0
      const maxPer = resp.maxHitsPerPage ?? MAX_HITS_PER_PAGE
      const pageNo = resp.pageNo ?? page
      const consumed = pageNo * maxPer + hits.length

      return {
        query,
        type,
        page: pageNo,
        filters: { type, organism: organism ?? null, datasource: datasource ?? null },
        resource_version: resp.version ?? null,
        service_comment: resp.comment ?? null,
        total,
        n_returned: hits.length,
        max_hits_per_page: maxPer,
        truncated: consumed < total,
        empty: resp.empty === true || hits.length === 0,
        hits: hits.map((h) => ({
          name: h.name,
          biopax_class: h.biopaxClass,
          identifier: h.uri ? shortId(h.uri) : undefined,
          uri: h.uri,
          data_sources: (h.dataSource ?? []).map(shortId),
          organism_taxids: (h.organism ?? []).map(taxonId),
          num_participants: h.numParticipants,
          num_processes: h.numProcesses,
          parent_pathways: (h.pathway ?? []).map(shortId)
        }))
      }
    }
  }
]
