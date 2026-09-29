import type { ToolContext, ToolDescriptor } from '../types'
import {
  JobTranscript,
  RemoteFailure,
  bytesOf,
  fetchTextRetrying,
  sleep,
  submitOnce
} from './job-transport'

// mygene.info batch gene resolution + UniProtKB record retrieval. mygene answers a POST /query with a
// JSON array (one item per query term, misses flagged notfound:true); UniProt is queried with a single
// batched OR-query over accessions and served as TSV (token-lean tabular), FASTA, or flat-file text.
//
// map_uniprot_ids adds the UniProt ID Mapping service, which is a THREE-SEGMENT job: POST
// /idmapping/run (submit, non-retried) → GET /idmapping/status/<jobId> (poll) → GET
// /idmapping/stream/<jobId> (results, paged by a Link header). It shares its transport with the
// sequence-tools connector so the submit/poll/result rules live in one place.
const MYGENE = 'https://mygene.info/v3'
const UNIPROT = 'https://rest.uniprot.org/uniprotkb'
const IDMAPPING = 'https://rest.uniprot.org/idmapping'

// The ID Mapping service accepts up to 100,000 identifiers per submission and tells callers to split
// anything larger into batches; the tool chunks at that ceiling and never fans out parallel jobs.
const IDMAPPING_JOB_ID_CAP = 100_000
const IDMAPPING_POLL_INTERVAL_MS = 1_500
const IDMAPPING_MAX_PAGES = 200
// A named unmapped list is the point of the tool, so it is listed in full up to this many names and
// then explicitly reported as truncated — never silently collapsed to a bare count.
const UNMAPPED_LIST_CAP = 5_000

// mygene batch caps at 1000 terms/request; UniProt OR-queries are chunked to keep the URL bounded.
const MYGENE_BATCH = 1000
const UNIPROT_CHUNK = 100

// One mygene hit: carries its originating `query`, an `_id`, the requested fields, or notfound:true.
type MygeneHit = {
  query?: string
  _id?: string
  notfound?: boolean
  [key: string]: unknown
}

// POSTs the terms to mygene in <=1000-term chunks and concatenates the per-chunk result arrays.
async function mygeneBatch(
  ctx: ToolContext,
  terms: string[],
  body: Record<string, unknown>
): Promise<MygeneHit[]> {
  const out: MygeneHit[] = []
  for (let i = 0; i < terms.length; i += MYGENE_BATCH) {
    const chunk = terms.slice(i, i + MYGENE_BATCH)
    const resp = (await ctx.postJson(`${MYGENE}/query`, { ...body, q: chunk })) as MygeneHit[]
    for (const hit of resp ?? []) out.push(hit)
  }
  return out
}

// Splits accessions into URL-safe OR-query chunks.
function chunkAccessions(accessions: string[]): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < accessions.length; i += UNIPROT_CHUNK) {
    chunks.push(accessions.slice(i, i + UNIPROT_CHUNK))
  }
  return chunks
}

// Builds the batched OR filter, e.g. (accession:P04637)OR(accession:P38398).
function orQuery(chunk: string[]): string {
  return chunk.map((a) => `(accession:${a})`).join('OR')
}

// Parses a UniProt TSV payload into column->value objects keyed by the header row (skips the header
// and blank lines). Rows shorter than the header are padded with empty strings.
function parseTsv(tsv: string): Record<string, string>[] {
  const lines = tsv.split('\n').filter((l) => l.length > 0)
  if (lines.length <= 1) return []
  const headers = lines[0].split('\t')
  return lines.slice(1).map((line) => {
    const cells = line.split('\t')
    const row: Record<string, string> = {}
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? ''
    })
    return row
  })
}

// One parsed multi-record entry: the accessions it answers for plus its verbatim text block.
type ParsedEntry = { accessions: string[]; text: string }

// Splits a multi-record FASTA payload into per-entry blocks; the accession is the pipe-delimited
// middle field of each ">db|ACCESSION|NAME ..." header.
function parseFasta(fasta: string): ParsedEntry[] {
  const trimmed = fasta.trim()
  if (trimmed === '') return []
  return trimmed.split(/\n(?=>)/).map((block) => {
    const header = block.split('\n')[0]
    const m = /^>[^|]*\|([^|]+)\|/.exec(header)
    return { accessions: m ? [m[1]] : [], text: `${block.trimEnd()}\n` }
  })
}

// Splits a multi-record UniProt flat-file payload on the // record terminator; each record's
// accessions are read off its AC lines (primary + secondary, semicolon-separated).
function parseFlatFile(txt: string): ParsedEntry[] {
  return txt
    .split(/^\/\/$/m)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const accessions: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith('AC ')) {
          for (const token of line.slice(2).split(';')) {
            const acc = token.trim()
            if (acc) accessions.push(acc)
          }
        }
      }
      return { accessions, text: `${block}\n//\n` }
    })
}

// Maps each requested accession to the text of the entry that answers for it (case-insensitive),
// returning the {accession:text} record map plus the accessions no entry covered.
function mapEntries(
  accessions: string[],
  entries: ParsedEntry[]
): { records: Record<string, string>; missing: string[] } {
  const records: Record<string, string> = {}
  const missing: string[] = []
  for (const acc of accessions) {
    const upper = acc.toUpperCase()
    const hit = entries.find((e) => e.accessions.some((a) => a.toUpperCase() === upper))
    if (hit) records[acc] = hit.text
    else missing.push(acc)
  }
  return { records, missing }
}

// -- UniProt ID Mapping transport -----------------------------------------------------------------
// (shares job-transport's submitOnce / fetchTextRetrying so the two-phase rules live in one place)

const excerpt = (text: string): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed
}

const clampInt = (raw: unknown, fallback: number, min: number, max: number): number => {
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

// The service delimits identifiers on commas/whitespace, so an id containing either cannot be
// expressed and would silently corrupt the batch — reject it by name instead.
const SPLIT_RE = /[\s,]/

// Follows the `rel="next"` URL of an RFC-5988 Link header, but only within the same host: a result
// stream must never be redirected to a third-party origin by a response header.
const nextPageUrl = (headers: Headers): string | undefined => {
  const link = headers.get('link')
  if (!link) return undefined
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part)
    if (!match) continue
    try {
      const url = new URL(match[1])
      if (url.hostname !== 'rest.uniprot.org') return undefined
      return url.toString()
    } catch {
      return undefined
    }
  }
  return undefined
}

async function submitIdMappingJob(
  transcript: JobTranscript,
  from: string,
  to: string,
  ids: string[]
): Promise<string> {
  const res = await submitOnce(
    `${IDMAPPING}/run`,
    { from, to, ids: ids.join(',') },
    { accept: 'application/json' }
  )
  transcript.record(res.text)
  if (!res.ok) {
    throw new RemoteFailure(
      'remote-rejected',
      `UniProt ID mapping rejected the submission (HTTP ${res.status}): ${excerpt(res.text)}`
    )
  }
  let body: unknown
  try {
    body = JSON.parse(res.text)
  } catch {
    throw new RemoteFailure(
      'contract-changed',
      `UniProt ID mapping returned a non-JSON receipt: ${excerpt(res.text)}`
    )
  }
  const jobId = (body as { jobId?: unknown } | null)?.jobId
  if (typeof jobId !== 'string' || jobId === '') {
    throw new RemoteFailure(
      'contract-changed',
      `UniProt ID mapping receipt carried no jobId: ${excerpt(res.text)}`
    )
  }
  return jobId
}

type MappingRecord = { from: string; to: unknown }

// One id may be reported as unmatched by the service itself (`failedIds`) instead of merely being
// absent from `results`; both are named so neither can be lost.
const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => String(entry)) : []

const toMappingRecords = (rows: unknown): MappingRecord[] => {
  if (!Array.isArray(rows)) return []
  const out: MappingRecord[] = []
  for (const row of rows) {
    if (row && typeof row === 'object' && 'from' in row) {
      const record = row as { from?: unknown; to?: unknown }
      out.push({ from: String(record.from), to: record.to })
    }
  }
  return out
}

type IdMappingPoll = {
  // Set when the service delivered the results inline (a finished job that fits on one page answers
  // /status with `results` and NO `jobStatus`); otherwise the caller streams them.
  results?: MappingRecord[]
  failedIds: string[]
}

async function pollIdMappingJob(
  transcript: JobTranscript,
  jobId: string,
  pollTimeoutS: number
): Promise<IdMappingPoll> {
  const deadline = Date.now() + pollTimeoutS * 1_000
  for (;;) {
    const url = `${IDMAPPING}/status/${encodeURIComponent(jobId)}`
    const res = await fetchTextRetrying(url, { accept: 'application/json' })
    transcript.record(res.text)
    if (res.status === 404) {
      throw new RemoteFailure(
        'job-not-found',
        `UniProt ID mapping does not know job ${jobId} (HTTP 404): ${excerpt(res.text)}`
      )
    }
    if (!res.ok) {
      throw new RemoteFailure(
        'remote-rejected',
        `UniProt ID mapping status read for job ${jobId} returned HTTP ${res.status}: ${excerpt(res.text)}`
      )
    }
    let body: { jobStatus?: unknown; results?: unknown; failedIds?: unknown } | null
    try {
      body = JSON.parse(res.text) as {
        jobStatus?: unknown
        results?: unknown
        failedIds?: unknown
      } | null
    } catch {
      throw new RemoteFailure(
        'contract-changed',
        `UniProt ID mapping status for job ${jobId} was not JSON: ${excerpt(res.text)}`
      )
    }
    const failedIds = stringList(body?.failedIds)
    // A finished job whose results fit on one page is answered inline: `results` present, no
    // `jobStatus` at all (observed live). Taking it here also saves the follow-up stream request.
    if (body && Array.isArray(body.results)) {
      return { results: toMappingRecords(body.results), failedIds }
    }
    const status = body && typeof body.jobStatus === 'string' ? body.jobStatus : undefined
    if (status === 'FINISHED') return { failedIds }
    if (status === 'ERROR' || status === 'FAILURE') {
      throw new RemoteFailure(
        'job-failed',
        `UniProt ID mapping job ${jobId} ended in status ${status}; there is no result to read.`
      )
    }
    if (status !== 'RUNNING' && status !== 'QUEUED' && status !== 'NEW') {
      throw new RemoteFailure(
        'contract-changed',
        `UniProt ID mapping job ${jobId} reported an unrecognized status '${String(status)}': ${excerpt(res.text)}`
      )
    }
    if (Date.now() >= deadline) {
      throw new RemoteFailure(
        'timeout',
        `UniProt ID mapping job ${jobId} did not finish within ${pollTimeoutS}s (last status ` +
          `${status}). It may still be running remotely — narrow the batch (smaller chunk_size) and ` +
          `retry, or submit fewer identifiers. The job id is ${jobId}.`
      )
    }
    await sleep(IDMAPPING_POLL_INTERVAL_MS)
  }
}

// Reads every page of /idmapping/stream/<jobId>, following the Link header, and enforces the byte cap
// on the accumulated records so a huge mapping fails by name instead of overflowing the transport.
async function fetchIdMappingResults(
  transcript: JobTranscript,
  jobId: string,
  maxBytes: number
): Promise<MappingRecord[]> {
  const records: MappingRecord[] = []
  let url: string | undefined = `${IDMAPPING}/stream/${encodeURIComponent(jobId)}`
  let pages = 0
  while (url) {
    const res = await fetchTextRetrying(url, { accept: 'application/json' })
    transcript.record(res.text)
    if (!res.ok) {
      throw new RemoteFailure(
        'remote-rejected',
        `UniProt ID mapping results for job ${jobId} returned HTTP ${res.status} on page ${pages + 1}: ${excerpt(res.text)}`
      )
    }
    let body: { results?: unknown } | null
    try {
      body = JSON.parse(res.text) as { results?: unknown } | null
    } catch {
      throw new RemoteFailure(
        'contract-changed',
        `UniProt ID mapping result page ${pages + 1} for job ${jobId} was not JSON: ${excerpt(res.text)}`
      )
    }
    if (!body || !Array.isArray(body.results)) {
      throw new RemoteFailure(
        'contract-changed',
        `UniProt ID mapping result page ${pages + 1} for job ${jobId} carried no results array.`
      )
    }
    for (const record of toMappingRecords(body.results)) records.push(record)
    pages += 1
    if (bytesOf(JSON.stringify(records)) > maxBytes) {
      throw new RemoteFailure(
        'response-too-large',
        `the mapped records for job ${jobId} exceed the ${maxBytes}-byte cap after ${pages} page(s). ` +
          `Raise max_bytes, or narrow the identifier batch.`
      )
    }
    const next = nextPageUrl(res.headers)
    if (next && pages >= IDMAPPING_MAX_PAGES) {
      throw new RemoteFailure(
        'response-too-large',
        `UniProt ID mapping job ${jobId} still had pages after ${IDMAPPING_MAX_PAGES} — the result is ` +
          `far larger than this tool will assemble in one call. Narrow the batch.`
      )
    }
    url = next
  }
  return records
}

export const GENES_PROTEINS_TOOLS: ToolDescriptor[] = [
  {
    id: 'query_genes',
    connector: 'genes',
    description:
      'Resolve gene identifiers/symbols via mygene.info (batched, up to 1000 terms/request). Use this to map gene symbols to Ensembl gene IDs, Entrez IDs, names, and any other mygene.info field — or the reverse (set `scopes` to the namespace of your input terms, e.g. "entrezgene", "ensembl.gene", "symbol,alias"). Args: terms (query terms, e.g. ["TP53","BRCA1"]; terms containing commas are not supported); scopes (comma-separated identifier namespaces to match terms against); fields (comma-separated mygene fields to return, or "all"); species (common name "human"/"mouse" or NCBI taxid). Returns {n_input, n_records, not_found, records}. A term matching several genes yields several records (each carries its `query`). Records are deterministically ordered (input order, then _id).',
    input: {
      type: 'object',
      properties: {
        terms: { type: 'array', items: { type: 'string' } },
        scopes: { type: 'string' },
        fields: { type: 'string', default: 'symbol,name,taxid,entrezgene,ensembl.gene' },
        species: { type: 'string' }
      },
      required: ['terms']
    },
    required: ['terms'],
    returns:
      '{n_input, n_records, not_found:[terms with no match], records:[mygene hit objects, each with `query`, `_id` and the requested fields]} — records ordered by input position of `query`, then `_id`.',
    example:
      'const result = await host.mcp("genes", "query_genes", {"terms": ["TP53", "BRCA1"], "scopes": "symbol,alias", "fields": "symbol,name,entrezgene,ensembl.gene", "species": "human"})',
    run: async (ctx, a) => {
      const terms = Array.isArray(a.terms) ? (a.terms as unknown[]).map(String) : []
      // Commas would be misread as a multi-value delimiter by mygene — reject them explicitly.
      const withComma = terms.find((t) => t.includes(','))
      if (withComma != null) {
        throw new Error(`query_genes: term '${withComma}' contains a comma, which is not supported`)
      }
      if (terms.length === 0) return { n_input: 0, n_records: 0, not_found: [], records: [] }

      // Only forward the optional scopes/species; fields defaults to a lean identity set.
      const body: Record<string, unknown> = {
        fields:
          a.fields != null && String(a.fields) !== ''
            ? String(a.fields)
            : 'symbol,name,taxid,entrezgene,ensembl.gene'
      }
      if (a.scopes != null && String(a.scopes) !== '') body.scopes = String(a.scopes)
      if (a.species != null && String(a.species) !== '') body.species = String(a.species)

      const hits = await mygeneBatch(ctx, terms, body)
      const records = hits.filter((h) => h.notfound !== true)

      // not_found: input terms for which no real (non-notfound) record came back.
      const foundQueries = new Set(records.map((r) => String(r.query)))
      const notFound = terms.filter((t) => !foundQueries.has(t))

      // Deterministic order: first input position of the record's `query`, then `_id`.
      const firstPos = new Map<string, number>()
      terms.forEach((t, i) => {
        if (!firstPos.has(t)) firstPos.set(t, i)
      })
      records.sort((x, y) => {
        const px = firstPos.get(String(x.query)) ?? Number.MAX_SAFE_INTEGER
        const py = firstPos.get(String(y.query)) ?? Number.MAX_SAFE_INTEGER
        if (px !== py) return px - py
        return String(x._id ?? '').localeCompare(String(y._id ?? ''))
      })

      return {
        n_input: terms.length,
        n_records: records.length,
        not_found: notFound,
        records
      }
    }
  },
  {
    id: 'get_uniprot_entries',
    connector: 'genes',
    description:
      'Fetch UniProtKB records for a list of accessions (batched OR-queries, not per-accession). Three modes: `fields` given → token-lean tabular retrieval of just those UniProt fields (e.g. ["accession","id","protein_name","gene_names","organism_name","length","sequence"]); `format` is ignored. format="fasta" → per-accession FASTA sequences. format="txt" → per-accession full UniProt flat-file text (complete annotation; can be very large — prefer `fields`). Args: accessions (e.g. ["P04637","P38398"]); format ("fasta"/"txt", ignored when `fields` given); fields (optional UniProt REST field names for tabular mode). Returns: fields mode {accessions, fields, n_records, records:[{<column>:value}]}; fasta/txt mode {accessions, format, n_found, missing, records:{accession:text}} — `missing` lists accessions UniProt returned no record for.',
    input: {
      type: 'object',
      properties: {
        accessions: { type: 'array', items: { type: 'string' } },
        format: { type: 'string', enum: ['fasta', 'txt'] },
        fields: { type: 'array', items: { type: 'string' } }
      },
      required: ['accessions']
    },
    required: ['accessions'],
    returns:
      'fields mode {accessions, fields, n_records, records:[{<column>:value}]} (columns are the UniProt TSV headers); fasta/txt mode {accessions, format, n_found, missing:[...], records:{accession:text}}.',
    example:
      'const result = await host.mcp("genes", "get_uniprot_entries", {"accessions": ["P04637", "P38398"], "fields": ["accession", "id", "protein_name", "gene_names", "organism_name", "length"]})',
    run: async (ctx, a) => {
      const accessions = Array.isArray(a.accessions) ? (a.accessions as unknown[]).map(String) : []
      const fields = Array.isArray(a.fields) ? (a.fields as unknown[]).map(String) : []
      const hasFields = fields.length > 0
      const chunks = chunkAccessions(accessions)

      // Mode 1 — fields given: TSV tabular retrieval, records keyed by UniProt column headers.
      if (hasFields) {
        const records: Record<string, string>[] = []
        for (const chunk of chunks) {
          const url =
            `${UNIPROT}/search?query=${encodeURIComponent(orQuery(chunk))}` +
            `&fields=${fields.join(',')}&format=tsv&size=500`
          const tsv = await ctx.fetchText(url)
          for (const row of parseTsv(tsv)) records.push(row)
        }
        return { accessions, fields, n_records: records.length, records }
      }

      // Modes 2/3 — no fields: FASTA (default) or full flat-file text, split into a per-accession map.
      const format = a.format != null && String(a.format) === 'txt' ? 'txt' : 'fasta'
      let combined = ''
      for (const chunk of chunks) {
        const url =
          `${UNIPROT}/search?query=${encodeURIComponent(orQuery(chunk))}` +
          `&format=${format}&size=500`
        combined += await ctx.fetchText(url)
      }
      const entries = format === 'txt' ? parseFlatFile(combined) : parseFasta(combined)
      const { records, missing } = mapEntries(accessions, entries)
      return {
        accessions,
        format,
        n_found: Object.keys(records).length,
        missing,
        records
      }
    }
  },
  {
    id: 'map_uniprot_ids',
    connector: 'genes',
    description:
      'Batch identifier mapping through the UniProt ID Mapping service (e.g. UniProtKB_AC-ID → Ensembl, ' +
      'Ensembl → UniProtKB, gene names → UniProtKB). Three segments, documented here because they matter: ' +
      'submit (`from`,`to`,`ids` → a job id; a single, non-retried POST), poll the job status, then read ' +
      'the streamed results. Identifiers are chunked at the service ceiling (100,000 per submission) so a ' +
      'larger list becomes several sequential jobs, never parallel ones. Unmapped identifiers are named ' +
      'individually in `unmapped` (not just counted) — a silent miss is the failure mode this tool exists ' +
      'to avoid. Failures are named: a rejected submission, an unknown or failed job, a poll timeout, a ' +
      'result larger than `max_bytes`.',
    input: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Source database, e.g. "UniProtKB_AC-ID", "Ensembl", "Gene_Name".'
        },
        to: {
          type: 'string',
          description: 'Target database, e.g. "Ensembl", "UniProtKB", "UniProtKB-Swiss-Prot".'
        },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Identifiers to map (no commas/whitespace inside an id).'
        },
        chunk_size: {
          type: 'number',
          description: `Identifiers per job, default ${IDMAPPING_JOB_ID_CAP} (the service ceiling).`
        },
        max_records: {
          type: 'number',
          description:
            'Mapped records returned, default 5000; extra records are reported as truncated, not dropped.'
        },
        max_bytes: {
          type: 'number',
          description:
            'Accumulated-records byte cap, default 16000000; exceeding it is a named error.'
        },
        poll_timeout_s: { type: 'number', description: 'Deadline per job, default 300s.' }
      },
      required: ['from', 'to', 'ids']
    },
    required: ['from', 'to', 'ids'],
    returns:
      '`{ from, to, n_input, n_unique_input, n_duplicate_skipped, n_records, n_mapped_inputs, n_unmapped, ' +
      'unmapped: [identifier, ...] (named, in input order; `unmapped_truncated: true` when longer than the ' +
      'cap), records: [{from, to}], records_truncated, batches: [{chunk_index, n_ids, job_id, n_records, ' +
      'n_failed_ids, n_http_requests}], provenance: {connector, tool, params, response_sha256, retrieved_at, ' +
      'n_http_requests, bytes_received, jobs} }`.',
    example:
      'const result = await host.mcp("genes", "map_uniprot_ids", {"from": "UniProtKB_AC-ID", "to": "Ensembl", "ids": ["P04637", "P38398"]})',
    run: async (_ctx: ToolContext, a: Record<string, unknown>) => {
      const from = String(a.from ?? '').trim()
      const to = String(a.to ?? '').trim()
      if (from === '' || to === '') {
        throw new Error(
          'map_uniprot_ids: both `from` and `to` database names are required (e.g. from="UniProtKB_AC-ID", to="Ensembl").'
        )
      }
      const rawIds = Array.isArray(a.ids)
        ? (a.ids as unknown[]).map((value) => String(value).trim())
        : []
      const ids = rawIds.filter((id) => id !== '')
      if (ids.length === 0)
        throw new Error('map_uniprot_ids: `ids` must contain at least one identifier.')

      const malformed = ids.filter((id) => SPLIT_RE.test(id))
      if (malformed.length > 0) {
        throw new Error(
          `map_uniprot_ids: ${malformed.length} identifier(s) contain a comma or whitespace and cannot be ` +
            `expressed in a comma-delimited batch (first few: ${malformed.slice(0, 5).join(', ')}).`
        )
      }

      // Deduplicate but keep the caller's order so `unmapped` reads back in a familiar sequence.
      const uniqueIds: string[] = []
      const seen = new Set<string>()
      for (const id of ids) {
        const key = id.toUpperCase()
        if (seen.has(key)) continue
        seen.add(key)
        uniqueIds.push(id)
      }
      const duplicateSkipped = ids.length - uniqueIds.length

      const chunkSize = clampInt(a.chunk_size, IDMAPPING_JOB_ID_CAP, 1, IDMAPPING_JOB_ID_CAP)
      const maxRecords = clampInt(a.max_records, 5_000, 1, 100_000)
      const maxBytes = clampInt(a.max_bytes, 16_000_000, 1_000, 32_000_000)
      const pollTimeoutS = clampInt(a.poll_timeout_s, 300, 5, 900)

      const transcript = new JobTranscript()
      const records: MappingRecord[] = []
      const batches: Array<Record<string, unknown>> = []
      const remoteFailedIds: string[] = []

      for (let start = 0; start < uniqueIds.length; start += chunkSize) {
        const chunk = uniqueIds.slice(start, start + chunkSize)
        const requestsBefore = transcript.nHttpRequests
        const jobId = await submitIdMappingJob(transcript, from, to, chunk)
        const poll = await pollIdMappingJob(transcript, jobId, pollTimeoutS)
        for (const failedId of poll.failedIds) remoteFailedIds.push(failedId)
        const chunkRecords =
          poll.results ?? (await fetchIdMappingResults(transcript, jobId, maxBytes))
        for (const record of chunkRecords) records.push(record)
        batches.push({
          chunk_index: batches.length,
          n_ids: chunk.length,
          job_id: jobId,
          n_records: chunkRecords.length,
          n_failed_ids: poll.failedIds.length,
          n_http_requests: transcript.nHttpRequests - requestsBefore
        })
      }

      // An identifier counts as unmapped when no result answers for it, and also when the service
      // named it as failed — a service-declared failure outranks a stray echo in the results.
      const mappedKeys = new Set(records.map((record) => record.from.toUpperCase()))
      const failedKeys = new Set(remoteFailedIds.map((id) => id.toUpperCase()))
      const unmappedIds = uniqueIds.filter(
        (id) => !mappedKeys.has(id.toUpperCase()) || failedKeys.has(id.toUpperCase())
      )
      const unmappedTruncated = unmappedIds.length > UNMAPPED_LIST_CAP
      const batchesForProvenance = batches.map((batch) => ({
        job_id: String(batch.job_id),
        n_http_requests: Number(batch.n_http_requests)
      }))

      return {
        from,
        to,
        n_input: ids.length,
        n_unique_input: uniqueIds.length,
        n_duplicate_skipped: duplicateSkipped,
        n_records: records.length,
        n_mapped_inputs: uniqueIds.length - unmappedIds.length,
        n_unmapped: unmappedIds.length,
        unmapped: unmappedIds.slice(0, UNMAPPED_LIST_CAP),
        ...(unmappedTruncated ? { unmapped_truncated: true } : {}),
        records: records.slice(0, maxRecords),
        records_truncated: records.length > maxRecords,
        batches,
        provenance: transcript.provenance(
          'genes',
          'map_uniprot_ids',
          {
            from,
            to,
            chunk_size: chunkSize,
            n_input: ids.length,
            n_unique_input: uniqueIds.length
          },
          batchesForProvenance
        )
      }
    }
  }
]
