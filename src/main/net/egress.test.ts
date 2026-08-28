// Tests for the egress allowlist helpers: group resolution, suffix matching, and the filtering
// proxy's allow/deny behavior.

import { request as httpRequest, createServer, type Server } from 'node:http'
import { connect as tcpConnect } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  EGRESS_DOMAIN_GROUPS,
  DEFAULT_EGRESS_SETTINGS,
  isHostAllowed,
  resolveEgressAllowlist
} from '../../shared/egress'
import { EgressProxy } from './egress-proxy'

describe('egress allowlist helpers', () => {
  it('exposes 6 scientific domain groups', () => {
    expect(EGRESS_DOMAIN_GROUPS).toHaveLength(6)
    expect(EGRESS_DOMAIN_GROUPS.map((group) => group.id)).toEqual([
      'literature',
      'genomics',
      'structures',
      'clinical',
      'bioinformatics',
      'repositories'
    ])
  })

  it('returns undefined when egress is disabled', () => {
    expect(resolveEgressAllowlist(undefined)).toBeUndefined()
    expect(resolveEgressAllowlist(DEFAULT_EGRESS_SETTINGS)).toBeUndefined()
  })

  it('resolves all enabled groups plus custom domains', () => {
    const allowlist = resolveEgressAllowlist({
      enabled: true,
      groups: {},
      customDomains: ['lab.example.com', 'https://data.example.org/path']
    })
    expect(allowlist).toBeDefined()
    expect(allowlist).toContain('arxiv.org')
    expect(allowlist).toContain('lab.example.com')
    // Protocol/path stripped, lowercased.
    expect(allowlist).toContain('data.example.org')
  })

  it('excludes disabled groups', () => {
    const allowlist = resolveEgressAllowlist({
      enabled: true,
      groups: { repositories: false },
      customDomains: []
    })
    expect(allowlist).not.toContain('github.com')
    expect(allowlist).toContain('arxiv.org')
  })

  it('matches hosts by exact or subdomain suffix', () => {
    const allowlist = ['arxiv.org', 'ncbi.nlm.nih.gov']
    expect(isHostAllowed('arxiv.org', allowlist)).toBe(true)
    expect(isHostAllowed('export.arxiv.org', allowlist)).toBe(true)
    expect(isHostAllowed('eutils.ncbi.nlm.nih.gov', allowlist)).toBe(true)
    expect(isHostAllowed('arxiv.org.evil.com', allowlist)).toBe(false)
    expect(isHostAllowed('other.org', allowlist)).toBe(false)
    // Ports are stripped.
    expect(isHostAllowed('arxiv.org:443', allowlist)).toBe(true)
  })
})

describe('EgressProxy', () => {
  let upstream: Server
  let proxy: EgressProxy

  beforeEach(async () => {
    upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('upstream-ok')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  })

  afterEach(async () => {
    await proxy?.stop()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  it('forwards HTTP requests to allowed hosts and 403s denied hosts', async () => {
    proxy = new EgressProxy()
    const upstreamPort = (upstream.address() as { port: number }).port
    // The proxy forwards to the host named in the request's Host header; use the loopback
    // upstream as the "target host" so the tunnel actually connects.
    proxy.setAllowlist(['127.0.0.1'])
    const port = await proxy.start()

    const send = (targetHost: string): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          { hostname: '127.0.0.1', port, path: '/probe', headers: { host: targetHost } },
          (res) => {
            let body = ''
            res.on('data', (chunk) => (body += chunk.toString()))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
          }
        )
        req.on('error', reject)
        req.end()
      })

    // Allowed host: the proxy forwards to the loopback upstream.
    const allowed = await send(`127.0.0.1:${upstreamPort}`)
    expect(allowed.status).toBe(200)
    expect(allowed.body).toBe('upstream-ok')

    // Denied host: proxy answers 403 itself.
    const denied = await send('blocked.test')
    expect(denied.status).toBe(403)
  })

  it('forwards when no allowlist is set (unrestricted default)', async () => {
    proxy = new EgressProxy()
    proxy.setAllowlist(undefined)
    const port = await proxy.start()
    const upstreamPort = (upstream.address() as { port: number }).port

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/probe',
          headers: { host: `127.0.0.1:${upstreamPort}` }
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        }
      )
      req.on('error', reject)
      req.end()
    })
    // Without an allowlist every host is allowed, so the loopback upstream is reachable.
    expect(status).toBe(200)
  })

  it('rejects CONNECT tunnels for denied hosts', async () => {
    proxy = new EgressProxy()
    proxy.setAllowlist(['tunnel.test'])
    const port = await proxy.start()

    // Denied CONNECT target: connection is closed, no 200 Established.
    const result = await new Promise<{ ok: boolean; status?: string }>((resolve) => {
      const socket = tcpConnect({ host: '127.0.0.1', port })
      socket.on('connect', () => {
        socket.write('CONNECT blocked.test:443 HTTP/1.1\r\nHost: blocked.test:443\r\n\r\n')
      })
      let data = ''
      socket.on('data', (chunk) => {
        data += chunk.toString()
      })
      socket.on('close', () =>
        resolve({ ok: data.includes('200 Connection Established'), status: data.slice(0, 40) })
      )
      socket.on('error', () => resolve({ ok: false }))
    })
    expect(result.ok).toBe(false)
  })
})
