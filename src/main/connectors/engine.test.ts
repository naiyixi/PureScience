import { createHash } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import {
  READING_FINGERPRINT_HASH_RECIPE,
  type ConnectorReadingFingerprint
} from '../../shared/reading-fingerprint'
import { ParserEngine } from './engine'
import type { ToolDescriptor } from './types'

const jsonResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }) as Response

describe('ParserEngine declarative path', () => {
  it('builds the url, fetches json, and runs parse', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ value: 42 }))
    const engine = new ParserEngine({ fetchImpl })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: (a) => `https://example.test/${a.id}`,
      parse: (raw) => (raw as { value: number }).value
    }
    const out = await engine.call(desc, { id: 7 }, {})
    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/7', expect.any(Object))
    expect(out).toBe(42)
  })

  it('throws on missing required args', async () => {
    const engine = new ParserEngine({ fetchImpl: vi.fn() })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      required: ['q'],
      url: () => 'x',
      parse: (r) => r
    }
    await expect(engine.call(desc, {}, {})).rejects.toThrow(/required arg: q/)
  })

  it('retries transient 5xx and gives up after the configured retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response)
    const engine = new ParserEngine({ fetchImpl, retries: 2, retryBackoffMs: 0 })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://x.test',
      parse: (r) => r
    }
    await expect(engine.call(desc, {}, {})).rejects.toThrow(/HTTP 503/)
    expect(fetchImpl).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
  })

  it('retries a transient 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce(jsonResponse({ value: 7 }))
    const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0 })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://x.test',
      parse: (raw) => (raw as { value: number }).value
    }
    expect(await engine.call(desc, {}, {})).toBe(7)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries a transient network error then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse({ value: 5 }))
    const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0 })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://x.test',
      parse: (raw) => (raw as { value: number }).value
    }
    expect(await engine.call(desc, {}, {})).toBe(5)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('fails fast on a timeout abort without retrying (stalled request)', async () => {
    // The fetch never settles, so only the engine's own deadline timer can resolve it.
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}))
    const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0, timeoutMs: 50 })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://x.test',
      parse: (raw) => (raw as { value: number }).value
    }
    // A stalled request must surface the deadline error immediately — the second (would-be
    // retry) fetch must never run.
    await expect(engine.call(desc, {}, {})).rejects.toThrow(/timed out after 50ms/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not retry a client error (4xx other than 429)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400 } as Response)
    const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0 })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://x.test',
      parse: (r) => r
    }
    await expect(engine.call(desc, {}, {})).rejects.toThrow(/HTTP 400/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('postJson sends a POST with a JSON body and parses the response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))
    const engine = new ParserEngine({ fetchImpl })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      run: async (ctx) => ctx.postJson('https://gql.test/api', { query: 'q', variables: { a: 1 } })
    }
    const out = await engine.call(desc, {}, {})
    const init = fetchImpl.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ query: 'q', variables: { a: 1 } })
    expect(out).toEqual({ data: { ok: true } })
  })

  it('sends a User-Agent header (some APIs 403 without one)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: 1 }))
    const engine = new ParserEngine({ fetchImpl })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://example.test',
      parse: (r) => r
    }
    await engine.call(desc, {}, {})
    const headers = (fetchImpl.mock.calls[0][1] as { headers: Record<string, string> }).headers
    expect(headers['user-agent']).toMatch(/PureScience/)
  })

  it('redacts credentials from the URL in error messages', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response)
    const engine = new ParserEngine({ fetchImpl })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://eutils.ncbi.nlm.nih.gov/entrez?email=a@b.com&api_key=SECRET',
      parse: (r) => r
    }
    let message = ''
    try {
      await engine.call(desc, {}, {})
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toContain('SECRET')
    expect(message).toContain('HTTP 401')
  })
})

describe('ParserEngine records a fingerprint of every reading it takes', () => {
  // Independent implementation of the published recipe (see shared/reading-fingerprint.ts): sha256 over
  // recipe/method/url/status, each line terminated by "\n" including the last, then the body bytes.
  const recompute = (method: string, url: string, status: number, body: string): string =>
    `sha256:${createHash('sha256')
      .update(`${READING_FINGERPRINT_HASH_RECIPE}\n${method}\n${url}\n${status}\n`)
      .update(new TextEncoder().encode(body))
      .digest('hex')}`

  // A transport that can hand back the body bytes, which is what a real fetch does.
  const byteResponse = (body: string, status = 200): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode(body).buffer
    }) as Response

  it('records the reading for a url()+parse() descriptor, with a recomputable digest', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(byteResponse('{"value":42}'))
    const engine = new ParserEngine({ fetchImpl })
    const readings: ConnectorReadingFingerprint[] = []
    const desc: ToolDescriptor = {
      id: 'search_articles',
      connector: 'pubmed',
      description: '',
      input: {},
      url: () => 'https://example.test/esearch?term=aspirin',
      parse: (raw) => (raw as { value: number }).value
    }

    const out = await engine.call(desc, {}, {}, (r) => readings.push(r))

    expect(out).toBe(42)
    expect(readings).toEqual([
      {
        service: 'pubmed',
        tool: 'search_articles',
        request: {
          method: 'GET',
          url: 'https://example.test/esearch?term=aspirin',
          // Recorded even when empty: "checked, nothing removed" must not read the same as "this record
          // predates the field" (which is what a re-issuer has to refuse on).
          credentials_stripped: [],
          accept: 'application/json'
        },
        response: {
          status: 200,
          bytes: 12,
          sha256: recompute('GET', 'https://example.test/esearch?term=aspirin', 200, '{"value":42}')
        }
      }
    ])
  })

  it('records for a run() descriptor too — the path most connectors actually take', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(byteResponse('{"count":"1"}'))
    const engine = new ParserEngine({ fetchImpl })
    const readings: ConnectorReadingFingerprint[] = []
    const desc: ToolDescriptor = {
      id: 'run_style',
      connector: 'demo',
      description: '',
      input: {},
      // No url()/parse(): this is how every modern descriptor is written, and a fingerprint bolted onto
      // the url()/parse() branch alone would miss it entirely.
      run: async (ctx) => (await ctx.fetchJson('https://example.test/run')) as { count: string }
    }

    const out = await engine.call(desc, {}, {}, (r) => readings.push(r))

    expect(out).toEqual({ count: '1' })
    expect(readings).toHaveLength(1)
    expect(readings[0]).toMatchObject({
      service: 'demo',
      tool: 'run_style',
      request: { method: 'GET', url: 'https://example.test/run' },
      response: { status: 200, bytes: 13 }
    })
    expect(readings[0].response.sha256).toBe(
      recompute('GET', 'https://example.test/run', 200, '{"count":"1"}')
    )
  })

  it('records a POST with its method, so the digest cannot be replayed as a GET', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(byteResponse('{"ok":true}'))
    const engine = new ParserEngine({ fetchImpl })
    const readings: ConnectorReadingFingerprint[] = []
    const desc: ToolDescriptor = {
      id: 'post_style',
      connector: 'demo',
      description: '',
      input: {},
      run: async (ctx) => ctx.postJson('https://example.test/graphql', { query: '{ x }' })
    }

    await engine.call(desc, {}, {}, (r) => readings.push(r))

    expect(readings[0].request).toEqual({
      method: 'POST',
      url: 'https://example.test/graphql',
      credentials_stripped: [],
      accept: 'application/json'
    })
    expect(readings[0].response.sha256).toBe(
      recompute('POST', 'https://example.test/graphql', 200, '{"ok":true}')
    )
  })

  it('redacts credentials before they can reach a recorded fingerprint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(byteResponse('{}'))
    const engine = new ParserEngine({ fetchImpl })
    const readings: ConnectorReadingFingerprint[] = []
    const desc: ToolDescriptor = {
      id: 'etiquette',
      connector: 'pubmed',
      description: '',
      input: {},
      url: () => 'https://eutils.ncbi.nlm.nih.gov/entrez?email=a@b.com&api_key=SECRET&term=x',
      parse: (r) => r
    }

    await engine.call(desc, {}, {}, (r) => readings.push(r))

    expect(readings[0].request.url).not.toContain('SECRET')
    expect(readings[0].request.url).not.toContain('a%40b.com')
    // The NAMES that were removed are recorded — never the values. Without them a verifier cannot tell
    // that the recorded URL is not the request that was sent, and would re-issue the remainder and call
    // the answer a reproduction.
    expect(readings[0].request.credentials_stripped).toEqual(['email', 'api_key'])
    expect(readings[0].response.sha256).toBe(recompute('GET', readings[0].request.url, 200, '{}'))
  })

  it('records nothing when the transport cannot hand back the body, rather than hashing a re-serialisation', async () => {
    // A double that only implements json(): there are no received bytes to fingerprint, and a digest of
    // JSON.stringify(parsed) would not reproduce against what the service sent.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ value: 1 })
    } as unknown as Response)
    const engine = new ParserEngine({ fetchImpl })
    const readings: ConnectorReadingFingerprint[] = []
    const desc: ToolDescriptor = {
      id: 'json_only',
      connector: 'demo',
      description: '',
      input: {},
      url: () => 'https://example.test/x',
      parse: (raw) => raw
    }

    const out = await engine.call(desc, {}, {}, (r) => readings.push(r))

    expect(out).toEqual({ value: 1 })
    expect(readings).toEqual([])
  })

  it('records nothing when no collector is passed — callers that do not ask pay nothing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(byteResponse('{"value":42}'))
    const engine = new ParserEngine({ fetchImpl })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://example.test/x',
      parse: (raw) => (raw as { value: number }).value
    }
    await expect(engine.call(desc, {}, {})).resolves.toBe(42)
  })
})
