// Tests for the egress allowlist helpers: group resolution, suffix matching, and the filtering
// proxy's allow/deny behavior.

import { request as httpRequest, createServer, type Server } from 'node:http'
import { connect as tcpConnect, createServer as createTcpServer } from 'node:net'
import { Duplex } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mirrorEgressHosts } from '../../shared/egress'

import {
  EGRESS_ALWAYS_ALLOWED_HOSTS,
  EGRESS_DOMAIN_GROUPS,
  EGRESS_PROVIDER_ENDPOINT_HOSTS,
  DEFAULT_EGRESS_SETTINGS,
  isHostAllowed,
  isHostDenied,
  resolveEgressAllowlist
} from '../../shared/egress'
import { EgressProxy } from './egress-proxy'
import {
  allowImplicitEgressHost,
  applyEgressSettings,
  applyEgressToChildEnv,
  egressProxyEnv,
  implicitEgressHostsForTest,
  normalizeImplicitHost,
  resetEgressRuntimeForTest
} from './egress-runtime'

// Waits for a socket event that may already have happened, without a wall-clock budget that load can
// eat. A 20 ms poll loop racing its own 2 s deadline reads a teardown that *did* run as `timeout`
// whenever the poll's timers are starved (six CPU burners on this machine reproduced it 1 run in 3),
// so these waits are driven by the event itself and the bound only catches a genuine leak.
const armedSignal = (): { promise: Promise<void>; fire: () => void } => {
  let fire: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    fire = () => resolve()
  })
  return { promise, fire }
}

// What the tunnel socket itself saw, so "the proxy never noticed the client leave" stops being
// indistinguishable from "the proxy noticed and leaked the target". The real-machine reason this
// matters: an unobservable ending is a platform event, not a teardown bug (see the reset pin below).
const watchTunnelEnding = (proxy: EgressProxy): { seen: string[] } => {
  const watched: { seen: string[] } = { seen: [] }
  const target = proxy as unknown as {
    handleConnect(req: { url?: string }, socket: Duplex, head: Buffer): void
  }
  const original = target.handleConnect.bind(proxy)
  target.handleConnect = (req, socket, head) => {
    socket.on('error', () => watched.seen.push('error'))
    socket.on('close', () => watched.seen.push('close'))
    socket.on('end', () => watched.seen.push('end'))
    original(req, socket, head)
  }
  return watched
}

const settledWithin = async (
  settled: Promise<void>,
  boundMs = 10_000
): Promise<'settled' | 'timeout'> =>
  Promise.race([
    settled.then(() => 'settled' as const),
    new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), boundMs)
      timer.unref?.()
    })
  ])

// P3-9 / 3.5: a mirror the user configured is configuration, not an unknown host. With egress on,
// installs through their own mirror were refused (or prompted for) as if it were anything else,
// because only the public package hosts were on the allowlist.
describe('package mirror egress hosts', () => {
  it('authorizes the host of each configured mirror URL', () => {
    expect(
      mirrorEgressHosts({
        pypiIndex: 'https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple',
        cranMirror: 'https://mirrors.ustc.edu.cn/CRAN/',
        condaChannel: 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/'
      })
    ).toEqual(['mirrors.tuna.tsinghua.edu.cn', 'mirrors.ustc.edu.cn'])
  })

  it('reads the host out of the URL, never the whole string or a path', () => {
    const hosts = mirrorEgressHosts({ pypiIndex: 'https://pypi.example.org/simple' })

    expect(hosts).toEqual(['pypi.example.org'])
    expect(hosts.join(' ')).not.toContain('/simple')
  })

  // A bare conda channel name is not a host, and a local CA bundle is not a destination: neither
  // should widen the allowlist.
  it('ignores entries that are not URLs, and the CA bundle', () => {
    expect(
      mirrorEgressHosts({
        condaChannel: 'conda-forge',
        caBundle: '/etc/ssl/certs/ca.pem',
        pypiIndex: 'not a url'
      })
    ).toEqual([])
    expect(mirrorEgressHosts(undefined)).toEqual([])
  })

  it('adds them to the resolved allowlist only when egress is actually on', () => {
    const settings = { enabled: true, groups: {}, customDomains: [] }
    const hosts = ['mirrors.tuna.tsinghua.edu.cn']

    expect(resolveEgressAllowlist(settings, hosts)).toContain('mirrors.tuna.tsinghua.edu.cn')
    expect(resolveEgressAllowlist({ ...settings, enabled: false }, hosts)).toBeUndefined()
  })
})

describe('egress allowlist helpers', () => {
  it('never gates the local machine', () => {
    const allowlist = resolveEgressAllowlist({ enabled: true, groups: {}, customDomains: [] }) ?? []
    for (const host of EGRESS_ALWAYS_ALLOWED_HOSTS) {
      expect(isHostAllowed(host, allowlist)).toBe(true)
    }
    // Loopback is not egress: gating it would break local tooling while protecting nothing.
    expect(allowlist).toContain('localhost')
    expect(allowlist).toContain('127.0.0.1')
  })

  it('leaves the model provider endpoints open, and still gates everything else', () => {
    const allowlist = resolveEgressAllowlist({ enabled: true, groups: {}, customDomains: [] }) ?? []

    // Suspending these cost a 60s stall per request before the denial, observed live: the agent CLI
    // contacts its vendor's canonical host even when a custom base URL is configured.
    for (const host of EGRESS_PROVIDER_ENDPOINT_HOSTS) {
      expect(isHostAllowed(host, allowlist)).toBe(true)
    }
    expect(isHostAllowed('example.com', allowlist)).toBe(false)
    expect(isHostAllowed('api.evil.example', allowlist)).toBe(false)
  })

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

  // A loopback port with nothing listening: binding and closing a server yields a port that is free
  // (so a real connection to it is refused, not blocked by a firewall) for the lifetime of the test.
  const closedLoopbackPort = async (): Promise<number> => {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    return port
  }

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

  // A target the proxy cannot reach used to end as a bare `socket.destroy()` on the tunnel and as a
  // generic "target unreachable" 403 on the plain-HTTP path — with the error discarded, so neither the
  // client nor the log could say why. Both now answer with the named family.
  it('names the reason a tunnel target failed instead of dropping the tunnel silently', async () => {
    proxy = new EgressProxy()
    proxy.setAllowlist(['127.0.0.1'])
    const port = await proxy.start()
    // A port with nothing behind it: the loopback peer that was closed in this test is exactly the
    // real "connection refused" the log recorded (`read ECONNRESET` / refused targets).
    const deadPort = await closedLoopbackPort()

    const response = await new Promise<string>((resolve) => {
      const socket = tcpConnect({ host: '127.0.0.1', port })
      socket.on('connect', () => {
        socket.write(
          `CONNECT 127.0.0.1:${deadPort} HTTP/1.1\r\nHost: 127.0.0.1:${deadPort}\r\n\r\n`
        )
      })
      let data = ''
      socket.on('data', (chunk) => {
        data += chunk.toString()
      })
      socket.on('close', () => resolve(data))
      socket.on('error', () => resolve(data))
    })

    expect(response).toContain('502 Bad Gateway')
    expect(response).toContain('egress refused failure reaching 127.0.0.1')
    expect(response).toContain('ECONNREFUSED')
  })

  // An *established* tunnel whose client disappears mid-request. Two defects came out of the shipped
  // build's log here:
  //   1. nothing on our side listened for the tunnel socket's errors, so a client reset escaped as a
  //      process-level `uncaughtException` (`read ECONNRESET` at 2026-10-23T13:08:11Z, then `write EPIPE`
  //      with frames `_write (writable:491:11)` / `afterWriteDispatched` four seconds later);
  //   2. no path closed the target connection, so the target never learned the request was over.
  // Both client-side endings are covered because they arrive differently: a reset raises `error` on the
  // tunnel socket, a plain destroy only closes it — and each one alone used to leave the target open.
  for (const ending of ['reset', 'destroy'] as const) {
    it(`tears an established tunnel down when the client is ${ending}d, leaving no target socket open`, async () => {
      let targetClosed = false
      let targetSocket: import('node:net').Socket | undefined
      const targetClosedSignal = armedSignal()
      const target = createTcpServer((socket) => {
        targetSocket = socket
        socket.on('close', () => {
          targetClosed = true
          targetClosedSignal.fire()
        })
        // Passive peer: it must stay connected until *we* close it, which is the leak under test.
        socket.on('data', () => undefined)
      })
      await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
      const targetPort = (target.address() as { port: number }).port
      proxy = new EgressProxy()
      proxy.setAllowlist(['127.0.0.1'])
      const tunnelEnding = watchTunnelEnding(proxy)
      const port = await proxy.start()

      const escaped: unknown[] = []
      const onEscaped = (error: unknown): void => {
        escaped.push(error)
      }
      process.on('uncaughtException', onEscaped)
      let established = false
      let clientSocketClosed = false
      try {
        await new Promise<void>((resolve) => {
          const socket = tcpConnect({ host: '127.0.0.1', port })
          let done = false
          const finish = (): void => {
            if (done) return
            done = true
            clearInterval(keepTalking)
            clearTimeout(watchdog)
            setTimeout(resolve, 150)
          }
          // Fails in seconds with the named assertions below instead of riding the suite's timeout.
          const watchdog = setTimeout(finish, 3000)
          watchdog.unref?.()
          const keepTalking = setInterval(() => {
            if (!established || done) return
            for (let index = 0; index < 8; index += 1) socket.write('x'.repeat(4096))
          }, 5)
          socket.on('connect', () => {
            socket.write(
              `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`
            )
          })
          let data = ''
          socket.on('data', (chunk) => {
            data += chunk.toString()
            if (established || !data.includes('200 Connection Established')) return
            established = true
            // The client goes away *after* the tunnel carries traffic: the shape that used to leak and throw.
            setTimeout(() => {
              if (ending === 'reset') socket.resetAndDestroy()
              else socket.destroy()
            }, 20)
          })
          socket.on('error', () => undefined)
          socket.on('close', () => {
            clientSocketClosed = true
            finish()
          })
        })
        expect(established).toBe(true)
        expect(clientSocketClosed).toBe(true)
        // The leak: the target connection has to be closed by the proxy, not by the target — asserted
        // whenever the proxy was actually given an ending. When it was not, that is a platform event
        // (measured on this machine: 6–10 of 200 real loopback resets left the tunnel socket `open`,
        // with no `end`, and a byte written through it still flushed), so the same property is pinned
        // deterministically on a socket we control, in the two tests right below. Never silent.
        if (tunnelEnding.seen.length === 0) {
          process.stdout.write(
            `[egress] the ${ending} ending never reached the proxy; ` +
              'the target-close assertion rests on the deterministic pins below\n'
          )
        } else {
          expect(await settledWithin(targetClosedSignal.promise)).toBe('settled')
          expect(targetClosed).toBe(true)
        }
        // ...and the teardown was scoped to this tunnel: the same proxy still answers a fresh CONNECT,
        // so "settled" cannot be satisfied by a proxy that stopped serving altogether.
        const again = await new Promise<string>((resolve) => {
          const socket = tcpConnect({ host: '127.0.0.1', port })
          let data = ''
          let done = false
          const finish = (): void => {
            if (done) return
            done = true
            clearTimeout(watchdog)
            socket.destroy()
            resolve(data)
          }
          const watchdog = setTimeout(finish, 10_000)
          watchdog.unref?.()
          socket.on('connect', () => {
            socket.write(
              `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`
            )
          })
          socket.on('data', (chunk) => {
            data += chunk.toString()
            if (data.includes('200 Connection Established')) finish()
          })
          socket.on('error', () => finish())
          socket.on('close', () => finish())
        })
        expect(again).toContain('200 Connection Established')
      } finally {
        process.off('uncaughtException', onEscaped)
        // A leaked target socket would otherwise make cleanup hang and hide the assertion above — and a
        // hang here is not free: it rides the suite's 60 s timeout and then hangs `afterEach` on
        // `proxy.stop()` too, which is how this file turned the whole coverage lane red (measured
        // 2026-10-30 on the full suite: `Test timed out in 60000ms` at this test, then `Hook timed out`
        // in afterEach; the same file alone is green 5/5). The leak itself is asserted above, so the
        // teardown is bounded and *says* when it had to force the server side shut.
        targetSocket?.destroy()
        const targetClosed = new Promise<void>((resolve) => target.close(() => resolve()))
        if ((await settledWithin(targetClosed, 5_000)) === 'timeout') {
          process.stdout.write(
            `[egress] target server still had an open connection 5 s after the ${ending} ending; forcing it shut\n`
          )
          // The reset ending sometimes never reaches the proxy (a platform event documented above), so
          // the tunnel socket is legitimately still open here — force the acceptor, don't wait for it.
          ;(target as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
          await settledWithin(targetClosed, 5_000)
        }
      }
      expect(escaped).toEqual([])
    })
  }

  // Stop is a settings action (turning egress off) and the teardown of every test in this file: it must
  // not wait for a client to let go of its tunnel. Before the fix `stop()` awaited `server.close()`,
  // which waits for every open connection — a client holding a CONNECT tunnel kept the await from ever
  // returning (the coverage lane's only red on 2026-10-30, and a settings toggle that hangs for the user).
  it('stops while a CONNECT tunnel is still open instead of waiting for the client', async () => {
    proxy = new EgressProxy()
    proxy.setAllowlist(['127.0.0.1'])
    const peerPort = (peer.address() as { port: number }).port
    const port = await proxy.start()

    const socket = tcpConnect({ host: '127.0.0.1', port })
    await new Promise<void>((resolve, reject) => {
      let data = ''
      socket.on('connect', () => {
        socket.write(
          `CONNECT 127.0.0.1:${peerPort} HTTP/1.1\r\nHost: 127.0.0.1:${peerPort}\r\n\r\n`
        )
      })
      socket.on('data', (chunk) => {
        data += chunk.toString()
        if (data.includes('200 Connection Established')) resolve()
      })
      socket.on('error', reject)
      socket.on('close', () => reject(new Error('the tunnel closed before it was established')))
    })

    // The client keeps the tunnel open and does nothing else — the shape that used to block `stop()`.
    expect(await settledWithin(proxy.stop(), 5_000)).toBe('settled')
    socket.destroy()
  })

  // Deterministic pin for the ending that carries no error: a socket the test owns emits `close` and
  // nothing else, and a teardown that only listened for `error` left the target connection open. Over
  // real TCP that ending arrives intermittently, so it is pinned here on a socket we control.
  it('tears the target down when the client socket closes with no error and no end', async () => {
    let targetClosed = false
    const targetConnectedSignal = armedSignal()
    const targetClosedSignal = armedSignal()
    const target = createTcpServer((socket) => {
      targetConnectedSignal.fire()
      socket.on('data', () => undefined)
      socket.on('close', () => {
        targetClosed = true
        targetClosedSignal.fire()
      })
    })
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    const targetPort = (target.address() as { port: number }).port
    const localProxy = new EgressProxy()
    localProxy.setAllowlist(['127.0.0.1'])
    // A socket we own, so `destroy()` emits `close` and nothing else — the silent ending under test.
    const clientSide = new Duplex({
      read() {
        return undefined
      },
      write(_chunk, _encoding, callback) {
        callback()
      }
    })
    try {
      const connectHandler = localProxy as unknown as {
        handleConnect(
          req: { url?: string; method?: string; headers: Record<string, string> },
          socket: Duplex,
          head: Buffer
        ): void
      }
      connectHandler.handleConnect(
        { url: `127.0.0.1:${targetPort}`, method: 'CONNECT', headers: {} },
        clientSide,
        Buffer.alloc(0)
      )
      const connected = await settledWithin(targetConnectedSignal.promise)
      // Without a live tunnel the assertion below would be vacuous.
      expect(connected).toBe('settled')
      clientSide.destroy()
      const closedInTime = await settledWithin(targetClosedSignal.promise)
      expect(closedInTime).toBe('settled')
      expect(targetClosed).toBe(true)
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()))
    }
  })

  // The reset ending, pinned the same way the silent close is: the ending is delivered to the tunnel
  // socket by *us*, so the leak assertion does not depend on the kernel delivering an RST. Measured
  // on 2026-10-26 over real loopback, 6–10 of 200 resets never reached the peer at all — the tunnel
  // socket stayed `open` with no `end`, and a byte written through it still flushed — so the real-TCP
  // case above can only assert what the platform actually guarantees.
  it('tears the target down when the client socket errors on a reset, then closes', async () => {
    let targetClosed = false
    const targetConnectedSignal = armedSignal()
    const targetClosedSignal = armedSignal()
    const target = createTcpServer((socket) => {
      targetConnectedSignal.fire()
      socket.on('data', () => undefined)
      socket.on('close', () => {
        targetClosed = true
        targetClosedSignal.fire()
      })
    })
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    const targetPort = (target.address() as { port: number }).port
    const localProxy = new EgressProxy()
    localProxy.setAllowlist(['127.0.0.1'])
    const clientSide = new Duplex({
      read() {
        return undefined
      },
      write(_chunk, _encoding, callback) {
        callback()
      }
    })
    const escaped: unknown[] = []
    const onEscaped = (error: unknown): void => {
      escaped.push(error)
    }
    process.on('uncaughtException', onEscaped)
    try {
      const connectHandler = localProxy as unknown as {
        handleConnect(
          req: { url?: string; method?: string; headers: Record<string, string> },
          socket: Duplex,
          head: Buffer
        ): void
      }
      connectHandler.handleConnect(
        { url: `127.0.0.1:${targetPort}`, method: 'CONNECT', headers: {} },
        clientSide,
        Buffer.alloc(0)
      )
      expect(await settledWithin(targetConnectedSignal.promise)).toBe('settled')
      // The shipped build's shape: `read ECONNRESET` arrived with nothing listening for it, so it
      // escaped to the process. Emitting it on a socket we own pins both halves: no escape, and the
      // target connection closed by the proxy.
      clientSide.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
      clientSide.destroy()
      expect(await settledWithin(targetClosedSignal.promise)).toBe('settled')
      expect(targetClosed).toBe(true)
    } finally {
      process.off('uncaughtException', onEscaped)
      await new Promise<void>((resolve) => target.close(() => resolve()))
    }
    expect(escaped).toEqual([])
  })

  it('answers a plain HTTP target failure with the named family and a 502, not a 403', async () => {
    proxy = new EgressProxy()
    proxy.setAllowlist(['127.0.0.1'])
    const port = await proxy.start()
    const deadPort = await closedLoopbackPort()

    const answered = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/probe',
          headers: { host: `127.0.0.1:${deadPort}` }
        },
        (res) => {
          let body = ''
          res.on('data', (chunk) => (body += chunk.toString()))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        }
      )
      req.on('error', reject)
      req.end()
    })

    // A dead source is not an authorization decision: 403 would have told the caller to ask for
    // permission for something the allowlist already allowed.
    expect(answered.status).toBe(502)
    expect(answered.body).toContain('egress refused failure reaching 127.0.0.1')
  })

  it('keeps allowlist denials at 403 with their own wording', async () => {
    proxy = new EgressProxy()
    proxy.setAllowlist(['allowed.test'])
    const port = await proxy.start()

    const answered = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        { hostname: '127.0.0.1', port, path: '/probe', headers: { host: '169.254.169.254' } },
        (res) => {
          let body = ''
          res.on('data', (chunk) => (body += chunk.toString()))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        }
      )
      req.on('error', reject)
      req.end()
    })

    expect(answered.status).toBe(403)
    expect(answered.body).toContain('allowlist')
  })

  it('routes blocked non-deny destinations through the approval handler and honors allow once', async () => {
    proxy = new EgressProxy()
    // The allowlist names a domain that never resolves; the loopback request host is NOT allowed,
    // so it is suspended and routed through approval, then Allow once forwards it to the peer.
    proxy.setAllowlist(['allowed.test'])
    const seen: Array<{ host: string; method: string }> = []
    proxy.setApprovalHandler((approvalRequest, decide) => {
      seen.push({ host: approvalRequest.host, method: approvalRequest.method })
      // Simulate the user choosing Allow once after a tick, like a real conversation card.
      setTimeout(() => decide('allow_once'), 5)
    })
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

    expect(seen).toEqual([{ host: `127.0.0.1:${peerPort}`, method: 'GET' }])
    expect(status).toBe(200)
  })

  it('refuses blocked destinations when the approval decision is deny', async () => {
    proxy = new EgressProxy()
    proxy.setAllowlist(['127.0.0.1'])
    proxy.setApprovalHandler((_approvalRequest, decide) => decide('deny'))
    const port = await proxy.start()

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/probe',
          headers: { host: 'blocked.test' }
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

  // V8. The approval deadline is the branch that had NO test on either side, while the workspace's card
  // auto-withdraws on the same number: if the proxy never refuses at its own deadline, the suspended request
  // hangs until the process-level timeout and the user sees a card vanish while the request is still open.
  // The budget is injected (production keeps 60s) so this proves the branch in milliseconds with real I/O.
  it('refuses a suspended request at the approval deadline, and ignores a decision that arrives late', async () => {
    proxy = new EgressProxy({ approvalTimeoutMs: 80 })
    proxy.setAllowlist(['allowed.test'])
    // The peer is the "target host"; a late `allow_once` that resurrected the request would reach it.
    let peerHits = 0
    peer.on('request', () => {
      peerHits += 1
    })
    const seen: Array<{ host: string; expiresInSec: number }> = []
    let decideLater: ((decision: 'deny' | 'allow_once' | 'allow_always') => void) | undefined
    const decided: string[] = []
    proxy.setApprovalHandler((approvalRequest, decide) => {
      seen.push({ host: approvalRequest.host, expiresInSec: approvalRequest.expiresInSec })
      decideLater = (decision) => {
        decided.push(decision)
        decide(decision)
      }
      // The user walks away: nothing is decided while the deadline runs.
    })
    const port = await proxy.start()
    const peerPort = (peer.address() as { port: number }).port

    const pending = new Promise<number>((resolve, reject) => {
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

    // The suspended request is refused without an answer — this is what the card's countdown promises.
    expect(await pending).toBe(403)
    // And the card's number is the proxy's own deadline, not a second copy that can drift.
    expect(seen).toEqual([{ host: `127.0.0.1:${peerPort}`, expiresInSec: 0.08 }])

    // A decision that arrives after the deadline must not resurrect the request: the peer never sees it, and
    // the late decision is what "应答失败不再静默" is about — the caller is told, not silently ignored.
    decideLater?.('allow_once')
    expect(decided).toEqual(['allow_once'])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(peerHits).toBe(0)
  })

  it('refuses immediately when no approval handler is installed (historical behavior)', async () => {
    proxy = new EgressProxy()
    proxy.setAllowlist(['127.0.0.1'])
    const port = await proxy.start()

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/probe',
          headers: { host: 'blocked.test' }
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

  it('never routes deny-list hosts through approval (deny wins unconditionally)', async () => {
    proxy = new EgressProxy()
    proxy.setAllowlist(['127.0.0.1'])
    const seen: unknown[] = []
    proxy.setApprovalHandler((approvalRequest, decide) => {
      seen.push(approvalRequest.host)
      decide('allow_once')
    })
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
    // The deny list wins before approval is consulted; the handler never fires.
    expect(seen).toEqual([])
    expect(status).toBe(403)
  })

  describe('child process routing', () => {
    afterEach(async () => {
      resetEgressRuntimeForTest()
      // Stops the proxy, so one test's listener cannot leak into the next.
      await applyEgressSettings(undefined)
    })

    it('leaves a child env untouched while egress is off', () => {
      const env = { PATH: '/usr/bin' }
      expect(applyEgressToChildEnv(env)).toEqual(env)
      expect(egressProxyEnv()).toBeUndefined()
    })

    it('routes a child process through the proxy once egress is on', async () => {
      await applyEgressSettings({ enabled: true, groups: {}, customDomains: ['example.org'] })

      const childEnv = applyEgressToChildEnv({
        PATH: '/usr/bin',
        ANTHROPIC_BASE_URL: 'https://api.provider.test/v1'
      })

      // This is what the ACP agent spawn now receives; before, its shell reached the network directly.
      expect(childEnv.HTTP_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(childEnv.HTTPS_PROXY).toBe(childEnv.HTTP_PROXY)
      // Nothing is bypassed by name: the proxy itself decides, per request.
      expect(childEnv.NO_PROXY).toBe('')
      expect(childEnv.PATH).toBe('/usr/bin')
    })

    it('allows the endpoint the app itself is configured to use, without a prompt', async () => {
      await applyEgressSettings({ enabled: true, groups: {}, customDomains: [] })

      const release = allowImplicitEgressHost('https://api.provider.test/v1')
      expect(implicitEgressHostsForTest()).toEqual(['api.provider.test'])

      // A configured endpoint is a user-set destination, not agent-initiated browsing: suspending it
      // would put a card in front of every turn.
      expect(normalizeImplicitHost('api.provider.test/v1')).toBe('api.provider.test')
      expect(normalizeImplicitHost('')).toBeUndefined()
      expect(normalizeImplicitHost('not a url')).toBeUndefined()

      release()
      expect(implicitEgressHostsForTest()).toEqual([])
    })
  })
})
