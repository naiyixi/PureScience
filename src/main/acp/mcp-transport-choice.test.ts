import { describe, expect, it } from 'vitest'

import { resolveMcpTransport } from './mcp-transport-choice'

describe('resolveMcpTransport', () => {
  it('uses the http host for a framework that accepts http, even when it also speaks stdio', () => {
    // The whole point: a framework that can do both must not be given 14 children.
    expect(
      resolveMcpTransport({ acceptsStdioMcp: true, acceptsHttpMcp: true, httpHostAvailable: true })
    ).toBe('http')
  })

  it('keeps stdio for a framework that has not been verified over http', () => {
    expect(
      resolveMcpTransport({ acceptsStdioMcp: true, acceptsHttpMcp: false, httpHostAvailable: true })
    ).toBe('stdio')
    // Undefined means "only if stdio is impossible" — the historical rule, unchanged.
    expect(resolveMcpTransport({ acceptsStdioMcp: true, httpHostAvailable: true })).toBe('stdio')
  })

  it('falls back to stdio when http is accepted but there is no host to serve from', () => {
    expect(
      resolveMcpTransport({ acceptsStdioMcp: true, acceptsHttpMcp: true, httpHostAvailable: false })
    ).toBe('stdio')
  })

  it('uses http for a framework that cannot take stdio at all', () => {
    expect(resolveMcpTransport({ acceptsStdioMcp: false, httpHostAvailable: true })).toBe('http')
    expect(
      resolveMcpTransport({ acceptsStdioMcp: false, acceptsHttpMcp: true, httpHostAvailable: true })
    ).toBe('http')
  })

  it('reports none when no transport is available', () => {
    expect(resolveMcpTransport({ acceptsStdioMcp: false, httpHostAvailable: false })).toBe('none')
    expect(
      resolveMcpTransport({
        acceptsStdioMcp: false,
        acceptsHttpMcp: false,
        httpHostAvailable: true
      })
    ).toBe('none')
  })
})
