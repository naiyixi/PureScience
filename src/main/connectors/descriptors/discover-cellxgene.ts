import type { ToolContext, ToolDescriptor } from '../types'

// CELLxGENE Discover public curation API. Two read-only endpoints feed this file:
//   GET /collections?visibility=PUBLIC  -> a lightweight catalogue; each collection embeds a PREVIEW
//       of its datasets carrying only assay/disease/organism/tissue/suspension_type (no title or
//       cell_count).
//   GET /collections/{id}               -> the full record; its datasets add cell_count,
//       primary_cell_count, feature_count, title, donor/sex/ethnicity, an explorer URL, etc.
// There is no server-side search, so `query` filtering is done client-side and COUNTED (the number
// scanned, matched and returned are all reported). cell_count is the service's own declaration and
// is labelled as service_declared — it is never recomputed here.
const DISCOVER_BASE = 'https://api.cellxgene.cziscience.com/curation/v1'

type Obj = Record<string, unknown>
const asObj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

// Reads an integer arg, defaulting when unset and clamping into [lo, hi].
function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  const base = Number.isFinite(n) && v != null && v !== '' ? Math.trunc(n) : def
  return Math.min(hi, Math.max(lo, base))
}

// Distinct, sorted labels from an array of {label, ontology_term_id} refs.
const refLabels = (v: unknown): string[] =>
  [
    ...new Set(
      asArr(v)
        .map((r) => str(asObj(r).label))
        .filter((s): s is string => Boolean(s))
    )
  ].sort()

// Union of a ref-array field across several dataset rows, de-duplicated and sorted.
function distinctRefLabels(rows: Obj[], key: string): string[] {
  const out = new Set<string>()
  for (const r of rows) for (const l of refLabels(r[key])) out.add(l)
  return [...out].sort()
}

// A collection reference is a bare UUID or a cellxgene.cziscience.com collection URL. Extract the id
// and reject anything else by name rather than firing off a request that 404s confusingly.
function collectionId(input: string): string {
  const s = input.trim()
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(s)
  if (uuid) return uuid[0]
  throw new Error(
    `not a CELLxGENE Discover collection id or URL: ${JSON.stringify(input)} (expected a UUID or a https://cellxgene.cziscience.com/collections/<uuid> URL)`
  )
}

const datasetRow = (d: Obj, collection?: Obj): Obj => ({
  dataset_id: d.dataset_id,
  title: d.title ?? null,
  cell_count: d.cell_count ?? null,
  primary_cell_count: d.primary_cell_count ?? null,
  feature_count: d.feature_count ?? null,
  mean_genes_per_cell: d.mean_genes_per_cell ?? null,
  organisms: refLabels(d.organism),
  tissues: refLabels(d.tissue),
  diseases: refLabels(d.disease),
  assays: refLabels(d.assay),
  suspension_type: asArr(d.suspension_type),
  sex: refLabels(d.sex),
  self_reported_ethnicity: refLabels(d.self_reported_ethnicity),
  development_stage: refLabels(d.development_stage),
  donor_id: asArr(d.donor_id),
  is_primary_data: d.is_primary_data ?? null,
  explorer_url: d.explorer_url ?? null,
  collection_id: collection?.collection_id ?? null,
  collection_name: collection?.name ?? null
})

// CELLxGENE Discover datasets across public collections. The two tools are read-only and answer the
// two questions a Discover user has: "which public collections exist (and what do they cover)" and
// "what exactly is inside this collection".
export const CELLXGENE_DISCOVER_TOOLS: ToolDescriptor[] = [
  {
    id: 'discover_list_collections',
    connector: 'cellguide',
    description:
      "List CELLxGENE Discover public collections (visibility=PUBLIC) with the tissue/organism/disease/assay coverage aggregated from each collection's embedded dataset previews. `query` filters collections client-side over name+description (the API has no search), and the number of collections scanned, matched and returned is reported so a short list is never mistaken for a small catalogue. Results are a page of the matched set (offset/limit). Returns: {total_collections, total_matched, offset, limit, returned, truncated, collections:[{collection_id, name, doi, visibility, published_at, revised_at, n_datasets, organisms, tissues, diseases, assays}]}.",
    input: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Case-insensitive substring over collection name + description (client-side).'
        },
        limit: { type: 'integer', default: 50 },
        offset: { type: 'integer', default: 0 }
      }
    },
    returns:
      "{total_collections (all public collections scanned), total_matched (query), offset, limit, returned, truncated, collections:[{collection_id, name, doi, visibility, published_at, revised_at, n_datasets, organisms:[str], tissues:[str], diseases:[str], assays:[str]}]}. The coverage lists come from each collection's dataset PREVIEW (assay/disease/organism/tissue only); use discover_get_collection for cell counts and titles.",
    example:
      'const result = await host.mcp("cellguide", "discover_list_collections", {"query": "lung", "limit": 5})',
    run: async (ctx, a) => {
      const query = typeof a.query === 'string' ? a.query.trim().toLowerCase() : ''
      const limit = clampInt(a.limit, 50, 1, 1000)
      const offset = clampInt(a.offset, 0, 0, 1_000_000_000)
      const raw = await ctx.fetchJson(`${DISCOVER_BASE}/collections?visibility=PUBLIC`)
      const cols = asArr(raw).map(asObj)
      const matched = query
        ? cols.filter((c) =>
            `${str(c.name) ?? ''} ${str(c.description) ?? ''}`.toLowerCase().includes(query)
          )
        : cols
      const page = matched.slice(offset, offset + limit)
      const collections = page.map((c) => {
        const dss = asArr(c.datasets).map(asObj)
        return {
          collection_id: c.collection_id,
          name: str(c.name),
          doi: c.doi ?? null,
          visibility: c.visibility,
          published_at: c.published_at ?? null,
          revised_at: c.revised_at ?? null,
          n_datasets: dss.length,
          organisms: distinctRefLabels(dss, 'organism'),
          tissues: distinctRefLabels(dss, 'tissue'),
          diseases: distinctRefLabels(dss, 'disease'),
          assays: distinctRefLabels(dss, 'assay')
        }
      })
      return {
        total_collections: cols.length,
        total_matched: matched.length,
        offset,
        limit,
        returned: collections.length,
        truncated: matched.length > offset + collections.length,
        collections
      }
    }
  },
  {
    id: 'discover_get_collection',
    connector: 'cellguide',
    description:
      "Fetch one CELLxGENE Discover public collection by id or website URL, with its complete dataset set (the full record, not the catalogue preview): each dataset's title, cell_count / primary_cell_count / feature_count / mean_genes_per_cell, ontology labels for organism/tissue/disease/assay/sex/development stage, donor ids and the CELLxGENE Explorer URL. cell_count is the service's declared value. Returns: {collection_id, name, doi, visibility, published_at, revised_at, consortia, contact_name, description, n_datasets, datasets:[{dataset_id, title, cell_count, primary_cell_count, feature_count, mean_genes_per_cell, organisms, tissues, diseases, assays, suspension_type, sex, self_reported_ethnicity, development_stage, donor_id, is_primary_data, explorer_url, collection_id, collection_name}], cell_count_source}.",
    input: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description: 'Collection UUID or cellxgene.cziscience.com/collections/<uuid> URL.'
        }
      },
      required: ['collection']
    },
    required: ['collection'],
    returns:
      '{collection_id, name, doi, visibility, published_at, revised_at, consortia:[str], contact_name, description, n_datasets, cell_count_source:"service_declared", datasets:[{dataset_id, title, cell_count, primary_cell_count, feature_count, mean_genes_per_cell, organisms:[str], tissues:[str], diseases:[str], assays:[str], suspension_type:[str], sex:[str], self_reported_ethnicity:[str], development_stage:[str], donor_id:[str], is_primary_data, explorer_url, collection_id, collection_name}]}. Throws a named error for a non-UUID/URL argument or an unknown collection.',
    example:
      'const result = await host.mcp("cellguide", "discover_get_collection", {"collection": "af893e86-8e9f-41f1-a474-ef05359b1fb7"})',
    run: async (ctx: ToolContext, a) => {
      const id = collectionId(String(a.collection))
      const raw = asObj(
        await ctx.fetchJson(`${DISCOVER_BASE}/collections/${encodeURIComponent(id)}`)
      )
      if (!raw.collection_id) throw new Error(`CELLxGENE Discover collection not found: '${id}'`)
      const collection: Obj = {
        collection_id: raw.collection_id,
        name: str(raw.name),
        doi: raw.doi ?? null,
        visibility: raw.visibility
      }
      const datasets = asArr(raw.datasets)
        .map(asObj)
        .map((d) => datasetRow(d, collection))
      return {
        collection_id: raw.collection_id,
        name: str(raw.name),
        doi: raw.doi ?? null,
        visibility: raw.visibility,
        published_at: raw.published_at ?? null,
        revised_at: raw.revised_at ?? null,
        consortia: asArr(raw.consortia),
        contact_name: raw.contact_name ?? null,
        description: raw.description ?? null,
        n_datasets: datasets.length,
        datasets,
        cell_count_source: 'service_declared'
      }
    }
  }
]
