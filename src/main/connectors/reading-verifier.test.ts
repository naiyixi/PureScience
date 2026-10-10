import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  READING_FINGERPRINT_PREFIX,
  readingDigestInput,
  type ConnectorReadingFingerprint
} from '../../shared/reading-fingerprint'
import { verifyRecordedReading, type ReadingVerifierDeps } from './reading-verifier'

const URL_UNDER_TEST = 'https://example.test/esearch?term=aspirin'

const digestOf = (url: string, status: number, body: string): string =>
  `${READING_FINGERPRINT_PREFIX}${createHash('sha256')
    .update(readingDigestInput('GET', url, status))
    .update(Buffer.from(body, 'utf8'))
    .digest('hex')}`

/** A reading as the engine records one: verifiable unless a case says otherwise. */
const reading = (overrides?: {
  body?: string
  request?: Partial<ConnectorReadingFingerprint['request']>
  status?: number
}): ConnectorReadingFingerprint => {
  const body = overrides?.body ?? '{"count":"1"}'
  const status = overrides?.status ?? 200
  return {
    service: 'pubmed',
    tool: 'search_articles',
    request: {
      method: 'GET',
      url: URL_UNDER_TEST,
      credentials_stripped: [],
      accept: 'application/json',
      ...overrides?.request
    },
    response: {
      status,
      bytes: Buffer.byteLength(body, 'utf8'),
      sha256: digestOf(URL_UNDER_TEST, status, body)
    }
  }
}

const byteResponse = (body: string, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer
  }) as unknown as Response

const deps = (fetchImpl: typeof fetch): ReadingVerifierDeps => ({
  hasService: (service: string) => service === 'pubmed',
  fetchImpl
})

describe('verifyRecordedReading', () => {
  it('matches when the same URL returns the same bytes, and carries both digests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(byteResponse('{"count":"1"}'))

    const verdict = await verifyRecordedReading(reading(), deps(fetchImpl))

    expect(verdict).toEqual({
      state: 'matched',
      recorded: digestOf(URL_UNDER_TEST, 200, '{"count":"1"}'),
      recomputed: digestOf(URL_UNDER_TEST, 200, '{"count":"1"}'),
      status: 200
    })
    // The re-issue is the same request: the recorded Accept is sent, not a fresh choice.
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      headers: { accept: 'application/json' }
    })
  })

  it('reports a mismatch — with both digests — rather than a pass when the bytes differ', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(byteResponse('{"count":"2"}'))

    const verdict = await verifyRecordedReading(reading(), deps(fetchImpl))

    expect(verdict.state).toBe('mismatch')
    if (verdict.state !== 'mismatch') return
    expect(verdict.recorded).toBe(digestOf(URL_UNDER_TEST, 200, '{"count":"1"}'))
    expect(verdict.recomputed).toBe(digestOf(URL_UNDER_TEST, 200, '{"count":"2"}'))
    expect(verdict.recomputed).not.toBe(verdict.recorded)
  })

  it('names a changed status rather than leaving the difference to the digests alone', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(byteResponse('{"count":"1"}', 503))

    const verdict = await verifyRecordedReading(reading(), deps(fetchImpl))

    expect(verdict).toMatchObject({ state: 'mismatch', status: 503 })
  })

  it('refuses a re-issue that is not a read, without issuing it', async () => {
    const fetchImpl = vi.fn()
    const verdict = await verifyRecordedReading(
      reading({ request: { method: 'POST' } }),
      deps(fetchImpl as unknown as typeof fetch)
    )

    expect(verdict).toEqual({ state: 'unavailable', reason: 'not-a-read' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses when the recorded URL had credentials stripped — the remainder is not the request', async () => {
    const fetchImpl = vi.fn()
    const verdict = await verifyRecordedReading(
      reading({ request: { credentials_stripped: ['email', 'api_key'] } }),
      deps(fetchImpl as unknown as typeof fetch)
    )

    expect(verdict).toEqual({ state: 'unavailable', reason: 'credentials-stripped' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a record that predates the fields a faithful re-issue needs', async () => {
    const fetchImpl = vi.fn()
    const base = reading()
    const { accept: _accept, ...withoutAccept } = base.request

    const verdict = await verifyRecordedReading(
      { ...base, request: withoutAccept as ConnectorReadingFingerprint['request'] },
      deps(fetchImpl as unknown as typeof fetch)
    )

    expect(verdict).toEqual({ state: 'unavailable', reason: 'not-recorded' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a service this process cannot re-issue for, naming it as unknown', async () => {
    const fetchImpl = vi.fn()
    const verdict = await verifyRecordedReading(
      { ...reading(), service: 'not-a-connector' },
      deps(fetchImpl as unknown as typeof fetch)
    )

    expect(verdict).toEqual({ state: 'unavailable', reason: 'service-unknown' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a failed re-issue instead of a match, for a transport with no byte view', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 } as unknown as Response)

    const verdict = await verifyRecordedReading(reading(), deps(fetchImpl))

    expect(verdict).toEqual({ state: 'unavailable', reason: 'request-failed' })
  })

  it('reports a thrown transport error as a failed re-issue, never as a mismatch', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))

    const verdict = await verifyRecordedReading(reading(), deps(fetchImpl))

    expect(verdict).toEqual({ state: 'unavailable', reason: 'request-failed' })
  })
})
