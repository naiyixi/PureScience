import { createHash } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GENES_PROTEINS_TOOLS } from './genes-proteins'
import type { ToolContext } from '../types'

// map_uniprot_ids is a two-phase job (submit → poll → paged stream) and, like the sequence tools, it
// uses the global fetch directly so its submission is never replayed by a retrying transport.
const ctx: ToolContext = {
  credentials: {},
  fetchJson: async () => {
    throw new Error('map_uniprot_ids must not use ctx.fetchJson')
  },
  fetchText: async () => {
    throw new Error('map_uniprot_ids must not use ctx.fetchText')
  },
  fetchJsonWithHeaders: async () => {
    throw new Error('map_uniprot_ids must not use ctx.fetchJsonWithHeaders')
  },
  postJson: async () => {
    throw new Error('map_uniprot_ids must not use ctx.postJson (retries would replay a submit)')
  }
}

const response = (status: number, body: string, link?: string): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: (name: string) => (name.toLowerCase() === 'link' ? (link ?? null) : null) }
  }) as unknown as Response

const tool = (): (typeof GENES_PROTEINS_TOOLS)[number] => {
  const found = GENES_PROTEINS_TOOLS.find((candidate) => candidate.id === 'map_uniprot_ids')
  if (!found) throw new Error('map_uniprot_ids is missing')
  return found
}

type Call = { url: string; init?: RequestInit }
type Outcome = { value?: unknown; error?: unknown; calls: Call[]; runs: number }

// Structural alias for the mapping result the assertions read — an explicit shape, so a change to
// the tool's contract is a compile error rather than a silently-passing test.
type MappingOut = {
  from: string
  to: string
  n_input: number
  n_unique_input: number
  n_duplicate_skipped: number
  n_records: number
  n_mapped_inputs: number
  n_unmapped: number
  unmapped: string[]
  unmapped_truncated?: boolean
  records: Array<{ from: string; to: string }>
  records_truncated: boolean
  batches: Array<{
    chunk_index: number
    n_ids: number
    job_id: string
    n_records: number
    n_failed_ids: number
    n_http_requests: number
  }>
  provenance: {
    connector: string
    tool: string
    params: Record<string, unknown>
    response_sha256: string
    jobs: Array<{ job_id: string; n_http_requests: number }>
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const digestOf = (parts: string[]): string => sha256(parts.join('\u0000'))

async function execute(
  args: Record<string, unknown>,
  handler: (url: string, init?: RequestInit) => Response | undefined
): Promise<Outcome> {
  vi.useFakeTimers()
  const calls: Call[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const res = handler(String(url), init)
    if (!res) throw new Error(`unexpected fetch: ${url}`)
    return res
  })
  vi.stubGlobal('fetch', impl)
  const promise = tool().run!(ctx, args)
  const settledPromise = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
  await vi.runAllTimersAsync()
  const settled = await settledPromise
  return { ...settled, calls, runs: calls.filter((call) => call.url.endsWith('/run')).length }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const JOB = 'btKDecwgv9'
const STATUS = JSON.stringify({ jobStatus: 'FINISHED' })

const idMappingHandler =
  (streamBody: string, statusBody = STATUS) =>
  (url: string): Response | undefined => {
    if (url.endsWith('/idmapping/run')) return response(200, JSON.stringify({ jobId: JOB }))
    if (url.includes('/idmapping/status/')) return response(200, statusBody)
    if (url.includes('/idmapping/stream/')) return response(200, streamBody)
    return undefined
  }

describe('map_uniprot_ids — batch mapping', () => {
  it('maps the hits and NAMES every unmapped identifier (red line 3)', async () => {
    const stream = JSON.stringify({
      results: [
        { from: 'P04637', to: 'ENSG00000141510.20' },
        { from: 'P38398', to: 'ENSG00000012048.27' }
      ]
    })
    const outcome = await execute(
      { from: 'UniProtKB_AC-ID', to: 'Ensembl', ids: ['P04637', 'P38398', 'NOPE'] },
      idMappingHandler(stream)
    )

    expect(outcome.error).toBeUndefined()
    const out = outcome.value as MappingOut
    // The miss is listed by name — never collapsed into a bare count.
    expect(out.unmapped).toEqual(['NOPE'])
    expect(out.n_unmapped).toBe(1)
    expect(out.n_mapped_inputs).toBe(2)
    expect(out.n_records).toBe(2)
    expect(out.records).toEqual([
      { from: 'P04637', to: 'ENSG00000141510.20' },
      { from: 'P38398', to: 'ENSG00000012048.27' }
    ])
    // Counts are self-consistent.
    expect(out.n_input).toBe(out.n_mapped_inputs + out.n_unmapped)
    expect(out.n_unique_input).toBe(3)
    expect(out.n_duplicate_skipped).toBe(0)

    // Red line 1: one submit, then poll + stream.
    expect(outcome.runs).toBe(1)
    expect(outcome.calls[0].init?.method).toBe('POST')
    expect(new URLSearchParams(String(outcome.calls[0].init?.body)).get('ids')).toBe(
      'P04637,P38398,NOPE'
    )

    // Red line 2: connector id + params + response fingerprint.
    expect(out.provenance.connector).toBe('genes')
    expect(out.provenance.tool).toBe('map_uniprot_ids')
    expect(out.provenance.params).toMatchObject({ from: 'UniProtKB_AC-ID', to: 'Ensembl' })
    expect(out.provenance.response_sha256).toBe(
      digestOf([JSON.stringify({ jobId: JOB }), STATUS, stream])
    )
    expect(out.provenance.jobs).toEqual([{ job_id: JOB, n_http_requests: 3 }])
    expect(out.batches).toHaveLength(1)
    expect(out.batches[0]).toMatchObject({ chunk_index: 0, n_ids: 3, job_id: JOB, n_records: 2 })
  })

  it('takes results delivered inline, and honours the service’s own failedIds', async () => {
    // A finished job that fits on one page answers /status with `results` and NO `jobStatus` at all
    // (observed against the live service), plus a `failedIds` list of the identifiers it could not map.
    const status = JSON.stringify({
      results: [{ from: 'P04637', to: 'ENSG00000141510.20' }],
      failedIds: ['P38398']
    })
    let streamCalls = 0
    const outcome = await execute({ from: 'X', to: 'Y', ids: ['P04637', 'P38398'] }, (url) => {
      if (url.endsWith('/idmapping/run')) return response(200, JSON.stringify({ jobId: JOB }))
      if (url.includes('/idmapping/status/')) return response(200, status)
      if (url.includes('/idmapping/stream/')) {
        streamCalls += 1
        return response(200, JSON.stringify({ results: [] }))
      }
      return undefined
    })
    const out = outcome.value as MappingOut
    expect(out.records).toEqual([{ from: 'P04637', to: 'ENSG00000141510.20' }])
    expect(out.unmapped).toEqual(['P38398'])
    expect(out.n_unmapped).toBe(1)
    expect(out.batches[0].n_failed_ids).toBe(1)
    // The status response already carried the results, so no stream request is needed.
    expect(streamCalls).toBe(0)
  })

  it('reports a service-declared failure even when a result echoes the identifier', async () => {
    const status = JSON.stringify({
      results: [
        { from: 'P04637', to: 'ENSG00000141510.20' },
        { from: 'P38398', to: 'ENSG00000012048.27' }
      ],
      failedIds: ['P38398']
    })
    const outcome = await execute({ from: 'X', to: 'Y', ids: ['P04637', 'P38398'] }, (url) => {
      if (url.endsWith('/idmapping/run')) return response(200, JSON.stringify({ jobId: JOB }))
      if (url.includes('/idmapping/status/')) return response(200, status)
      return undefined
    })
    const out = outcome.value as MappingOut
    // The service named it as failed, so it is reported as a miss rather than silently counted as mapped.
    expect(out.unmapped).toEqual(['P38398'])
    expect(out.n_mapped_inputs).toBe(1)
  })

  it('follows the Link header across result pages', async () => {
    const page2 = 'https://rest.uniprot.org/idmapping/stream/btKDecwgv9?cursor=abc'
    const page1 = JSON.stringify({ results: [{ from: 'A1', to: 'T1' }] })
    const page2Body = JSON.stringify({ results: [{ from: 'A2', to: 'T2' }] })
    const outcome = await execute({ from: 'X', to: 'Y', ids: ['A1', 'A2'] }, (url) => {
      if (url.endsWith('/idmapping/run')) return response(200, JSON.stringify({ jobId: JOB }))
      if (url.includes('/idmapping/status/')) return response(200, STATUS)
      if (url.includes('cursor=abc')) return response(200, page2Body)
      if (url.includes('/idmapping/stream/')) return response(200, page1, `<${page2}>; rel="next"`)
      return undefined
    })
    const out = outcome.value as MappingOut
    expect(out.n_records).toBe(2)
    expect(out.records).toEqual([
      { from: 'A1', to: 'T1' },
      { from: 'A2', to: 'T2' }
    ])
    expect(outcome.calls.filter((call) => call.url.includes('/idmapping/stream/'))).toHaveLength(2)
  })

  it('refuses to follow a next link that leaves the service host', async () => {
    const page1 = JSON.stringify({ results: [{ from: 'A1', to: 'T1' }] })
    const outcome = await execute({ from: 'X', to: 'Y', ids: ['A1'] }, (url) => {
      if (url.endsWith('/idmapping/run')) return response(200, JSON.stringify({ jobId: JOB }))
      if (url.includes('/idmapping/status/')) return response(200, STATUS)
      if (url.includes('/idmapping/stream/')) {
        return response(200, page1, '<https://evil.test/steal>; rel="next"')
      }
      return undefined
    })
    const out = outcome.value as MappingOut
    expect(out.n_records).toBe(1)
    expect(outcome.calls.some((call) => call.url.includes('evil.test'))).toBe(false)
  })

  it('runs one job per chunk and records each job in provenance', async () => {
    let job = 0
    const outcome = await execute(
      { from: 'X', to: 'Y', ids: ['A1', 'A2', 'A3'], chunk_size: 2 },
      (url) => {
        if (url.endsWith('/idmapping/run'))
          return response(200, JSON.stringify({ jobId: `job-${job++}` }))
        if (url.includes('/idmapping/status/')) return response(200, STATUS)
        if (url.includes('/idmapping/stream/job-0')) {
          return response(
            200,
            JSON.stringify({
              results: [
                { from: 'A1', to: 'T1' },
                { from: 'A2', to: 'T2' }
              ]
            })
          )
        }
        if (url.includes('/idmapping/stream/job-1')) {
          return response(200, JSON.stringify({ results: [{ from: 'A3', to: 'T3' }] }))
        }
        return undefined
      }
    )
    const out = outcome.value as MappingOut
    expect(outcome.runs).toBe(2)
    expect(out.batches.map((batch: { job_id: string }) => batch.job_id)).toEqual(['job-0', 'job-1'])
    expect(out.batches.map((batch: { n_ids: number }) => batch.n_ids)).toEqual([2, 1])
    expect(out.provenance.jobs.map((entry: { job_id: string }) => entry.job_id)).toEqual([
      'job-0',
      'job-1'
    ])
    // The remote job ids are captured verbatim under the submit body's `ids`.
    expect(new URLSearchParams(String(outcome.calls[0].init?.body)).get('ids')).toBe('A1,A2')
    expect(new URLSearchParams(String(outcome.calls[3].init?.body)).get('ids')).toBe('A3')
  })

  it('deduplicates case-insensitively and reports the skip', async () => {
    const outcome = await execute(
      { from: 'X', to: 'Y', ids: ['P04637', 'p04637', 'P38398'] },
      idMappingHandler(JSON.stringify({ results: [] }))
    )
    const out = outcome.value as MappingOut
    expect(out.n_input).toBe(3)
    expect(out.n_unique_input).toBe(2)
    expect(out.n_duplicate_skipped).toBe(1)
    expect(String(new URLSearchParams(String(outcome.calls[0].init?.body)).get('ids'))).toBe(
      'P04637,P38398'
    )
  })

  it('treats an all-unmapped job as a valid result, not a failure', async () => {
    const outcome = await execute(
      { from: 'X', to: 'Y', ids: ['NOPE1', 'NOPE2'] },
      idMappingHandler(JSON.stringify({ results: [] }))
    )
    expect(outcome.error).toBeUndefined()
    const out = outcome.value as MappingOut
    expect(out.unmapped).toEqual(['NOPE1', 'NOPE2'])
    expect(out.n_mapped_inputs).toBe(0)
    expect(out.n_records).toBe(0)
  })

  it('caps the returned records but says so', async () => {
    const results = Array.from({ length: 5 }, (_, i) => ({ from: `A${i}`, to: `T${i}` }))
    const outcome = await execute(
      { from: 'X', to: 'Y', ids: results.map((r) => r.from), max_records: 2 },
      idMappingHandler(JSON.stringify({ results }))
    )
    const out = outcome.value as MappingOut
    expect(out.records).toHaveLength(2)
    expect(out.records_truncated).toBe(true)
    expect(out.n_records).toBe(5)
  })

  it('rejects an identifier containing a comma or whitespace before any call', async () => {
    const outcome = await execute({ from: 'X', to: 'Y', ids: ['P04637', 'A B'] }, () => undefined)
    expect(String((outcome.error as Error).message)).toMatch(/comma or whitespace/)
    expect(outcome.calls).toHaveLength(0)
  })

  it('requires from, to and a non-empty id list', async () => {
    expect(
      String(((await execute({ to: 'Y', ids: ['A'] }, () => undefined)).error as Error).message)
    ).toMatch(/both `from` and `to`/)
    expect(
      String(
        ((await execute({ from: 'X', to: 'Y', ids: [''] }, () => undefined)).error as Error).message
      )
    ).toMatch(/at least one identifier/)
  })
})

describe('map_uniprot_ids — named failures (red line 5)', () => {
  it('names a rejected submission and never replays it (red line 1)', async () => {
    let attempts = 0
    const outcome = await execute({ from: 'X', to: 'Y', ids: ['A1'] }, () => {
      attempts += 1
      return response(
        400,
        JSON.stringify({ messages: ["The parameter 'from' has an invalid value."] })
      )
    })
    expect((outcome.error as { kind?: string }).kind).toBe('remote-rejected')
    expect(String((outcome.error as Error).message)).toMatch(/rejected the submission \(HTTP 400\)/)
    expect(attempts).toBe(1)
  })

  it('names an unknown job', async () => {
    const outcome = await execute({ from: 'X', to: 'Y', ids: ['A1'] }, (url) => {
      if (url.endsWith('/idmapping/run')) return response(200, JSON.stringify({ jobId: JOB }))
      if (url.includes('/idmapping/status/'))
        return response(404, JSON.stringify({ messages: ['Resource not found'] }))
      return undefined
    })
    expect((outcome.error as { kind?: string }).kind).toBe('job-not-found')
  })

  it('names a failed job', async () => {
    const outcome = await execute(
      { from: 'X', to: 'Y', ids: ['A1'] },
      idMappingHandler('', JSON.stringify({ jobStatus: 'ERROR' }))
    )
    expect((outcome.error as { kind?: string }).kind).toBe('job-failed')
  })

  it('names a poll timeout and keeps the job id for the next attempt', async () => {
    const outcome = await execute(
      { from: 'X', to: 'Y', ids: ['A1'], poll_timeout_s: 5 },
      idMappingHandler('', JSON.stringify({ jobStatus: 'RUNNING' }))
    )
    expect((outcome.error as { kind?: string }).kind).toBe('timeout')
    expect(String((outcome.error as Error).message)).toContain(JOB)
  })

  it('names a receipt whose shape changed', async () => {
    const outcome = await execute({ from: 'X', to: 'Y', ids: ['A1'] }, (url) =>
      url.endsWith('/idmapping/run') ? response(200, 'not json') : undefined
    )
    expect((outcome.error as { kind?: string }).kind).toBe('contract-changed')
  })

  it('names a result page whose shape changed', async () => {
    const outcome = await execute(
      { from: 'X', to: 'Y', ids: ['A1'] },
      idMappingHandler(JSON.stringify({ unexpected: true }))
    )
    expect((outcome.error as { kind?: string }).kind).toBe('contract-changed')
  })

  it('names an oversized record set instead of truncating silently', async () => {
    const results = Array.from({ length: 200 }, (_, i) => ({
      from: `INPUTID_${i}`,
      to: `TARGET_${i}`
    }))
    const outcome = await execute(
      { from: 'X', to: 'Y', ids: results.map((r) => r.from), max_bytes: 1000 },
      idMappingHandler(JSON.stringify({ results }))
    )
    expect((outcome.error as { kind?: string }).kind).toBe('response-too-large')
  })
})

// Live self-tests against the real UniProt ID Mapping service. Off by default; run with LIVE_API=1.
describe.skipIf(!process.env.LIVE_API)('map_uniprot_ids / LIVE', () => {
  it('maps a mixed identifier list and names the miss with self-consistent counts', async () => {
    const out = (await tool().run!(ctx, {
      from: 'UniProtKB_AC-ID',
      to: 'Ensembl',
      ids: ['P04637', 'P38398', 'NOT_A_REAL_ACCESSION_ZZZ']
    })) as MappingOut

    expect(out.n_input).toBe(3)
    expect(out.n_mapped_inputs + out.n_unmapped).toBe(out.n_unique_input)
    expect(out.unmapped).toContain('NOT_A_REAL_ACCESSION_ZZZ')
    expect(out.n_mapped_inputs).toBeGreaterThan(0)
    // The fingerprint is over the bytes this call actually received.
    expect(out.provenance.connector).toBe('genes')
    expect(out.provenance.response_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(out.batches.length).toBe(1)
  }, 300_000)
})
