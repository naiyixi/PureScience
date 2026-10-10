// Naming outbound failures. The fixtures marked (real log) are the exact `error` strings the packaged
// app recorded over nine days in `~/Library/Logs/PureScience/main*.log` for 'egress tunnel target
// failed' — 200 records in total, with the counts shown next to each string. They are the reason this
// module exists: those records carried a message and a host, but nothing that said what to do, and the
// proxy's plain-HTTP path carried nothing at all.

import { describe, expect, it } from 'vitest'

import {
  EGRESS_FAILURE_FAMILIES,
  describeEgressFailure,
  formatEgressFailure,
  annotateEgressFailure
} from './egress-failure'

describe('describeEgressFailure', () => {
  it('names the family of every failure shape the nine-day log actually contained', () => {
    const observed: { error: string; count: number; family: string }[] = [
      { error: 'This socket has been ended by the other party', count: 125, family: 'reset' },
      { error: 'getaddrinfo ENOTFOUND api.anthropic.com', count: 27, family: 'dns' },
      { error: 'read ECONNRESET', count: 19, family: 'reset' },
      { error: 'read ETIMEDOUT', count: 11, family: 'timeout' },
      { error: 'getaddrinfo ENOTFOUND api.deepseek.com', count: 9, family: 'dns' },
      { error: 'write EPIPE', count: 3, family: 'reset' },
      { error: 'connect ETIMEDOUT 108.160.167.158:443', count: 2, family: 'timeout' },
      { error: 'read EADDRNOTAVAIL', count: 1, family: 'unreachable' },
      { error: 'getaddrinfo ENOTFOUND files.rcsb.org', count: 1, family: 'dns' },
      { error: 'getaddrinfo ENOTFOUND ftp.wwpdb.org', count: 1, family: 'dns' }
    ]

    // 199 of the 200 records are covered by the table above; the remaining 4 (empty strings) are
    // asserted separately below, because "the failure carried no description" is its own answer.
    expect(observed.reduce((total, entry) => total + entry.count, 0)).toBe(199)

    for (const entry of observed) {
      const described = describeEgressFailure(new Error(entry.error))
      expect({ error: entry.error, family: described.family }, `family for ${entry.error}`).toEqual(
        { error: entry.error, family: entry.family }
      )
      expect(described.reason.length).toBeGreaterThan(0)
      expect(described.action.length).toBeGreaterThan(0)
    }
  })

  it('answers an empty failure with a description of its own instead of a silent pass', () => {
    // (real log) 4 records carried an empty `error` string.
    const described = describeEgressFailure(new Error(''))

    expect(described.family).toBe('unknown')
    expect(described.reason).toContain('carried no description')
    expect(formatEgressFailure(described, 'ftp.ncbi.nlm.nih.gov')).toContain('ftp.ncbi.nlm.nih.gov')
  })

  it('walks the cause chain undici builds, so the socket code decides the family', () => {
    // The shape the connector fetch boundary actually sees: TypeError('fetch failed') whose cause is
    // the real socket error.
    const inner = Object.assign(new Error('getaddrinfo ENOTFOUND ftp.ncbi.nlm.nih.gov'), {
      code: 'ENOTFOUND',
      errno: -3008,
      syscall: 'getaddrinfo',
      hostname: 'ftp.ncbi.nlm.nih.gov'
    })
    const fetchFailure = Object.assign(new TypeError('fetch failed'), { cause: inner })

    expect(describeEgressFailure(fetchFailure)).toMatchObject({ family: 'dns', code: 'ENOTFOUND' })
  })

  it('lets the innermost real code win over an outer transport wrapper', () => {
    const inner = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
    const wrapped = Object.assign(new Error('socket error'), {
      code: 'UND_ERR_SOCKET',
      cause: inner
    })

    expect(describeEgressFailure(wrapped)).toMatchObject({ family: 'timeout', code: 'ETIMEDOUT' })
  })

  it('reads a TLS refusal as its own family, not as a network failure', () => {
    // Constructed fixture: the nine-day log contained no certificate failure, which is exactly why
    // this family must not be folded into `unknown` — it would be named wrongly on the day it happens.
    const described = describeEgressFailure(
      Object.assign(new Error('self-signed certificate in certificate chain'), {
        code: 'CERT_HAS_EXPIRED'
      })
    )

    expect(described).toMatchObject({ family: 'tls', code: 'CERT_HAS_EXPIRED' })
  })

  it('treats the proxy’s own allowlist refusal as blocked, never as a network failure', () => {
    // A user can lift an allowlist refusal; a broken DNS cannot. Reading one as the other would send
    // the next person looking at the network.
    const http = new Error(
      'Proxy response (403) !== 200 when HTTP Tunneling PureScience egress allowlist: host not permitted'
    )
    const tunnel = new Error(
      'PureScience egress proxy: egress blocked failure reaching x.test: the outbound allowlist blocked this destination. Ask the user.'
    )

    expect(describeEgressFailure(http).family).toBe('blocked')
    expect(describeEgressFailure(tunnel).family).toBe('blocked')
  })

  it('covers every family it can name with a reason and an action', () => {
    // Guards future additions: a family without a reason would reach the log as a bare token.
    for (const family of EGRESS_FAILURE_FAMILIES) {
      const described = describeEgressFailure(new Error(`unknown failure (${family})`))
      expect(described.reason.length).toBeGreaterThan(0)
      expect(described.action.length).toBeGreaterThan(0)
    }
    expect(EGRESS_FAILURE_FAMILIES).toContain('blocked')
  })

  it('never throws and never copies a non-system code or an unbounded message', () => {
    // A hostile `code` must not become text in a log or an agent-visible message (same rule the
    // logger's diagnosticErrorFields follows).
    const hostile = Object.assign(new Error('x'.repeat(500)), { code: 'rm -rf / ; echo pwned' })

    const described = describeEgressFailure(hostile)

    expect(described.code).toBeNull()
    expect(described.family).toBe('unknown')
    expect(described.reason).not.toContain('pwned')

    const throwing = {
      get code(): string {
        throw new Error('trap')
      },
      get message(): string {
        throw new Error('trap')
      }
    }
    expect(['unknown', ...EGRESS_FAILURE_FAMILIES]).toContain(
      describeEgressFailure(throwing).family
    )
    // Non-error inputs must not explode on the way to a log line.
    for (const input of [null, undefined, 42, 'plain string failure', { code: 429 }]) {
      expect(describeEgressFailure(input).reason.length).toBeGreaterThan(0)
    }
  })

  it('truncates a long description instead of carrying it whole', () => {
    const described = describeEgressFailure(new Error('y'.repeat(400)))

    expect(described.reason.length).toBeLessThan(400)
    expect(described.reason).toContain('…')
  })
})

describe('annotateEgressFailure', () => {
  it('keeps the original message in front and appends the named cause and the target', () => {
    const inner = Object.assign(new Error('getaddrinfo ENOTFOUND files.rcsb.org'), {
      code: 'ENOTFOUND'
    })
    const original = Object.assign(new TypeError('fetch failed'), { cause: inner })

    const annotated = annotateEgressFailure(original, 'https://files.rcsb.org/download/1abc.pdb')

    // Existing matchers (`/fetch failed/`) and the reading-fingerprint path keep working.
    expect(annotated.message).toMatch(/^fetch failed — /)
    expect(annotated.message).toContain(
      'egress dns failure reaching https://files.rcsb.org/download/1abc.pdb'
    )
    expect(annotated.message).toContain('(ENOTFOUND)')
    expect(annotated.cause).toBe(original)
  })

  it('names the family for a plain string rejection too', () => {
    const annotated = annotateEgressFailure('socket hang up', 'https://ftp.wwpdb.org/x')

    expect(annotated.message).toContain('egress reset failure')
    expect(annotated.message).toContain('https://ftp.wwpdb.org/x')
  })
})
