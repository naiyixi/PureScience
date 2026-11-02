import type { ToolContext, ToolDescriptor } from '../types'

// The Cancer Imaging Archive (TCIA) — NBIA public REST API v1. Read-only: the archive is queried for
// collections, patients and series metadata; no pixel data is downloaded by any tool here.
//
// Two things this file is deliberately careful about:
//   * the records are returned AS THE SERVICE WRITES THEM (`records`), with only the count added. NBIA's
//     field set differs between endpoints and has changed between deployments, so normalising here would
//     invent a schema the archive does not promise; the tool says which fields it saw instead.
//   * `getSeries` answers with the service's own paging/total conventions, which this build has not been
//     able to measure (see docs/evidence/2026-11-02-tcia-and-pdb-structure.md): the result carries the raw
//     count and `complete: false` when a limit was applied, rather than claiming a total.
const BASE = 'https://services.cancerimagingarchive.net/nbia-api/services/v1'

const MAX_ROWS = 1000
const DEFAULT_ROWS = 200

type RawRecord = Record<string, unknown>

// NBIA answers 200 with an HTML page when a required parameter is missing, and 200 with `[]` when a filter
// simply matched nothing — the shape is what separates them.
const looksLikeHtml = (text: string): boolean => /^\s*<(?:!doctype|html)/i.test(text)

const asRecords = (payload: unknown): RawRecord[] => {
  if (Array.isArray(payload))
    return payload.filter((e): e is RawRecord => !!e && typeof e === 'object')
  if (payload && typeof payload === 'object') return [payload as RawRecord]
  return []
}

const fieldsOf = (records: RawRecord[]): string[] => {
  const seen = new Set<string>()
  for (const record of records) for (const key of Object.keys(record)) seen.add(key)
  return [...seen].sort()
}

const buildUrl = (path: string, params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, value)
  }
  const query = search.toString()
  return `${BASE}${path}${query ? `?${query}` : ''}`
}

const fetchRecords = async (
  ctx: ToolContext,
  url: string
): Promise<{ records: RawRecord[]; fields: string[] } | { error: string; message: string }> => {
  const text = await ctx.fetchText(url)
  if (looksLikeHtml(text)) {
    return {
      error: 'source-unreadable',
      message:
        'TCIA answered an HTML page instead of JSON — its API answers 200 with documentation markup when a parameter it needs is missing.'
    }
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return {
      error: 'unexpected-shape',
      message: `TCIA answered something that is not JSON (${text.slice(0, 120)}).`
    }
  }
  const records = asRecords(payload)
  return { records, fields: fieldsOf(records) }
}

const clampRows = (value: unknown): number => {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_ROWS
  return Math.max(1, Math.min(MAX_ROWS, Math.trunc(n)))
}

export const TCIA_TOOLS: ToolDescriptor[] = [
  {
    id: 'tcia_collections',
    connector: 'cancer-imaging',
    description:
      'The collections the Cancer Imaging Archive holds — the top-level catalogue a search starts from. Args: limit (1–1000, default 200). Returns {source, n_collections, truncated, fields[], collections[]} or a named error. Records are passed through exactly as NBIA writes them (field names are the service’s own, and they have changed between deployments), so read `fields` before assuming a key. No pixel data is fetched. Requires network access to services.cancerimagingarchive.net.',
    input: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS, default: DEFAULT_ROWS }
      },
      required: []
    },
    required: [],
    returns:
      '{source, n_collections, truncated, fields[], collections[]} or {error: source-unreadable|unexpected-shape, message}',
    example: 'const result = await host.mcp("cancer-imaging", "tcia_collections", {"limit": 50})',
    format: 'json',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const limit = clampRows(a.limit)
      const fetched = await fetchRecords(ctx, buildUrl('/getCollectionValues', {}))
      if ('error' in fetched) return fetched
      const collections = fetched.records.slice(0, limit)
      return {
        source: 'TCIA (NBIA v1)',
        n_collections: collections.length,
        truncated: fetched.records.length > limit,
        fields: fetched.fields,
        collections
      }
    }
  },
  {
    id: 'tcia_patient_studies',
    connector: 'cancer-imaging',
    description:
      'The patients (with their studies) TCIA reports for one collection. Args: collection (required, a value from tcia_collections), limit (1–1000, default 200). Returns {source, collection, n_patients, truncated, fields[], patients[]} or a named error. A patient’s studies arrive inside the record itself; there is no separate study id argument, and an empty list means the collection is known but holds no patient record for this filter — not that the archive is unreachable (that answers as `source-unreadable`). No pixel data is fetched.',
    input: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name, e.g. TCGA-LUAD' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS, default: DEFAULT_ROWS }
      },
      required: ['collection']
    },
    required: ['collection'],
    returns:
      '{source, collection, n_patients, truncated, fields[], patients[]} or {error: argument-rejected|source-unreadable|unexpected-shape, message}',
    example:
      'const result = await host.mcp("cancer-imaging", "tcia_patient_studies", {"collection": "TCGA-LUAD", "limit": 20})',
    format: 'json',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const collection = String(a.collection ?? '').trim()
      if (!collection) return { error: 'argument-rejected', message: 'collection is required.' }
      const limit = clampRows(a.limit)
      const fetched = await fetchRecords(ctx, buildUrl('/getPatient', { Collection: collection }))
      if ('error' in fetched) return fetched
      const patients = fetched.records.slice(0, limit)
      return {
        source: 'TCIA (NBIA v1)',
        collection,
        n_patients: patients.length,
        truncated: fetched.records.length > limit,
        fields: fetched.fields,
        patients
      }
    }
  },
  {
    id: 'tcia_series_search',
    connector: 'cancer-imaging',
    description:
      'Series-level search across the archive — the imaging equivalent of asking “what scans exist for this cohort”. Args: collection (required), modality (e.g. MR, CT), body_part (e.g. LUNG, BRAIN), manufacturer, series_description (exact phrase as the archive writes it), limit (1–1000, default 200). Returns {source, filters, n_series, truncated, fields[], series[]} or a named error. Each series record carries the identifiers a download step would need (SeriesInstanceUID and friends), but this tool never downloads pixels; `truncated: true` means the limit cut the list, and the result does NOT claim a total the service has not stated. Requires network access to services.cancerimagingarchive.net.',
    input: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name, e.g. TCGA-LUAD' },
        modality: { type: 'string', description: 'DICOM modality, e.g. MR, CT' },
        body_part: { type: 'string', description: 'Body part examined, e.g. LUNG' },
        manufacturer: { type: 'string', description: 'Scanner manufacturer' },
        series_description: { type: 'string', description: 'Series description as written' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS, default: DEFAULT_ROWS }
      },
      required: ['collection']
    },
    required: ['collection'],
    returns:
      '{source, filters, n_series, truncated, fields[], series[]} or {error: argument-rejected|source-unreadable|unexpected-shape, message}',
    example:
      'const result = await host.mcp("cancer-imaging", "tcia_series_search", {"collection": "TCGA-LUAD", "modality": "CT", "limit": 20})',
    format: 'json',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const collection = String(a.collection ?? '').trim()
      if (!collection) return { error: 'argument-rejected', message: 'collection is required.' }
      const limit = clampRows(a.limit)
      const filters = {
        collection,
        modality: String(a.modality ?? '').trim() || undefined,
        body_part: String(a.body_part ?? '').trim() || undefined,
        manufacturer: String(a.manufacturer ?? '').trim() || undefined,
        series_description: String(a.series_description ?? '').trim() || undefined
      }
      const fetched = await fetchRecords(
        ctx,
        buildUrl('/getSeries', {
          Collection: filters.collection,
          Modality: filters.modality,
          BodyPartExamined: filters.body_part,
          Manufacturer: filters.manufacturer,
          SeriesDescription: filters.series_description
        })
      )
      if ('error' in fetched) return fetched
      const series = fetched.records.slice(0, limit)
      return {
        source: 'TCIA (NBIA v1)',
        filters,
        n_series: series.length,
        truncated: fetched.records.length > limit,
        fields: fetched.fields,
        series
      }
    }
  }
]
