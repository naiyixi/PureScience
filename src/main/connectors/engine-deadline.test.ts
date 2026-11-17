import { describe, it, expect, vi } from 'vitest'

import type { ConnectorReadingFingerprint } from '../../shared/reading-fingerprint'
import { ParserEngine } from './engine'
import type { ToolDescriptor } from './types'

// One budget per request — and it covers the BODY, not just the handshake.
//
// The defect this pins: the deadline used to be cleared as soon as `fetch` resolved, so a source that
// answered with headers and then stopped sending bytes had no deadline at all. The comment above the
// timer promised the opposite ("a stalled request must fail fast ... never hang"), which is why nobody
// looked for it. Both halves are asserted by name, because they send the reader down different next
// steps: a slow source never answered the handshake, a stalled one answered and then went quiet.
const warn = vi.hoisted(() => vi.fn())
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() })
}))

const descriptor = (over: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  id: 'stalled',
  connector: 'demo',
  description: '',
  input: {},
  url: () => 'https://source.test/records/1',
  parse: (raw) => raw,
  ...over
})

describe('connector call deadline', () => {
  it('fails a body that stalls after the headers, instead of hanging with no deadline at all', async () => {
    // Headers arrive; the body never does. Only the engine's own deadline can end this call.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => new Promise<ArrayBuffer>(() => {})
    } as unknown as Response)
    const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0, timeoutMs: 40 })

    await expect(engine.call(descriptor(), {}, {})).rejects.toThrow(
      /timed out after 40ms.*response body/s
    )
    // Not retried: a deadline is a fact about this request, not a transient blip.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('names the headers phase when the handshake itself never answers', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}))
    const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0, timeoutMs: 40 })

    await expect(engine.call(descriptor(), {}, {})).rejects.toThrow(
      /timed out after 40ms.*response headers/s
    )
  })

  it('leaves one named log line per deadline, so a reading can count these calls', async () => {
    warn.mockClear()
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => new Promise<ArrayBuffer>(() => {})
    } as unknown as Response)
    const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0, timeoutMs: 30 })

    await expect(engine.call(descriptor(), {}, {})).rejects.toThrow(/timed out/)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('connector call deadline reached', {
      connector: 'demo',
      tool: 'stalled',
      host: 'source.test',
      phase: 'body',
      budgetMs: 30
    })
  })

  it('keeps a non-deadline body failure loud and attributable', async () => {
    // The transport drops mid-body for its own reason: that must not be reported as a timeout, and it
    // must still carry the egress cause rather than a bare `terminated`.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.reject(new Error('terminated'))
    } as unknown as Response)
    const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0, timeoutMs: 5_000 })

    const failure = await engine.call(descriptor(), {}, {}).catch((err: Error) => err)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('terminated')
    expect((failure as Error).message).not.toContain('timed out after')
  })

  it('still records a reading for a body that arrives — the armed deadline changes nothing', async () => {
    const body = '{"value":42}'
    const bytes = new TextEncoder().encode(body)
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer
    } as unknown as Response)
    const engine = new ParserEngine({ fetchImpl, timeoutMs: 5_000 })
    const readings: ConnectorReadingFingerprint[] = []

    const out = await engine.call(
      descriptor({ parse: (raw) => (raw as { value: number }).value }),
      {},
      {},
      (reading) => readings.push(reading)
    )

    expect(out).toBe(42)
    expect(readings).toHaveLength(1)
    expect(readings[0].response.bytes).toBe(bytes.byteLength)
  })
})
