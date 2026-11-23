import { describe, expect, it } from 'vitest'

import { describeUpdateFailureReason } from './failure-reason'

// Each row is a shape an update failure actually takes in the field: electron-updater reports Chromium
// `net::ERR_*` tokens, node reports E-codes (often one wrapper down in `cause`), and an HTTP answer
// carries a status on the error or on its `response`. The dialog has one sentence per reason, so a row
// that lands on `unknown` means the reader gets the raw internal message — that is why every real shape
// has a row here rather than only the two the tests happened to hit first.
describe('describeUpdateFailureReason', () => {
  const cases: Array<[string, unknown, string]> = [
    ['a name that did not resolve', new Error('net::ERR_NAME_NOT_RESOLVED'), 'dns'],
    ['a resolved-failed variant', new Error('Error: net::ERR_NAME_RESOLUTION_FAILED'), 'dns'],
    ['a machine that is offline', new Error('net::ERR_INTERNET_DISCONNECTED'), 'offline'],
    [
      'a network that changed mid-request',
      new Error('net::ERR_NETWORK_CHANGED'),
      'network-changed'
    ],
    ['a refused connection', new Error('net::ERR_CONNECTION_REFUSED'), 'refused'],
    ['a reset connection', new Error('net::ERR_CONNECTION_RESET'), 'reset'],
    ['a closed connection', new Error('net::ERR_CONNECTION_CLOSED'), 'reset'],
    ['a timeout', new Error('net::ERR_TIMED_OUT'), 'timeout'],
    ['a bad certificate', new Error('net::ERR_CERT_DATE_INVALID'), 'tls'],
    ['an SSL failure', new Error('net::ERR_SSL_PROTOCOL_ERROR'), 'tls'],
    // node-shaped failures reach the same vocabulary through the egress classifier.
    ['a socket reset read', new Error('read ECONNRESET'), 'reset'],
    ['an E-code', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), 'timeout'],
    [
      'a DNS E-code',
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
      'dns'
    ],
    [
      'an error one wrapper down',
      new Error('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }),
      'dns'
    ],
    ['an HTTP status on the error', Object.assign(new Error('404'), { statusCode: 404 }), 'http'],
    [
      'an HTTP status on the response',
      Object.assign(new Error('bad answer'), { response: { status: 503 } }),
      'http'
    ],
    ['an AbortError', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'timeout'],
    ['a plain failure', new Error('something else entirely'), 'unknown'],
    ['a string rejection', 'net::ERR_NAME_NOT_RESOLVED', 'dns'],
    ['no error at all', undefined, 'unknown'],
    ['null', null, 'unknown']
  ]

  for (const [label, error, expected] of cases) {
    it(`names ${label}`, () => {
      expect(describeUpdateFailureReason(error)).toBe(expected)
    })
  }

  it('never throws on an error whose fields throw when read', () => {
    const hostile = Object.defineProperty({}, 'message', {
      get() {
        throw new Error('nope')
      }
    })
    const hostileCause = Object.defineProperty({}, 'cause', {
      get() {
        throw new Error('nope')
      }
    })
    expect(describeUpdateFailureReason(hostile)).toBe('unknown')
    expect(describeUpdateFailureReason(hostileCause)).toBe('unknown')
  })

  it('stops on a self-referencing error instead of walking forever', () => {
    const loop = new Error('loops') as Error & { cause?: unknown }
    loop.cause = loop
    expect(describeUpdateFailureReason(loop)).toBe('unknown')
  })

  it('reads a token that sits past the start of a long message', () => {
    const message = `${'context '.repeat(10)}net::ERR_CONNECTION_RESET`
    expect(describeUpdateFailureReason(new Error(message))).toBe('reset')
  })
})
