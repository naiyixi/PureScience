import type { ToolContext, ToolDescriptor } from '../types'
import {
  JobTranscript,
  RemoteFailure,
  assertNonEmpty,
  assertWithinByteCap,
  bytesOf,
  fetchTextRetrying,
  sha256Hex,
  sleep,
  submitOnce
} from './job-transport'

// "Sequence tools" connector — similarity search (NCBI BLAST+), multiple sequence alignment
// (Clustal Omega) and a read-only view of an existing InterProScan job, all hosted on the EMBL-EBI
// Job Dispatcher REST API.
//
// Each tool is a TWO-PHASE job and says so in its own words:
//   submit  — POST <base>/run (form-encoded). Non-idempotent: exactly one attempt, never retried.
//   status  — GET  <base>/status/<jobId> (idempotent, transient statuses retried).
//   result  — GET  <base>/result/<jobId>/<type> (idempotent, transient statuses retried).
// A call with an explicit `job_id` skips the submit segment entirely, so a slow job is picked up
// again without ever creating a second one.
//
// Fair-use: EMBL-EBI asks that no more than 30 jobs per user be in flight at once, that a valid
// contact email accompany every submission, and that the next batch wait until the previous results
// are retrieved. Every submit here carries the configured contact email; the tools never fan out
// parallel jobs within one call.
const EBI_ROOT = 'https://www.ebi.ac.uk/Tools/services/rest'
const BLAST_BASE = `${EBI_ROOT}/ncbiblast`
const CLUSTAL_BASE = `${EBI_ROOT}/clustalo`
const INTERPROSCAN_BASE = `${EBI_ROOT}/iprscan5`

const POLL_INTERVAL_MS = 2_000
const DEFAULT_POLL_TIMEOUT_S = 60
const MIN_POLL_TIMEOUT_S = 5
const MAX_POLL_TIMEOUT_S = 300

const DEFAULT_MAX_BYTES = 2_000_000
const MIN_MAX_BYTES = 1_000
const MAX_MAX_BYTES = 32_000_000

const SUBMIT_TIMEOUT_MS = 30_000
const READ_TIMEOUT_MS = 30_000
const MAX_SEQUENCE_BYTES = 1_000_000

const DEFAULT_MAX_HITS = 50
const MAX_MAX_HITS = 5_000

// Plain-text job states the Job Dispatcher reports on /status/<jobId>.
const EBI_PENDING = new Set(['RUNNING', 'PENDING', 'QUEUED', 'STARTED', 'WAITING'])
const EBI_FAILED = new Set(['ERROR', 'FAILURE', 'KILLED', 'REJECTED'])

const BLAST_PROGRAMS = new Set(['blastp', 'blastn', 'blastx', 'tblastn', 'tblastx'])
// Which input sequence type each program expects (the /run `stype` field).
const DNA_QUERY_PROGRAMS = new Set(['blastn', 'blastx', 'tblastx'])

const CLUSTAL_RESULT_TYPES = new Set([
  'aln-clustal_num',
  'aln-clustal',
  'fa',
  'pim',
  'out',
  'phylotree'
])
const INTERPROSCAN_RESULT_TYPES = new Set(['tsv', 'json', 'xml', 'gff', 'txt', 'out'])

const clampNumber = (raw: unknown, fallback: number, min: number, max: number): number => {
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

const stringArg = (value: unknown): string => (value == null ? '' : String(value).trim())

const excerpt = (text: string): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed
}

// The Job Dispatcher requires a contact email per its fair-use policy. A missing one is a structured
// result (mirrors the connection tools that need the NCBI contact email), not a silent keyless call.
const contactEmail = (ctx: ToolContext): string | undefined => {
  const value = ctx.credentials.ncbiEmail?.trim()
  return value && value !== '' ? value : undefined
}

const contactRequired = (tool: string): { error: 'contact_email_required'; message: string } => ({
  error: 'contact_email_required',
  message:
    `${tool} submits to the EMBL-EBI Job Dispatcher, which requires a contact email per its ` +
    "fair-use policy. Enable 'Share contact email with research data services' in Settings → " +
    'Privacy to provide one, then retry (the connector picks up the setting automatically).'
})

const assertSequence = (sequence: string, tool: string): void => {
  if (sequence === '') {
    throw new Error(
      `${tool} needs either a 'sequence' to submit or a 'job_id' to resume an existing job.`
    )
  }
  const size = bytesOf(sequence)
  if (size > MAX_SEQUENCE_BYTES) {
    throw new Error(
      `${tool}: sequence is ${size} bytes, over the ${MAX_SEQUENCE_BYTES}-byte input cap. Submit a ` +
        `shorter query (BLAST against a large database is the usual limit here).`
    )
  }
}

// POST the submit once and read back the job id. The job id is the only handle a caller has on work
// that is now running remotely, so a rejected submit never silently retries.
async function submitJob(
  base: string,
  label: string,
  fields: Record<string, string>,
  transcript: JobTranscript
): Promise<string> {
  const res = await submitOnce(`${base}/run`, fields, {
    accept: 'text/plain',
    timeoutMs: SUBMIT_TIMEOUT_MS
  })
  transcript.record(res.text)
  if (!res.ok) {
    throw new RemoteFailure(
      'remote-rejected',
      `${label} rejected the submission (HTTP ${res.status}): ${excerpt(res.text)}`
    )
  }
  const jobId = res.text.trim()
  if (jobId === '' || jobId.startsWith('<')) {
    throw new RemoteFailure(
      'contract-changed',
      `${label} accepted the submission but returned no job id: ${excerpt(res.text)}`
    )
  }
  return jobId
}

// Poll /status/<jobId> until FINISHED, naming every other terminal outcome. On timeout the message
// carries the job id so the caller can resume instead of resubmitting.
async function pollJob(
  base: string,
  label: string,
  jobId: string,
  pollTimeoutS: number,
  transcript: JobTranscript
): Promise<string> {
  const deadline = Date.now() + pollTimeoutS * 1_000
  for (;;) {
    const url = `${base}/status/${encodeURIComponent(jobId)}`
    const res = await fetchTextRetrying(url, { accept: 'text/plain', timeoutMs: READ_TIMEOUT_MS })
    transcript.record(res.text)
    if (!res.ok) {
      throw new RemoteFailure(
        'remote-rejected',
        `${label} status read for job ${jobId} returned HTTP ${res.status}: ${excerpt(res.text)}`
      )
    }
    const status = res.text.trim()
    if (status === 'FINISHED') return status
    if (status === 'NOT_FOUND') {
      throw new RemoteFailure(
        'job-not-found',
        `${label} does not know job ${jobId} (status NOT_FOUND) — the id may be wrong or the job expired.`
      )
    }
    if (EBI_FAILED.has(status)) {
      throw new RemoteFailure(
        'job-failed',
        `${label} job ${jobId} ended in status ${status}. Re-submit only after checking the input.`
      )
    }
    if (!EBI_PENDING.has(status)) {
      throw new RemoteFailure(
        'contract-changed',
        `${label} job ${jobId} reported an unrecognized status '${status}'.`
      )
    }
    if (Date.now() >= deadline) {
      throw new RemoteFailure(
        'timeout',
        `${label} job ${jobId} did not finish within ${pollTimeoutS}s (last status ${status}). It may ` +
          `still be running remotely — re-call with job_id="${jobId}" to poll it again; do not resubmit.`
      )
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

// Read one result document. The byte cap is a guard, never a silent truncation.
async function readResult(
  base: string,
  label: string,
  jobId: string,
  resultType: string,
  maxBytes: number,
  transcript: JobTranscript
): Promise<string> {
  const url = `${base}/result/${encodeURIComponent(jobId)}/${encodeURIComponent(resultType)}`
  const res = await fetchTextRetrying(url, { accept: '*/*', timeoutMs: READ_TIMEOUT_MS })
  transcript.record(res.text)
  if (!res.ok) {
    throw new RemoteFailure(
      'remote-rejected',
      `${label} result '${resultType}' for job ${jobId} returned HTTP ${res.status}: ${excerpt(res.text)}`
    )
  }
  // A job that has not finished can answer a result request with an <error> document under HTTP 200;
  // that is a status problem, not a result, so name it rather than parse it as one.
  if (/^\s*<\?xml/.test(res.text) && /<error>/.test(res.text)) {
    throw new RemoteFailure(
      'contract-changed',
      `${label} returned an error document instead of result '${resultType}': ${excerpt(res.text)}`
    )
  }
  assertNonEmpty(res.text, `${label} result '${resultType}' for job ${jobId}`)
  assertWithinByteCap(res.text, maxBytes, `${label} result '${resultType}' for job ${jobId}`)
  return res.text
}

type BlastHsp = {
  hsp_bit_score?: number
  hsp_expect?: number
  hsp_identity?: number
  hsp_align_len?: number
  hsp_positive?: number
  hsp_gaps?: number
}
type BlastHit = {
  hit_num?: number
  hit_id?: string
  hit_acc?: string
  hit_def?: string
  hit_len?: number
  hit_os?: string
  hit_hsps?: BlastHsp[]
}
type BlastDocument = {
  program?: string
  version?: string
  query_def?: string
  query_len?: number
  db_num?: number
  db_len?: number
  matrix?: string
  expect_upper?: number
  hits?: BlastHit[]
}

// One compact hit: identity/position of the target plus its best-scoring HSP, so a caller sees the
// result without the full HSP alignment text bloating the tool output.
const compactHit = (hit: BlastHit): Record<string, unknown> => {
  const hsps = Array.isArray(hit.hit_hsps) ? hit.hit_hsps : []
  const best = hsps.reduce<BlastHsp | undefined>(
    (top, hsp) =>
      top === undefined || (hsp.hsp_bit_score ?? -Infinity) > (top.hsp_bit_score ?? -Infinity)
        ? hsp
        : top,
    undefined
  )
  return {
    hit_num: hit.hit_num ?? null,
    hit_id: hit.hit_id ?? null,
    hit_acc: hit.hit_acc ?? null,
    hit_def: hit.hit_def ?? null,
    hit_len: hit.hit_len ?? null,
    organism: hit.hit_os ?? null,
    n_hsps: hsps.length,
    best: best
      ? {
          bit_score: best.hsp_bit_score ?? null,
          expect: best.hsp_expect ?? null,
          identity: best.hsp_identity ?? null,
          positives: best.hsp_positive ?? null,
          align_len: best.hsp_align_len ?? null,
          gaps: best.hsp_gaps ?? null
        }
      : null
  }
}

export const SEQUENCE_TOOLS: ToolDescriptor[] = [
  {
    id: 'blast_search',
    connector: 'sequence_tools',
    description:
      'NCBI BLAST+ similarity search on the EMBL-EBI Job Dispatcher. Two-phase job: with `sequence` a ' +
      'job is submitted (a single, non-retried POST) and then polled to completion; with `job_id` the ' +
      'submit is skipped and an existing job is polled and read (so a long search is picked up again ' +
      'without creating a second job). Program defaults to blastp; database defaults to ' +
      'uniprotkb_swissprot; `stype` (protein/dna) is derived from the program unless given. Returns the ' +
      'job id, search metadata, and up to `max_hits` compact hits (each with its best HSP). Failures are ' +
      'named: a rejected submission, an unknown/failed job, a timeout (the message carries the job id to ' +
      'resume), an empty result, or an oversized result (raise `max_bytes`). Runs one job per call; ' +
      'EMBL-EBI asks that no more than 30 jobs be in flight per user, so batch work one call at a time.',
    input: {
      type: 'object',
      properties: {
        sequence: {
          type: 'string',
          description:
            'Query sequence (raw residues or FASTA). Required unless resuming via job_id.'
        },
        program: {
          type: 'string',
          enum: ['blastp', 'blastn', 'blastx', 'tblastn', 'tblastx'],
          description: 'BLAST program, default "blastp".'
        },
        database: {
          type: 'string',
          description: 'Target database, default "uniprotkb_swissprot" (e.g. "pdb", "uniprotkb").'
        },
        stype: {
          type: 'string',
          enum: ['protein', 'dna'],
          description: 'Derived from program when omitted.'
        },
        exp: { type: 'number', description: 'E-value upper threshold, default 10.' },
        job_id: {
          type: 'string',
          description: 'Resume an existing job instead of submitting a new one.'
        },
        result_type: {
          type: 'string',
          enum: ['json', 'tsv', 'out'],
          description: 'Result document, default "json" (JSON parsed into hits).'
        },
        max_hits: {
          type: 'number',
          description: `Hits returned, default ${DEFAULT_MAX_HITS}, cap ${MAX_MAX_HITS}.`
        },
        max_bytes: {
          type: 'number',
          description: `Result byte cap, default ${DEFAULT_MAX_BYTES}; exceeding it is a named error, not a truncation.`
        },
        poll_timeout_s: {
          type: 'number',
          description: `Deadline for the job to finish, default ${DEFAULT_POLL_TIMEOUT_S}s, max ${MAX_POLL_TIMEOUT_S}s.`
        }
      }
    },
    returns:
      '`{ job_id, status: "FINISHED", submitted, result_type, query: {program, database, stype, exp}, ' +
      'summary: {program, version, query_def, query_len, db_num, db_len, matrix, expect_upper} | null, ' +
      'n_hits, n_hits_returned, hits_truncated, hits: [{hit_num, hit_id, hit_acc, hit_def, hit_len, ' +
      'organism, n_hsps, best: {bit_score, expect, identity, positives, align_len, gaps}}], result: str ' +
      '(tsv/out only), result_bytes, provenance: {connector, tool, params, response_sha256, retrieved_at, ' +
      'n_http_requests, bytes_received, jobs}}`.',
    example:
      'const result = await host.mcp("sequence_tools", "blast_search", {"program": "blastp", "database": "uniprotkb_swissprot", "sequence": "MTEYKLVVVGAGGVGKSALTIQLIQNHFVDEYDPTIEDSYRKQVVIDGETCLLDILDTAG", "max_hits": 10})',
    run: async (ctx: ToolContext, a: Record<string, unknown>) => {
      const email = contactEmail(ctx)
      if (!email) return contactRequired('blast_search')

      const resumedJobId = stringArg(a.job_id)
      const program = stringArg(a.program) || 'blastp'
      if (!BLAST_PROGRAMS.has(program)) {
        throw new Error(
          `blast_search: unsupported program '${program}'. Use one of ${[...BLAST_PROGRAMS].join(', ')}.`
        )
      }
      const database = stringArg(a.database) || 'uniprotkb_swissprot'
      const stype = stringArg(a.stype) || (DNA_QUERY_PROGRAMS.has(program) ? 'dna' : 'protein')
      if (stype !== 'protein' && stype !== 'dna') {
        throw new Error(`blast_search: stype must be "protein" or "dna", got '${stype}'.`)
      }
      const exp = clampNumber(a.exp, 10, 0.0001, 100_000)
      const resultType = stringArg(a.result_type) || 'json'
      if (resultType !== 'json' && resultType !== 'tsv' && resultType !== 'out') {
        throw new Error(`blast_search: result_type must be json, tsv or out, got '${resultType}'.`)
      }
      const maxHits = clampNumber(a.max_hits, DEFAULT_MAX_HITS, 1, MAX_MAX_HITS)
      const maxBytes = clampNumber(a.max_bytes, DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_MAX_BYTES)
      const pollTimeoutS = clampNumber(
        a.poll_timeout_s,
        DEFAULT_POLL_TIMEOUT_S,
        MIN_POLL_TIMEOUT_S,
        MAX_POLL_TIMEOUT_S
      )

      const transcript = new JobTranscript()
      const sequence = a.sequence == null ? '' : String(a.sequence)

      let jobId = resumedJobId
      if (jobId === '') {
        assertSequence(sequence, 'blast_search')
        jobId = await submitJob(
          BLAST_BASE,
          'NCBI BLAST+',
          {
            email,
            program,
            database,
            stype,
            exp: String(exp),
            sequence
          },
          transcript
        )
      }
      const status = await pollJob(BLAST_BASE, 'NCBI BLAST+', jobId, pollTimeoutS, transcript)
      const body = await readResult(
        BLAST_BASE,
        'NCBI BLAST+',
        jobId,
        resultType,
        maxBytes,
        transcript
      )

      const params: Record<string, unknown> = {
        program,
        database,
        stype,
        exp,
        result_type: resultType,
        ...(sequence !== ''
          ? { sequence_sha256: sha256Hex(sequence), sequence_bytes: bytesOf(sequence) }
          : {})
      }
      const provenance = transcript.provenance('sequence_tools', 'blast_search', params, [
        { job_id: jobId, n_http_requests: transcript.nHttpRequests }
      ])

      if (resultType !== 'json') {
        return {
          job_id: jobId,
          status,
          submitted: resumedJobId === '',
          result_type: resultType,
          query: { program, database, stype, exp },
          result: body,
          result_bytes: bytesOf(body),
          provenance
        }
      }

      let document: BlastDocument
      try {
        document = JSON.parse(body) as BlastDocument
      } catch {
        throw new RemoteFailure(
          'contract-changed',
          `NCBI BLAST+ returned a result_type=json document that is not valid JSON: ${excerpt(body)}`
        )
      }
      if (document === null || typeof document !== 'object' || !Array.isArray(document.hits)) {
        throw new RemoteFailure(
          'contract-changed',
          'NCBI BLAST+ result JSON carried no `hits` array — the result contract may have changed.'
        )
      }
      const hits = document.hits
      return {
        job_id: jobId,
        status,
        submitted: resumedJobId === '',
        result_type: resultType,
        query: { program, database, stype, exp },
        summary: {
          program: document.program ?? null,
          version: document.version ?? null,
          query_def: document.query_def ?? null,
          query_len: document.query_len ?? null,
          db_num: document.db_num ?? null,
          db_len: document.db_len ?? null,
          matrix: document.matrix ?? null,
          expect_upper: document.expect_upper ?? null
        },
        n_hits: hits.length,
        n_hits_returned: Math.min(hits.length, maxHits),
        hits_truncated: hits.length > maxHits,
        hits: hits.slice(0, maxHits).map(compactHit),
        result_bytes: bytesOf(body),
        provenance
      }
    }
  },
  {
    id: 'clustal_align',
    connector: 'sequence_tools',
    description:
      'Clustal Omega multiple sequence alignment on the EMBL-EBI Job Dispatcher. Two-phase job: pass ' +
      '`sequence` (a multi-FASTA string of at least two records) to submit a job — a single, non-retried ' +
      'POST — then it is polled to completion; pass `job_id` to skip the submit and read an existing job. ' +
      'Returns the alignment (default CLUSTAL format with residue numbering) plus the job id and ' +
      'provenance. Failures are named (rejected submission, unknown/failed job, timeout with the job id to ' +
      'resume, empty result, oversized result). Runs one job per call; EMBL-EBI asks that no more than 30 ' +
      'jobs be in flight per user, so batch work one call at a time.',
    input: {
      type: 'object',
      properties: {
        sequence: {
          type: 'string',
          description:
            'Multi-FASTA (>= 2 records, each ">name" followed by residues). Required unless resuming via job_id.'
        },
        stype: {
          type: 'string',
          enum: ['protein', 'dna'],
          description: 'Input type, default "protein".'
        },
        result_type: {
          type: 'string',
          enum: [...CLUSTAL_RESULT_TYPES],
          description: 'Result document, default "aln-clustal_num" (CLUSTAL with numbering).'
        },
        job_id: {
          type: 'string',
          description: 'Resume an existing job instead of submitting a new one.'
        },
        max_bytes: {
          type: 'number',
          description: `Alignment byte cap, default ${DEFAULT_MAX_BYTES}; exceeding it is a named error, not a truncation.`
        },
        poll_timeout_s: {
          type: 'number',
          description: `Deadline for the job to finish, default ${DEFAULT_POLL_TIMEOUT_S}s, max ${MAX_POLL_TIMEOUT_S}s.`
        }
      }
    },
    returns:
      '`{ job_id, status: "FINISHED", submitted, result_type, query: {stype, n_sequences}, result: str, ' +
      'result_bytes, provenance: {connector, tool, params, response_sha256, retrieved_at, n_http_requests, ' +
      'bytes_received, jobs}}`.',
    example:
      'const result = await host.mcp("sequence_tools", "clustal_align", {"stype": "protein", "sequence": ">a\\nMTEYKLVVVGAGGVGKSALTIQLIQNHFVDEYDPT\\n>b\\nMTEYKLVVVGAGGVGKSALTIQLIQNHFVDEYDPA"})',
    run: async (ctx: ToolContext, a: Record<string, unknown>) => {
      const email = contactEmail(ctx)
      if (!email) return contactRequired('clustal_align')

      const resumedJobId = stringArg(a.job_id)
      const stype = stringArg(a.stype) || 'protein'
      if (stype !== 'protein' && stype !== 'dna') {
        throw new Error(`clustal_align: stype must be "protein" or "dna", got '${stype}'.`)
      }
      const resultType = stringArg(a.result_type) || 'aln-clustal_num'
      if (!CLUSTAL_RESULT_TYPES.has(resultType)) {
        throw new Error(
          `clustal_align: unknown result_type '${resultType}'. Use one of ${[...CLUSTAL_RESULT_TYPES].join(', ')}.`
        )
      }
      const maxBytes = clampNumber(a.max_bytes, DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_MAX_BYTES)
      const pollTimeoutS = clampNumber(
        a.poll_timeout_s,
        DEFAULT_POLL_TIMEOUT_S,
        MIN_POLL_TIMEOUT_S,
        MAX_POLL_TIMEOUT_S
      )

      const transcript = new JobTranscript()
      const sequence = a.sequence == null ? '' : String(a.sequence)
      const nRecords = sequence.split('\n').filter((line) => line.startsWith('>')).length

      let jobId = resumedJobId
      if (jobId === '') {
        assertSequence(sequence, 'clustal_align')
        if (nRecords < 2) {
          throw new Error(
            `clustal_align: an alignment needs at least two sequences — the input has ${nRecords} ` +
              `FASTA record(s). Provide a multi-FASTA string.`
          )
        }
        jobId = await submitJob(
          CLUSTAL_BASE,
          'Clustal Omega',
          { email, stype, sequence },
          transcript
        )
      }
      const status = await pollJob(CLUSTAL_BASE, 'Clustal Omega', jobId, pollTimeoutS, transcript)
      const body = await readResult(
        CLUSTAL_BASE,
        'Clustal Omega',
        jobId,
        resultType,
        maxBytes,
        transcript
      )
      const params: Record<string, unknown> = {
        stype,
        result_type: resultType,
        ...(sequence !== '' ? { sequence_sha256: sha256Hex(sequence), n_sequences: nRecords } : {})
      }
      return {
        job_id: jobId,
        status,
        submitted: resumedJobId === '',
        result_type: resultType,
        query: { stype, n_sequences: nRecords },
        result: body,
        result_bytes: bytesOf(body),
        provenance: transcript.provenance('sequence_tools', 'clustal_align', params, [
          { job_id: jobId, n_http_requests: transcript.nHttpRequests }
        ])
      }
    }
  },
  {
    // READ-ONLY on purpose: this tool only ever reads /status/<jobId> and /result/<jobId>/<type> for a
    // job id the caller already has. It has no submit path and no cancel/delete path, so it can never
    // create or destroy a job — in particular it never collides with an InterProScan job the user
    // submitted by hand. The test suite asserts no '/run' request is reachable from this tool.
    id: 'interproscan_query',
    connector: 'sequence_tools',
    description:
      'Read an EXISTING InterProScan (iprscan5) job on the EMBL-EBI Job Dispatcher by its `job_id` — the ' +
      'job status, and, once finished, the requested result document (TSV by default). Read-only: this ' +
      'tool never submits, cancels, or otherwise modifies a job, so it never disrupts a job the user ' +
      'started themselves. Polls up to `poll_timeout_s`; a still-running job is reported as ' +
      '`finished: false` with its status rather than as a failure.',
    input: {
      type: 'object',
      properties: {
        job_id: {
          type: 'string',
          description: 'The InterProScan job id (e.g. iprscan5-R20260929-160000-0000-00000000-p1m).'
        },
        result_type: {
          type: 'string',
          enum: [...INTERPROSCAN_RESULT_TYPES],
          description: 'Result document, default "tsv".'
        },
        max_bytes: {
          type: 'number',
          description: `Result byte cap, default ${DEFAULT_MAX_BYTES}; exceeding it is a named error, not a truncation.`
        },
        poll_timeout_s: {
          type: 'number',
          description: `How long to wait for a running job, default ${DEFAULT_POLL_TIMEOUT_S}s, max ${MAX_POLL_TIMEOUT_S}s.`
        }
      },
      required: ['job_id']
    },
    required: ['job_id'],
    returns:
      'Finished -> `{ job_id, status: "FINISHED", finished: true, result_type, result: str, result_bytes, ' +
      'provenance }`; still running -> `{ job_id, status, finished: false, note }`. Never submits a job.',
    example:
      'const result = await host.mcp("sequence_tools", "interproscan_query", {"job_id": "iprscan5-R20260929-160000-0000-00000000-p1m", "result_type": "tsv"})',
    run: async (_ctx: ToolContext, a: Record<string, unknown>) => {
      const jobId = stringArg(a.job_id)
      if (jobId === '') {
        throw new Error(
          'interproscan_query: job_id is required — this tool reads an existing InterProScan job and ' +
            'never submits one.'
        )
      }
      const resultType = stringArg(a.result_type) || 'tsv'
      if (!INTERPROSCAN_RESULT_TYPES.has(resultType)) {
        throw new Error(
          `interproscan_query: unknown result_type '${resultType}'. Use one of ${[...INTERPROSCAN_RESULT_TYPES].join(', ')}.`
        )
      }
      const maxBytes = clampNumber(a.max_bytes, DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_MAX_BYTES)
      const pollTimeoutS = clampNumber(
        a.poll_timeout_s,
        DEFAULT_POLL_TIMEOUT_S,
        MIN_POLL_TIMEOUT_S,
        MAX_POLL_TIMEOUT_S
      )

      const transcript = new JobTranscript()
      const deadline = Date.now() + pollTimeoutS * 1_000
      const statusUrl = `${INTERPROSCAN_BASE}/status/${encodeURIComponent(jobId)}`
      let status = ''
      for (;;) {
        const res = await fetchTextRetrying(statusUrl, {
          accept: 'text/plain',
          timeoutMs: READ_TIMEOUT_MS
        })
        transcript.record(res.text)
        if (!res.ok) {
          throw new RemoteFailure(
            'remote-rejected',
            `InterProScan status read for job ${jobId} returned HTTP ${res.status}: ${excerpt(res.text)}`
          )
        }
        status = res.text.trim()
        if (status === 'NOT_FOUND') {
          throw new RemoteFailure(
            'job-not-found',
            `InterProScan does not know job ${jobId} (status NOT_FOUND) — the id may be wrong or the job expired.`
          )
        }
        if (EBI_FAILED.has(status)) {
          throw new RemoteFailure(
            'job-failed',
            `InterProScan job ${jobId} ended in status ${status}; there is no result to read.`
          )
        }
        if (status === 'FINISHED' || !EBI_PENDING.has(status)) break
        if (Date.now() >= deadline) break
        await sleep(POLL_INTERVAL_MS)
      }

      const provenanceParams: Record<string, unknown> = { job_id: jobId, result_type: resultType }
      const provenance = (extraJobs = true): ReturnType<JobTranscript['provenance']> =>
        transcript.provenance(
          'sequence_tools',
          'interproscan_query',
          provenanceParams,
          extraJobs ? [{ job_id: jobId, n_http_requests: transcript.nHttpRequests }] : undefined
        )

      if (status !== 'FINISHED') {
        return {
          job_id: jobId,
          status,
          finished: false,
          result_type: resultType,
          note:
            `InterProScan job ${jobId} is still '${status}'. Re-call this tool to check again; this ` +
            `tool never submits or cancels a job.`,
          provenance: provenance()
        }
      }

      const body = await readResult(
        INTERPROSCAN_BASE,
        'InterProScan',
        jobId,
        resultType,
        maxBytes,
        transcript
      )
      return {
        job_id: jobId,
        status,
        finished: true,
        result_type: resultType,
        result: body,
        result_bytes: bytesOf(body),
        provenance: provenance()
      }
    }
  }
]
