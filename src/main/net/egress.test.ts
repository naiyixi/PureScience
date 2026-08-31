// Tests for the egress allowlist helpers: group resolution, suffix matching, and the filtering
// proxy's allow/deny behavior.

import { request as httpRequest, createServer, type Server } from 'node:http'
import { connect as tcpConnect } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  EGRESS_DOMAIN_GROUPS,
  DEFAULT_EGRESS_SETTINGS,
  isHostAllowed,
  isHostDenied,
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

  it('deny list blocks cloud-metadata exfiltration endpoints unconditionally', () => {
    // The deny list is checked FIRST (deny wins over allow).
    expect(isHostDenied('169.254.169.254')).toBe(true)
    expect(isHostDenied('metadata.google.internal')).toBe(true)
    expect(isHostDenied('169.254.170.2')).toBe(true)
    expect(isHostDenied('100.100.100.200')).toBe(true)
    // Ports are stripped before matching.
    expect(isHostDenied('169.254.169.254:80')).toBe(true)
    // Ordinary scientific hosts are never denied.
    expect(isHostDenied('arxiv.org')).toBe(false)
    expect(isHostDenied('eutils.ncbi.nlm.nih.gov')).toBe(false)
  })
})

describe('EgressProxy', () => {
  let peer: Server
  let proxy: EgressProxy

  beforeEach(async () => {
    peer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('peer-ok')
    })
    await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  })

  afterEach(async () => {
    await proxy?.stop()
    await new Promise<void>((resolve) => peer.close(() => resolve()))
  })

  it('forwards HTTP requests to allowed hosts and 403s denied hosts', async () => {
    proxy = new EgressProxy()
    const peerPort = (peer.address() as { port: number }).port
    // The proxy forwards to the host named in the request's Host header; use the loopback
    // the peer as the "target host" so the tunnel actually connects.
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

    // Allowed host: the proxy forwards to the loopback peer.
    const allowed = await send(`127.0.0.1:${peerPort}`)
    expect(allowed.status).toBe(200)
    expect(allowed.body).toBe('peer-ok')

    // Denied host: proxy answers 403 itself.
    const denied = await send('blocked.test')
    expect(denied.status).toBe(403)
  })

  it('forwards when no allowlist is set (unrestricted default)', async () => {
    proxy = new EgressProxy()
    proxy.setAllowlist(undefined)
    const port = await proxy.start()
    const peerPort = (peer.address() as { port: number }).port

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/probe',
          headers: { host: `127.0.0.1:${peerPort}` }
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        }
      )
      req.on('error', reject)
      req.end()
    })
    // Without an allowlist every host is allowed, so the loopback peer is reachable.
    expect(status).toBe(200)
  })

  it('blocks deny-list hosts even when no allowlist is set (deny wins)', async () => {
    proxy = new EgressProxy()
    proxy.setAllowlist(undefined) // unrestricted, but the built-in deny list still applies
    const port = await proxy.start()

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/probe',
          headers: { host: '169.254.169.254' }
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        }
      )
      req.on('error', reject)
      req.end()
    })
    // The cloud-metadata endpoint is denied unconditionally, even with no allowlist configured.
    expect(status).toBe(403)
  })

  it('blocks deny-list hosts even when allowlisted (deny beats allow)', async () => {
    proxy = new EgressProxy()
    proxy.setAllowlist(['169.254.169.254']) // explicitly allowed, but deny wins
    const port = await proxy.start()

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/probe',
          headers: { host: '169.254.169.254' }
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        }
      )
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
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
