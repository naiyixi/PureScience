import { createHash } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SEQUENCE_TOOLS } from './sequence-tools'
import type { ToolContext } from '../types'

// None of these tools may touch the ToolContext transport: the job-creating POST must never be
// replayed, which the shared engine's retrying postJson cannot promise, so they use the global fetch
// directly (mirrors zinc.test.ts). Every ctx method therefore throws if it is reached.
const ctx: ToolContext = {
  credentials: { ncbiEmail: 'connector@test.example' },
  fetchJson: async () => {
    throw new Error('sequence tools must not use ctx.fetchJson')
  },
  fetchText: async () => {
    throw new Error('sequence tools must not use ctx.fetchText')
  },
  fetchJsonWithHeaders: async () => {
    throw new Error('sequence tools must not use ctx.fetchJsonWithHeaders')
  },
  postJson: async () => {
    throw new Error('sequence tools must not use ctx.postJson (retries would replay a submit)')
  }
}

const response = (status: number, body: string): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: () => null }
  }) as unknown as Response

const tool = (id: string): (typeof SEQUENCE_TOOLS)[number] => {
  const found = SEQUENCE_TOOLS.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no tool ${id}`)
  return found
}

type Call = { url: string; init?: RequestInit }
type Outcome = { value?: unknown; error?: unknown; calls: Call[]; submitted: number }

// Structural aliases for the tool results the assertions below read. Keeping them explicit (rather
// than an `any` cast) is what makes a shape change a compile error instead of a silent pass.
type Provenance = {
  connector: string
  tool: string
  params: Record<string, unknown>
  response_sha256: string
  jobs: Array<{ job_id: string; n_http_requests: number }>
}
type BlastOut = {
  job_id: string
  status: string
  submitted: boolean
  result_type: string
  n_hits: number
  n_hits_returned: number
  hits_truncated: boolean
  hits: Array<{ hit_id: string; n_hsps: number; best: { bit_score: number } | null }>
  summary: Record<string, unknown>
  result: string
  provenance: Provenance
}
type ClustalOut = {
  job_id: string
  status: string
  submitted: boolean
  result: string
  query: { stype: string; n_sequences: number }
  provenance: Provenance
}
type InterproscanOut = {
  job_id: string
  status: string
  finished: boolean
  result: string
  note: string
  provenance: Provenance
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const digestOf = (parts: string[]): string => sha256(parts.join('\u0000'))

// Drives a tool through the fake-timer submit→poll flow. `handler` answers one request; returning
// undefined is a hard failure (the tool reached a URL the test did not expect).
async function execute(
  id: string,
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
  const promise = tool(id).run!(ctx, args)
  // Attach the rejection handler before advancing timers, so a rejecting tool never surfaces as an
  // unhandled rejection while the fake timers run.
  const settledPromise = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
  await vi.runAllTimersAsync()
  const settled = await settledPromise
  return {
    ...settled,
    calls,
    submitted: calls.filter((call) => call.url.endsWith('/run')).length
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const SEQ = 'MTEYKLVVVGAGGVGKSALTIQLIQNHFVDEYDPTIEDSYRKQVVIDGETCLLDILDTAG'
const JOB = 'ncbiblast-R20260929-180140-0553-58203697-p1m'

const HSP_LOW = {
  hsp_bit_score: 5,
  hsp_expect: 0.001,
  hsp_identity: 40,
  hsp_align_len: 80,
  hsp_positive: 50,
  hsp_gaps: 1
}
const HSP_BEST = {
  hsp_bit_score: 383.3,
  hsp_expect: 7.8e-137,
  hsp_identity: 100,
  hsp_align_len: 189,
  hsp_positive: 100,
  hsp_gaps: 0
}
const blastDocument = {
  program: 'blastp',
  version: 'BLASTP 2.16.0+',
  query_def: 'EMBOSS_001',
  query_len: 189,
  db_num: 1000,
  db_len: 200_000,
  matrix: 'BLOSUM62',
  expect_upper: 10,
  hits: [
    {
      hit_num: 1,
      hit_id: 'A',
      hit_acc: 'A_A',
      hit_def: 'first',
      hit_len: 189,
      hit_os: 'Homo sapiens',
      hit_hsps: [HSP_LOW, HSP_BEST]
    },
    {
      hit_num: 2,
      hit_id: 'B',
      hit_acc: 'B_A',
      hit_def: 'second',
      hit_len: 100,
      hit_os: 'Homo sapiens',
      hit_hsps: [{ hsp_bit_score: 10, hsp_expect: 1, hsp_identity: 50, hsp_align_len: 100 }]
    }
  ]
}

const blastHandler = (resultBody: string, statuses: string[]) => {
  let index = 0
  return (url: string): Response | undefined => {
    if (url.endsWith('/run')) return response(200, JOB)
    if (url.includes('/status/')) {
      return response(200, statuses[Math.min(index++, statuses.length - 1)])
    }
    if (url.includes('/result/')) return response(200, resultBody)
    return undefined
  }
}

describe('blast_search', () => {
  it('submits once, polls, and returns compact hits with a provenance fingerprint', async () => {
    const body = JSON.stringify(blastDocument)
    const outcome = await execute(
      'blast_search',
      { program: 'blastp', database: 'uniprotkb_swissprot', sequence: SEQ, max_hits: 5 },
      blastHandler(body, ['RUNNING', 'FINISHED'])
    )

    expect(outcome.error).toBeUndefined()
    const out = outcome.value as BlastOut
    // Red line 1: the job-creating POST happens exactly once; the poll loop never replays it.
    expect(outcome.submitted).toBe(1)
    expect(outcome.calls[0].init?.method).toBe('POST')
    expect(outcome.calls.filter((call) => call.url.includes('/status/'))).toHaveLength(2)

    expect(out.job_id).toBe(JOB)
    expect(out.status).toBe('FINISHED')
    expect(out.submitted).toBe(true)
    expect(out.n_hits).toBe(2)
    // The best HSP (highest bit score) is surfaced, not the first one listed.
    expect(out.hits[0]).toMatchObject({ hit_id: 'A', n_hsps: 2, best: { bit_score: 383.3 } })
    expect(out.summary).toMatchObject({ program: 'blastp', query_len: 189, db_num: 1000 })

    // Red line 2: connector id + query params + response fingerprint travel with the result.
    expect(out.provenance.connector).toBe('sequence_tools')
    expect(out.provenance.tool).toBe('blast_search')
    expect(out.provenance.params).toMatchObject({
      program: 'blastp',
      database: 'uniprotkb_swissprot'
    })
    expect(out.provenance.params.sequence_sha256).toBe(sha256(SEQ))
    expect(out.provenance.response_sha256).toBe(digestOf([JOB, 'RUNNING', 'FINISHED', body]))
    expect(out.provenance.jobs).toEqual([{ job_id: JOB, n_http_requests: 4 }])
  })

  it('caps the returned hits without hiding the total', async () => {
    const body = JSON.stringify(blastDocument)
    const outcome = await execute(
      'blast_search',
      { sequence: SEQ, max_hits: 1 },
      blastHandler(body, ['FINISHED'])
    )
    const out = outcome.value as BlastOut
    expect(out.n_hits).toBe(2)
    expect(out.n_hits_returned).toBe(1)
    expect(out.hits_truncated).toBe(true)
    expect(out.hits).toHaveLength(1)
  })

  it('returns the raw document for a non-json result_type', async () => {
    const outcome = await execute(
      'blast_search',
      { sequence: SEQ, result_type: 'tsv' },
      blastHandler('BLASTP 2.16.0+\nA\t100', ['FINISHED'])
    )
    const out = outcome.value as BlastOut
    expect(out.result_type).toBe('tsv')
    expect(out.result).toContain('BLASTP 2.16.0+')
    expect(out.hits).toBeUndefined()
  })

  it('rejects an unknown program before any network call', async () => {
    const outcome = await execute(
      'blast_search',
      { sequence: SEQ, program: 'blastq' },
      () => undefined
    )
    expect(String((outcome.error as Error).message)).toMatch(/unsupported program 'blastq'/)
    expect(outcome.calls).toHaveLength(0)
  })

  it('requires a sequence when no job id is given', async () => {
    const outcome = await execute('blast_search', {}, () => undefined)
    expect(String((outcome.error as Error).message)).toMatch(
      /needs either a 'sequence' to submit or a 'job_id'/
    )
    expect(outcome.calls).toHaveLength(0)
  })
})

describe('blast_search — named failures (red line 5)', () => {
  it('names a rejected submission and never replays it', async () => {
    let attempts = 0
    const outcome = await execute('blast_search', { sequence: SEQ }, () => {
      attempts += 1
      return response(503, 'BLAST is busy')
    })
    expect((outcome.error as { kind?: string }).kind).toBe('remote-rejected')
    expect(String((outcome.error as Error).message)).toMatch(/rejected the submission \(HTTP 503\)/)
    expect(attempts).toBe(1) // one attempt — a retry would create a second job
  })

  it('names a job the remote ran and failed', async () => {
    const outcome = await execute('blast_search', { sequence: SEQ }, blastHandler('', ['ERROR']))
    expect((outcome.error as { kind?: string }).kind).toBe('job-failed')
  })

  it('names an unknown job', async () => {
    const outcome = await execute(
      'blast_search',
      { sequence: SEQ },
      blastHandler('', ['NOT_FOUND'])
    )
    expect((outcome.error as { kind?: string }).kind).toBe('job-not-found')
  })

  it('names a poll timeout and carries the job id to resume with', async () => {
    const outcome = await execute(
      'blast_search',
      { sequence: SEQ, poll_timeout_s: 5, max_bytes: 1_000_000 },
      blastHandler('', ['RUNNING'])
    )
    expect((outcome.error as { kind?: string }).kind).toBe('timeout')
    expect(String((outcome.error as Error).message)).toContain(JOB)
    expect(outcome.submitted).toBe(1)
  })

  it('names an empty result body', async () => {
    const outcome = await execute('blast_search', { sequence: SEQ }, blastHandler('', ['FINISHED']))
    expect((outcome.error as { kind?: string }).kind).toBe('empty-result')
  })

  it('names an oversized result instead of truncating it', async () => {
    const outcome = await execute(
      'blast_search',
      { sequence: SEQ, max_bytes: 1000 },
      blastHandler(`BLASTP ${'x'.repeat(2000)}`, ['FINISHED'])
    )
    expect((outcome.error as { kind?: string }).kind).toBe('response-too-large')
  })

  it('names a result whose shape changed', async () => {
    const outcome = await execute(
      'blast_search',
      { sequence: SEQ },
      blastHandler(JSON.stringify({ program: 'blastp' }), ['FINISHED'])
    )
    expect((outcome.error as { kind?: string }).kind).toBe('contract-changed')
  })
})

describe('clustal_align', () => {
  const FASTA = `>a\n${SEQ}\n>b\n${SEQ.slice(0, -1)}A\n`
  const ALIGNMENT =
    'CLUSTAL O(1.2.4) multiple sequence alignment\n\na      MTEYKL\t60\nb      MTEYKL\t60'

  const clustalHandler = (statuses: string[]) => {
    let index = 0
    return (url: string): Response | undefined => {
      if (url.endsWith('/run')) return response(200, 'clustalo-R1-p1m')
      if (url.includes('/status/')) {
        return response(200, statuses[Math.min(index++, statuses.length - 1)])
      }
      if (url.includes('/result/')) return response(200, ALIGNMENT)
      return undefined
    }
  }

  it('submits once, polls, and returns the alignment with provenance', async () => {
    const outcome = await execute(
      'clustal_align',
      { stype: 'protein', sequence: FASTA },
      clustalHandler(['RUNNING', 'FINISHED'])
    )
    const out = outcome.value as ClustalOut
    expect(outcome.submitted).toBe(1)
    expect(out.result).toContain('CLUSTAL O(1.2.4)')
    expect(out.query).toEqual({ stype: 'protein', n_sequences: 2 })
    expect(out.provenance.connector).toBe('sequence_tools')
    expect(out.provenance.tool).toBe('clustal_align')
    expect(out.provenance.params.sequence_sha256).toBe(sha256(FASTA))
    expect(String(outcome.calls.at(-1)?.url)).toContain('/aln-clustal_num')
  })

  it('refuses a single-sequence input instead of aligning nothing', async () => {
    const outcome = await execute('clustal_align', { sequence: '>a\nMEEP\n' }, () => undefined)
    expect(String((outcome.error as Error).message)).toMatch(/at least two sequences/)
    expect(outcome.calls).toHaveLength(0)
  })

  it('resumes an existing job without submitting a new one', async () => {
    const outcome = await execute(
      'clustal_align',
      { job_id: 'clustalo-EXISTING-p1m' },
      clustalHandler(['FINISHED'])
    )
    const out = outcome.value as ClustalOut
    expect(outcome.submitted).toBe(0)
    expect(out.submitted).toBe(false)
    expect(out.job_id).toBe('clustalo-EXISTING-p1m')
    expect(out.result).toContain('CLUSTAL O')
  })

  it('never replays the submission when the remote rejects it', async () => {
    let attempts = 0
    const outcome = await execute('clustal_align', { sequence: FASTA }, () => {
      attempts += 1
      return response(429, 'too many jobs in flight')
    })
    expect((outcome.error as { kind?: string }).kind).toBe('remote-rejected')
    expect(attempts).toBe(1)
  })
})

describe('interproscan_query is READ-ONLY (red line 4)', () => {
  const IPR_JOB = 'iprscan5-R20260929-180144-0456-66358888-p1m'

  it('exposes no submit path in its schema', () => {
    const descriptor = tool('interproscan_query')
    expect(descriptor.required).toEqual(['job_id'])
    const properties = (descriptor.input as { properties: Record<string, unknown> }).properties
    expect(Object.keys(properties).sort()).toEqual([
      'job_id',
      'max_bytes',
      'poll_timeout_s',
      'result_type'
    ])
    // No sequence/email argument exists, so it cannot even describe a submission.
    expect(properties.sequence).toBeUndefined()
    expect(properties.email).toBeUndefined()
  })

  it('only ever reads /status and /result for a finished job', async () => {
    const outcome = await execute('interproscan_query', { job_id: IPR_JOB }, (url) => {
      if (url.includes('/status/')) return response(200, 'FINISHED')
      if (url.includes('/result/')) return response(200, 'ras\tIPR001806\tSmall GTPase')
      return undefined
    })
    const out = outcome.value as InterproscanOut
    expect(out.finished).toBe(true)
    expect(out.result).toContain('IPR001806')
    // Every request is a read; nothing ever hits the submission endpoint.
    expect(outcome.calls.length).toBeGreaterThan(0)
    for (const call of outcome.calls) {
      expect(call.url).toMatch(/\/(status|result)\//)
      expect(call.url).not.toContain('/run')
      expect(call.init?.method ?? 'GET').toBe('GET')
    }
  })

  it('reports a still-running job instead of failing, and still never submits', async () => {
    const outcome = await execute(
      'interproscan_query',
      { job_id: IPR_JOB, poll_timeout_s: 5 },
      (url) => (url.includes('/status/') ? response(200, 'RUNNING') : undefined)
    )
    const out = outcome.value as InterproscanOut
    expect(outcome.error).toBeUndefined()
    expect(out.finished).toBe(false)
    expect(out.status).toBe('RUNNING')
    expect(out.note).toMatch(/never submits or cancels/)
    expect(outcome.calls.every((call) => !call.url.includes('/run'))).toBe(true)
  })

  it('names an unknown job', async () => {
    const outcome = await execute('interproscan_query', { job_id: 'nope' }, () =>
      response(200, 'NOT_FOUND')
    )
    expect((outcome.error as { kind?: string }).kind).toBe('job-not-found')
  })

  it('requires a job id', async () => {
    const outcome = await execute('interproscan_query', {}, () => undefined)
    expect(String((outcome.error as Error).message)).toMatch(/job_id is required/)
    expect(outcome.calls).toHaveLength(0)
  })
})

// Live self-tests against the real EMBL-EBI Job Dispatcher. Off by default; run with LIVE_API=1.
// A live blastp against PDB and a two-sequence Clustal alignment are cheap; the read-only
// InterProScan check needs an existing job id, so it only runs when LIVE_IPR_JOB_ID is set.
const liveCtx: ToolContext = {
  ...ctx,
  credentials: { ncbiEmail: process.env.LIVE_API_EMAIL ?? 'purescience-live-test@example.com' }
}

describe.skipIf(!process.env.LIVE_API)('sequence_tools / LIVE', () => {
  it('blast_search runs a real blastp job and fingerprints the response', async () => {
    const out = (await tool('blast_search').run!(liveCtx, {
      program: 'blastp',
      database: 'pdb',
      stype: 'protein',
      sequence: SEQ,
      max_hits: 3,
      // blastp against a whole database legitimately exceeds the 60s default on a busy day.
      poll_timeout_s: 240
    })) as BlastOut

    expect(out.status).toBe('FINISHED')
    expect(out.job_id).toMatch(/^ncbiblast-/)
    expect(out.n_hits).toBeGreaterThan(0)
    expect(out.hits.length).toBeLessThanOrEqual(3)
    expect(out.provenance.response_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(out.provenance.connector).toBe('sequence_tools')
  }, 300_000)

  it('clustal_align aligns two real sequences', async () => {
    const out = (await tool('clustal_align').run!(liveCtx, {
      stype: 'protein',
      sequence: `>a\n${SEQ}\n>b\n${SEQ.slice(0, -1)}A\n`
    })) as ClustalOut

    expect(out.status).toBe('FINISHED')
    expect(out.result).toContain('CLUSTAL O')
    expect(out.provenance.response_sha256).toMatch(/^[0-9a-f]{64}$/)
  }, 300_000)
})

describe.skipIf(!process.env.LIVE_API || !process.env.LIVE_IPR_JOB_ID)(
  'interproscan_query / LIVE (read-only)',
  () => {
    it('reads an existing InterProScan job without submitting', async () => {
      const jobId = String(process.env.LIVE_IPR_JOB_ID)
      const out = (await tool('interproscan_query').run!(liveCtx, { job_id: jobId })) as {
        job_id: string
        finished: boolean
        provenance: { connector: string; response_sha256: string }
      }
      expect(out.job_id).toBe(jobId)
      expect(typeof out.finished).toBe('boolean')
      expect(out.provenance.connector).toBe('sequence_tools')
      expect(out.provenance.response_sha256).toMatch(/^[0-9a-f]{64}$/)
    }, 300_000)
  }
)
