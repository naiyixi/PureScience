import { createHash } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  JobTranscript,
  RemoteFailure,
  assertNonEmpty,
  assertWithinByteCap,
  fetchTextRetrying,
  redactUrl,
  sha256Hex,
  submitOnce
} from './job-transport'

const response = (status: number, body: string, link?: string): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: (name: string) => (name.toLowerCase() === 'link' ? (link ?? null) : null) }
  }) as unknown as Response

const install = (impl: (url: string, init?: RequestInit) => Response): ReturnType<typeof vi.fn> => {
  const spy = vi.fn(async (url: string, init?: RequestInit) => impl(String(url), init))
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('submitOnce — a job-creating POST is never replayed', () => {
  it('makes exactly one attempt when the remote answers a transient 503', async () => {
    const spy = install(() => response(503, 'service unavailable'))
    const res = await submitOnce('https://ebi.test/run', { a: '1' })
    // One attempt only: a retry here would create a second job the caller never polls.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(503)
  })

  it('surfaces a network-level drop as a named remote rejection, still without replaying', async () => {
    const spy = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    vi.stubGlobal('fetch', spy)
    await expect(submitOnce('https://ebi.test/run', { a: '1' })).rejects.toMatchObject({
      kind: 'remote-rejected'
    })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('form-encodes the body and sends a POST', async () => {
    let seen: RequestInit | undefined
    install((_url, init) => {
      seen = init
      return response(200, 'job-1')
    })
    await submitOnce('https://ebi.test/run', { email: 'a@b.c', sequence: 'MEEP' })
    expect(seen?.method).toBe('POST')
    expect(new URLSearchParams(String(seen?.body)).get('sequence')).toBe('MEEP')
  })
})

describe('fetchTextRetrying — idempotent reads do retry', () => {
  it('retries a transient 503 and returns the success', async () => {
    let calls = 0
    const spy = install(() => (calls++ === 0 ? response(503, 'busy') : response(200, 'FINISHED')))
    const res = await fetchTextRetrying('https://ebi.test/status/j', {
      retries: 2,
      backoffMs: 0
    })
    expect(res.text).toBe('FINISHED')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('returns the last non-retryable status without throwing', async () => {
    const spy = install(() => response(400, 'bad request'))
    const res = await fetchTextRetrying('https://ebi.test/status/j', { backoffMs: 0 })
    expect(res.ok).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1) // 400 is not retryable
  })

  it('gives up after the configured retries and names the transport failure', async () => {
    const spy = vi.fn(async () => {
      throw new Error('ETIMEDOUT')
    })
    vi.stubGlobal('fetch', spy)
    await expect(
      fetchTextRetrying('https://ebi.test/status/j', { retries: 1, backoffMs: 0 })
    ).rejects.toMatchObject({ kind: 'remote-rejected' })
    expect(spy).toHaveBeenCalledTimes(2) // 1 initial + 1 retry
  })
})

describe('named guard failures', () => {
  it('names an oversized payload instead of truncating it', () => {
    expect(() => assertWithinByteCap('abcdef', 3, 'the result')).toThrowError(
      /is 6 bytes, over the 3-byte cap/
    )
    try {
      assertWithinByteCap('abcdef', 3, 'the result')
    } catch (error) {
      expect((error as RemoteFailure).kind).toBe('response-too-large')
    }
  })

  it('names an empty result body', () => {
    try {
      assertNonEmpty('   \n', 'the result')
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as RemoteFailure).kind).toBe('empty-result')
    }
  })
})

describe('JobTranscript provenance', () => {
  it('fingerprints exactly the recorded response bytes and counts the calls', () => {
    const transcript = new JobTranscript()
    transcript.record('job-1')
    transcript.record('RUNNING')
    transcript.record('{"results":[]}')

    const provenance = transcript.provenance(
      'sequence_tools',
      'blast_search',
      { program: 'blastp' },
      [{ job_id: 'job-1', n_http_requests: 3 }]
    )

    const expected = createHash('sha256')
      .update(['job-1', 'RUNNING', '{"results":[]}'].join('\u0000'), 'utf8')
      .digest('hex')
    expect(provenance.response_sha256).toBe(expected)
    expect(provenance.response_sha256).toBe(sha256Hex('job-1\u0000RUNNING\u0000{"results":[]}'))
    expect(provenance).toMatchObject({
      connector: 'sequence_tools',
      tool: 'blast_search',
      params: { program: 'blastp' },
      n_http_requests: 3,
      jobs: [{ job_id: 'job-1', n_http_requests: 3 }]
    })
    expect(provenance.bytes_received).toBe(5 + 7 + 14)
  })

  it('omits the jobs key when there was no job', () => {
    const provenance = new JobTranscript().provenance('genes', 'map_uniprot_ids', {}, undefined)
    expect('jobs' in provenance).toBe(false)
  })
})

describe('credential redaction', () => {
  it('strips email and api_key from a URL before it can reach a message', () => {
    expect(redactUrl('https://e.test/run?email=a%40b.com&api_key=SECRET&q=1')).toBe(
      'https://e.test/run?q=1'
    )
    // A string that is not a URL is returned untouched rather than silently emptied.
    expect(redactUrl('not a url')).toBe('not a url')
  })

  it('never echoes credentials from a URL in a transport failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET')
      })
    )
    const error = await fetchTextRetrying(
      'https://e.test/status/job?email=someone@example.com&api_key=SECRET',
      { retries: 0, backoffMs: 0 }
    ).catch((caught: unknown) => caught)
    const message = String((error as Error).message)
    expect(message).not.toContain('SECRET')
    expect(message).not.toContain('someone@example.com')
  })
})
