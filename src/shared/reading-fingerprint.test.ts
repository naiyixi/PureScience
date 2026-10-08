// The reading fingerprint, checked against an INDEPENDENT implementation of the published recipe.
//
// The point of the recipe constant is that someone who is not this app can recompute the digest. A test
// that called the same helper the app calls would prove nothing about that, so the recomputation here is
// written out by hand from the recipe's own description — exactly what a third party would write.

import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import {
  CONNECTOR_READING_RESULT_KEY,
  READING_FINGERPRINT_HASH_RECIPE,
  READING_FINGERPRINT_SCHEMA_VERSION,
  attachReadingFingerprints,
  isReadingFingerprint,
  readingsFromConnectorResult,
  verifyConnectorReadingFingerprint,
  type ConnectorReadingFingerprint
} from './reading-fingerprint'

// Independent implementation of the published recipe: sha256 over recipe/method/url/status, each line
// terminated by "\n" including the last, followed by the response body bytes exactly as received.
const recompute = (method: string, url: string, status: number, body: string): string =>
  `sha256:${createHash('sha256')
    .update(`${READING_FINGERPRINT_HASH_RECIPE}\n${method}\n${url}\n${status}\n`)
    .update(new TextEncoder().encode(body))
    .digest('hex')}`

const reading = (
  overrides: Partial<ConnectorReadingFingerprint> = {}
): ConnectorReadingFingerprint => ({
  service: 'pubmed',
  tool: 'search_articles',
  request: { method: 'GET', url: 'https://example.test/esearch?term=aspirin' },
  response: {
    status: 200,
    bytes: 21,
    sha256: recompute('GET', 'https://example.test/esearch?term=aspirin', 200, '{"count":"80708"}')
  },
  ...overrides
})

describe('the published recipe can be recomputed outside the app', () => {
  it('matches a digest written by hand from the recipe description', () => {
    expect(READING_FINGERPRINT_SCHEMA_VERSION).toBe(1)
    const r = reading()
    expect(r.response.sha256).toBe(
      recompute('GET', 'https://example.test/esearch?term=aspirin', 200, '{"count":"80708"}')
    )
    expect(verifyConnectorReadingFingerprint(r, r.response.sha256)).toEqual({
      status: 'verified',
      fingerprint: r.response.sha256
    })
  })

  it('separates the method, the url and the status into the digest', () => {
    const base = recompute('GET', 'https://example.test/a', 200, 'x')
    expect(recompute('POST', 'https://example.test/a', 200, 'x')).not.toBe(base)
    expect(recompute('GET', 'https://example.test/b', 200, 'x')).not.toBe(base)
    expect(recompute('GET', 'https://example.test/a', 404, 'x')).not.toBe(base)
    expect(recompute('GET', 'https://example.test/a', 200, 'y')).not.toBe(base)
  })
})

describe('a missing fingerprint is a named gap, never a pass', () => {
  it('says `not-recorded` when there is no reading at all', () => {
    expect(verifyConnectorReadingFingerprint(undefined, undefined)).toEqual({
      status: 'unavailable',
      reason: 'not-recorded'
    })
  })

  it('says `not-recorded` when nothing was recomputed — an unchecked reading is not a verified one', () => {
    expect(verifyConnectorReadingFingerprint(reading(), undefined)).toEqual({
      status: 'unavailable',
      reason: 'not-recorded'
    })
  })

  it('names a malformed digest instead of comparing against it', () => {
    const broken = reading({ response: { status: 200, bytes: 1, sha256: 'sha256:not-hex' } })
    expect(verifyConnectorReadingFingerprint(broken, broken.response.sha256)).toEqual({
      status: 'unavailable',
      reason: 'malformed-fingerprint'
    })
  })

  it('reports a mismatch together with what the bytes hash to now', () => {
    const r = reading()
    const now = recompute('GET', r.request.url, 200, '{"count":"0"}')
    expect(verifyConnectorReadingFingerprint(r, now)).toEqual({
      status: 'unavailable',
      reason: 'fingerprint-mismatch',
      fingerprintNow: now
    })
  })
})

describe('shape guards refuse a fingerprint that could not be recomputed', () => {
  it('accepts a well-formed reading and rejects a half-formed one', () => {
    expect(isReadingFingerprint(reading())).toBe(true)
    expect(isReadingFingerprint(undefined)).toBe(false)
    expect(isReadingFingerprint({ service: 'pubmed' })).toBe(false)
    // A digest without the prefix is not ours: it could be any hex string.
    expect(
      isReadingFingerprint(
        reading({ response: { status: 200, bytes: 1, sha256: 'ab'.repeat(32) } })
      )
    ).toBe(false)
    // A method outside the two the engine sends is refused rather than assumed to be GET.
    expect(isReadingFingerprint({ ...reading(), request: { method: 'DELETE', url: 'x' } })).toBe(
      false
    )
  })

  it('reads back only the entries that are well-formed', () => {
    expect(
      readingsFromConnectorResult({ [CONNECTOR_READING_RESULT_KEY]: [reading(), { junk: true }] })
    ).toEqual([reading()])
    expect(readingsFromConnectorResult({ [CONNECTOR_READING_RESULT_KEY]: 'nope' })).toEqual([])
    expect(readingsFromConnectorResult(null)).toEqual([])
  })
})

describe('attaching readings to a connector result', () => {
  it('adds the readings to a plain object result', () => {
    const out = attachReadingFingerprints({ total_count: 5 }, [reading()])
    expect(out).toEqual({ total_count: 5, [CONNECTOR_READING_RESULT_KEY]: [reading()] })
  })

  it('leaves a result with no readings untouched — an empty list would read as a check that ran', () => {
    expect(attachReadingFingerprints({ total_count: 5 }, [])).toEqual({ total_count: 5 })
  })

  it('leaves a non-object result untouched rather than wrapping it in an envelope', () => {
    expect(attachReadingFingerprints('text result', [reading()])).toBe('text result')
    expect(attachReadingFingerprints([1, 2], [reading()])).toEqual([1, 2])
    expect(attachReadingFingerprints(null, [reading()])).toBe(null)
  })
})
