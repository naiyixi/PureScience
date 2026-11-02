import type { ToolContext, ToolDescriptor } from '../types'

// OmniPath (Saezlab) — a harmonised integration of signalling, enzyme–substrate and annotation resources.
// Three read-only endpoints are exposed here, each answering a JSON array (measured 2026-11-02):
//   /interactions  directed/stimulatory/inhibitory edges between genes or proteins
//   /annotations   per-protein labels from resources such as CollecTRI, HPA, GO
//   /enzsub        enzyme → substrate residue modifications
//
// Two behaviours worth knowing before calling:
//   * `entities` is NOT a parameter (it answers "Unknown argument: entities"); the filter is `partners`
//     for interactions, `proteins` for annotations and `enzymes` / `substrates` for enzsub.
//   * a bad argument comes back as HTTP 200 whose body is [["Something is not entirely good: …"]], so the
//     shape of the answer — not the status — is what says the call was rejected.
const BASE = 'https://omnipathdb.org'

const MAX_LIMIT = 500
const DEFAULT_LIMIT = 50
// A short pause is what the service asks for; a single tool call is one request, never a crawl.
const CACHE_BUSTER = ''

type RawRecord = Record<string, unknown>

const looksLikeServiceRejection = (payload: unknown): string | null => {
  if (!Array.isArray(payload) || payload.length === 0) return null
  const first = payload[0]
  if (
    Array.isArray(first) &&
    typeof first[0] === 'string' &&
    first[0].includes('not entirely good')
  ) {
    return first[0].replace(/\s+/g, ' ').trim()
  }
  return null
}

const asRecords = (payload: unknown): RawRecord[] =>
  Array.isArray(payload)
    ? (payload.filter((entry) => entry && typeof entry === 'object') as RawRecord[])
    : []

const csvArg = (value: unknown): string | null => {
  if (Array.isArray(value)) {
    const list = value.map((entry) => String(entry).trim()).filter(Boolean)
    return list.length > 0 ? list.join(',') : null
  }
  const text = String(value ?? '').trim()
  return text === '' ? null : text
}

const clampLimit = (value: unknown): number => {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)))
}

const buildUrl = (path: string, params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  search.set('format', 'json')
  return `${BASE}${path}?${search.toString()}${CACHE_BUSTER}`
}

const fetchRecords = async (
  ctx: ToolContext,
  url: string
): Promise<{ records: RawRecord[] } | { error: string; message: string }> => {
  const payload = await ctx.fetchJson(url)
  const rejection = looksLikeServiceRejection(payload)
  if (rejection) return { error: 'argument-rejected', message: rejection }
  const records = asRecords(payload)
  // An object with a `record_id`-less shape is not something this API produces; refuse rather than
  // reporting "0 interactions", which would claim the biology instead of the parse.
  if (!Array.isArray(payload)) {
    return {
      error: 'unexpected-shape',
      message: `OmniPath answered ${typeof payload} where an array was expected.`
    }
  }
  return { records }
}

export const OMNIPATH_TOOLS: ToolDescriptor[] = [
  {
    id: 'omnipath_interactions',
    connector: 'omnipath',
    description:
      'Directed signalling interactions between genes/proteins as OmniPath integrates them, with the direction and the sign kept apart. Args: partners (one symbol or a comma list, e.g. "TP53" or "TP53,MDM2"; UniProt ids also work), limit (1–500, default 50), datasets (optional comma list of resource names), organisms (NCBI taxon id, default 9606 human). Returns {source, partners, n_interactions, truncated, interactions: [{source, target, source_genesymbol, target_genesymbol, is_directed, is_stimulation, is_inhibition, consensus_direction, consensus_stimulation, consensus_inhibition, ...resource-specific fields}]} or a named error. `is_stimulation` and `is_inhibition` are NOT opposites: both absent means the resource recorded the edge without a sign, and consensus_* says whether the underlying resources agree. An unknown argument is refused by name (`argument-rejected`) because the service answers 200 with a sentence, not a 4xx. Requires network access to omnipathdb.org.',
    input: {
      type: 'object',
      properties: {
        partners: { type: 'string', description: 'Gene symbol or comma list, e.g. TP53,MDM2' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        datasets: { type: 'string', description: 'Optional comma list of OmniPath resources' },
        organisms: { type: 'string', description: 'NCBI taxonomy id, default 9606 (human)' }
      },
      required: ['partners']
    },
    required: ['partners'],
    returns:
      '{source, partners, n_interactions, truncated, interactions[]} or {error: argument-rejected|unexpected-shape|source-unreadable, message}',
    example:
      'const result = await host.mcp("omnipath", "omnipath_interactions", {"partners": "TP53", "limit": 20})',
    format: 'json',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const partners = csvArg(a.partners)
      if (!partners) return { error: 'argument-rejected', message: 'partners is required.' }
      const limit = clampLimit(a.limit)
      const url = buildUrl('/interactions', {
        genesymbols: 1,
        partners,
        limit,
        datasets: csvArg(a.datasets) ?? undefined,
        organisms: csvArg(a.organisms) ?? '9606'
      })
      const fetched = await fetchRecords(ctx, url)
      if ('error' in fetched) return fetched
      return {
        source: 'OmniPath',
        partners,
        n_interactions: fetched.records.length,
        truncated: fetched.records.length >= limit,
        interactions: fetched.records
      }
    }
  },
  {
    id: 'omnipath_annotations',
    connector: 'omnipath',
    description:
      'Per-protein annotations from OmniPath’s integrated resources — each row names the resource that made the claim, the label it used and the value it assigned. Args: proteins (one symbol or comma list, e.g. "TP53"), limit (1–500, default 50), resources (optional comma list, e.g. "CollecTRI,Adhesome") — this endpoint has NO organism filter, unlike the other two. Returns {source, proteins, n_annotations, truncated, annotations: [{uniprot, genesymbol, entity_type, source, label, value, record_id}]} or a named error. `label` is the resource’s own vocabulary ("tf_type", "location", "indication" …) and `value` is its answer, so two rows with the same protein and different labels are different claims rather than a contradiction. Requires network access to omnipathdb.org.',
    input: {
      type: 'object',
      properties: {
        proteins: { type: 'string', description: 'Gene symbol or comma list, e.g. TP53' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        resources: { type: 'string', description: 'Optional comma list of resources' }
      },
      required: ['proteins']
    },
    required: ['proteins'],
    returns:
      '{source, proteins, n_annotations, truncated, annotations[]} or {error: argument-rejected|unexpected-shape|source-unreadable, message}',
    example:
      'const result = await host.mcp("omnipath", "omnipath_annotations", {"proteins": "TP53", "resources": "CollecTRI"})',
    format: 'json',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const proteins = csvArg(a.proteins)
      if (!proteins) return { error: 'argument-rejected', message: 'proteins is required.' }
      const limit = clampLimit(a.limit)
      // `/annotations` refuses `organisms` outright ("Unknown argument: organisms", measured 2026-11-02),
      // unlike `/interactions` and `/enzsub`. Sending it would turn a valid query into a rejection, so a
      // caller's organism filter is answered honestly: unsupported here, and said in the result.
      const url = buildUrl('/annotations', {
        proteins,
        limit,
        resources: csvArg(a.resources) ?? undefined
      })
      const fetched = await fetchRecords(ctx, url)
      if ('error' in fetched) return fetched
      return {
        source: 'OmniPath',
        proteins,
        // The endpoint has no organism filter; a caller who supplied one is told it was not applied rather
        // than silently getting human and non-human rows mixed.
        organismFilterApplied: false,
        n_annotations: fetched.records.length,
        truncated: fetched.records.length >= limit,
        annotations: fetched.records
      }
    }
  },
  {
    id: 'omnipath_enzyme_substrate',
    connector: 'omnipath',
    description:
      'Enzyme → substrate modification edges (phosphorylation and friends) with the residue actually modified. Args: enzymes (optional symbol or comma list), substrates (optional symbol or comma list), modification (optional, e.g. "phosphorylation"), limit (1–500, default 50), organisms (default 9606). At least one of enzymes/substrates is required. Returns {source, n_modifications, truncated, modifications: [{enzyme, substrate, residue_type, residue_offset, modification, ...resource fields}]} or a named error. residue_type + residue_offset are the position on the SUBSTRATE (S/T/Y and a 1-based offset), which is what a phosphosite citation names — the enzyme’s own residue numbering is not involved. Requires network access to omnipathdb.org.',
    input: {
      type: 'object',
      properties: {
        enzymes: { type: 'string', description: 'Enzyme symbol or comma list, e.g. CDK1' },
        substrates: { type: 'string', description: 'Substrate symbol or comma list' },
        modification: { type: 'string', description: 'e.g. phosphorylation' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        organisms: { type: 'string', description: 'NCBI taxonomy id, default 9606 (human)' }
      },
      required: []
    },
    required: [],
    returns:
      '{source, n_modifications, truncated, modifications[]} or {error: argument-rejected|unexpected-shape|source-unreadable, message}',
    example:
      'const result = await host.mcp("omnipath", "omnipath_enzyme_substrate", {"enzymes": "CDK1", "limit": 20})',
    format: 'json',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const enzymes = csvArg(a.enzymes)
      const substrates = csvArg(a.substrates)
      if (!enzymes && !substrates) {
        return {
          error: 'argument-rejected',
          message: 'At least one of enzymes or substrates is required.'
        }
      }
      const limit = clampLimit(a.limit)
      const url = buildUrl('/enzsub', {
        enzymes: enzymes ?? undefined,
        substrates: substrates ?? undefined,
        modification: csvArg(a.modification) ?? undefined,
        limit,
        organisms: csvArg(a.organisms) ?? '9606'
      })
      const fetched = await fetchRecords(ctx, url)
      if ('error' in fetched) return fetched
      return {
        source: 'OmniPath',
        n_modifications: fetched.records.length,
        truncated: fetched.records.length >= limit,
        modifications: fetched.records
      }
    }
  }
]
