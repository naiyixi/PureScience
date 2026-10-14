import type { ToolContext, ToolDescriptor } from '../types'

// PDC (Proteome Data Commons, NCI) serves its catalogue over one GraphQL endpoint. Its introspection is
// turned off, so every field here was confirmed against the service itself: `uiStudySummary` answers with
// the whole study catalogue, `filesPerStudy(study_id, offset, limit)` lists a study's files, and
// `filesCountPerStudy(study_id)` gives that study's own file count. The ids those two take are the UUIDs
// `uiStudySummary` returns — the PDC accession (PDC000127) is NOT accepted and the service answers with a
// database error, which is why this reader checks the shape before sending anything.
const PDC_GRAPHQL = 'https://pdc.cancer.gov/graphql'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function strArg(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

// GraphQL answers 200 (or 400) with an `errors` array rather than an empty result; a caller must never see
// that as "no data", so it is raised by name with the service's own message.
function graphQlError(payload: unknown): string | null {
  const errors = (payload as { errors?: Array<{ message?: string }> } | null)?.errors
  if (!Array.isArray(errors) || errors.length === 0) return null
  return errors
    .map((entry) => (typeof entry?.message === 'string' ? entry.message : 'unknown GraphQL error'))
    .join('; ')
    .slice(0, 400)
}

export const PROTEOMICS_PDC_TOOLS: ToolDescriptor[] = [
  {
    id: 'pdc_studies',
    connector: 'proteomics-pdc',
    description:
      "The study catalogue of PDC (Proteome Data Commons, NCI): every study the commons holds, with its name, disease type and primary site. Use it to find the study_id (a UUID) that pdc_study_files needs, or to see which proteomics studies exist for a disease. Args: max_studies (1-2000, default 500). Returns {source, n_studies_returned, truncated, studies: [{study_id, study_name, disease_type, primary_site}]}. The service answers its whole catalogue in one call (this reader returns all of it by default) and takes no filters here, so narrowing by disease happens in the caller - the list is the service's own, unedited. Requires network access to pdc.cancer.gov.",
    input: {
      type: 'object',
      properties: { max_studies: { type: 'integer', minimum: 1, maximum: 2000, default: 500 } },
      required: []
    },
    required: [],
    returns:
      '{source, n_studies_returned, truncated, studies: [{study_id (UUID — the id pdc_study_files takes), study_name, disease_type, primary_site}]} or a named error (source-unreadable / graphql-error).',
    example: 'const result = await host.mcp("proteomics-pdc", "pdc_studies", {})',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const maxStudies = clampInt(a.max_studies, 500, 1, 2000)
      let payload: unknown
      try {
        payload = await ctx.postJson(PDC_GRAPHQL, {
          query: '{ uiStudySummary { study_id study_name disease_type primary_site } }'
        })
      } catch (error) {
        return {
          error: 'source-unreadable',
          message: `PDC answered with something that is not JSON: ${String(error).slice(0, 300)}`
        }
      }

      const failure = graphQlError(payload)
      if (failure) return { error: 'graphql-error', message: failure }

      const all = ((payload as { data?: { uiStudySummary?: unknown[] } }).data?.uiStudySummary ??
        []) as Array<Record<string, unknown>>
      const studies = all.slice(0, maxStudies).map((row) => ({
        study_id: row.study_id ?? null,
        study_name: row.study_name ?? null,
        disease_type: row.disease_type ?? null,
        primary_site: row.primary_site ?? null
      }))

      return {
        source: 'PDC (Proteome Data Commons, NCI) - uiStudySummary',
        n_studies_returned: studies.length,
        truncated: all.length > studies.length,
        studies
      }
    }
  },
  {
    id: 'pdc_study_files',
    connector: 'proteomics-pdc',
    description:
      "One PDC study's file listing, with each file's own size, format and type reported WITHOUT downloading anything: use it to see what a study holds and how many bytes it actually is (2.4 GB vendor .raw files are normal here), before deciding whether to fetch anything. Args: study_id (the UUID from pdc_studies - the PDC accession like PDC000127 is refused by name before any request, because the service itself rejects it with a database error); offset (0 or more, default 0); limit (1-600, default 100). Returns {source, study_id, total_files (the study's own file count, from filesCountPerStudy), n_files_returned, offset, limit, truncated, bytes_of_returned_rows, files: [{file_name, file_size, file_format, file_type}]}. bytes_of_returned_rows is the sum over the rows THIS call returned, not the study's whole size. Requires network access to pdc.cancer.gov.",
    input: {
      type: 'object',
      properties: {
        study_id: {
          type: 'string',
          description: 'UUID from pdc_studies (e.g. 28f0e1de-c04b-4281-981d-865a5885245e).'
        },
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 600, default: 100 }
      },
      required: ['study_id']
    },
    required: ['study_id'],
    returns:
      '{source, study_id, total_files, n_files_returned, offset, limit, truncated, bytes_of_returned_rows, files: [{file_name, file_size, file_format, file_type}]} or a named error (invalid-study-id / source-unreadable / graphql-error) — nothing is downloaded.',
    example:
      'const result = await host.mcp("proteomics-pdc", "pdc_study_files", {"study_id": "28f0e1de-c04b-4281-981d-865a5885245e", "limit": 2})',
    run: async (ctx: ToolContext, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const studyId = strArg(a.study_id)
      // The service answers a non-UUID with a database error (uuid_to_bin), so the shape is checked here and
      // the refusal says which id is wanted instead.
      if (!UUID_RE.test(studyId)) {
        return {
          error: 'invalid-study-id',
          message: `pdc_study_files takes the study UUID from pdc_studies, not an accession: ${studyId === '' ? '(missing)' : studyId}`
        }
      }
      const offset = clampInt(a.offset, 0, 0, 1_000_000)
      const limit = clampInt(a.limit, 100, 1, 600)

      let payload: unknown
      try {
        payload = await ctx.postJson(PDC_GRAPHQL, {
          query:
            'query ($studyId: String, $offset: Int, $limit: Int) {' +
            ' filesPerStudy(study_id: $studyId, offset: $offset, limit: $limit)' +
            ' { file_name file_size file_format file_type }' +
            ' filesCountPerStudy(study_id: $studyId) { files_count } }',
          variables: { studyId, offset, limit }
        })
      } catch (error) {
        return {
          error: 'source-unreadable',
          message: `PDC answered with something that is not JSON: ${String(error).slice(0, 300)}`
        }
      }

      const failure = graphQlError(payload)
      if (failure) return { error: 'graphql-error', message: failure }

      const data =
        (payload as { data?: { filesPerStudy?: unknown[]; filesCountPerStudy?: unknown[] } })
          .data ?? {}
      const rows = (data.filesPerStudy ?? []) as Array<Record<string, unknown>>
      const files = rows.map((row) => ({
        file_name: row.file_name ?? null,
        // The service reports the size as a string; it is quoted as such and also summed below, never rounded.
        file_size: row.file_size ?? null,
        file_format: row.file_format ?? null,
        file_type: row.file_type ?? null
      }))
      const sizes = files
        .map((file) => Number(file.file_size))
        .filter((size) => Number.isFinite(size))
      const counts = (data.filesCountPerStudy ?? []) as Array<{ files_count?: unknown }>
      const totalRaw = counts[0]?.files_count
      const total = totalRaw === undefined || totalRaw === null ? null : Number(totalRaw)

      return {
        source: 'PDC (Proteome Data Commons, NCI) - filesPerStudy',
        study_id: studyId,
        total_files: Number.isFinite(total) ? total : null,
        n_files_returned: files.length,
        offset,
        limit,
        // The study's own count decides: a page that is not the whole study says so.
        truncated: Number.isFinite(total) ? offset + files.length < (total as number) : true,
        bytes_of_returned_rows: sizes.reduce((sum, size) => sum + size, 0),
        files
      }
    }
  }
]
