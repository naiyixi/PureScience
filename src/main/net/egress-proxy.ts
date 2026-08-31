// Egress filtering proxy for notebook / repl / shell child processes. When network egress
// restrictions are enabled, spawned kernels and shells are pointed at this loopback proxy via
// HTTP(S)_PROXY; the proxy forwards only requests whose target host is on the allowlist and
// answers 403 for everything else. This is the process-level enforcement of the Network panel's
// scientific-domain allowlist — the child processes themselves never see the outside network
// directly.

import {
  request as httpRequest,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { connect as tcpConnect } from 'node:net'
import type { Duplex } from 'node:stream'

import { isHostAllowed, isHostDenied } from '../../shared/egress'

export type EgressProxyState = {
  // Current allowlist; undefined means unrestricted (proxy refuses to start or is idle).
  allowlist: string[] | undefined
}

// Local loopback egress proxy. Exposes an HTTP server that handles plain HTTP requests (via the
// request URL host) and CONNECT tunnels (used by HTTPS clients through a proxy). Only hosts on the
// allowlist are forwarded; everything else gets a 403.
export class EgressProxy {
  private readonly server: Server
  private allowlist: string[] | undefined
  private listeningPort = 0

  constructor() {
    this.server = createServer((req, res) => this.handleHttp(req, res))
    this.server.on('connect', (req, socket, head) => this.handleConnect(req, socket, head))
  }

  // Starts listening on an ephemeral loopback port; returns the port (0 if not listening).
  async start(): Promise<number> {
    if (this.server.listening) return this.listeningPort
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        const address = this.server.address()
        this.listeningPort = typeof address === 'object' && address ? address.port : 0
        resolve()
      })
    })
    return this.listeningPort
  }

  async stop(): Promise<void> {
    if (!this.server.listening) return
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  setAllowlist(allowlist: string[] | undefined): void {
    this.allowlist = allowlist
  }

  get port(): number {
    return this.listeningPort
  }

  private isAllowed(host: string): boolean {
    // The built-in deny list always wins: an exfiltration target stays blocked even when the
    // allowlist mechanism is off or the host was user-added.
    if (isHostDenied(host)) return false
    if (this.allowlist === undefined) return true // unrestricted
    return isHostAllowed(host, this.allowlist)
  }

  private refuse(res: ServerResponse | Duplex, message: string): void {
    if ('writeHead' in res) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end(message)
    } else {
      res.end(`HTTP/1.1 403 Forbidden\r\n\r\n${message}`)
    }
  }

  // Plain HTTP request: forward via the target host if allowed, using node's http.request so the
  // the remote response is parsed and re-emitted properly on the ServerResponse.
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const host = req.headers.host
    if (!host || !this.isAllowed(host)) {
      this.refuse(res, 'PureScience egress allowlist: host not permitted')
      return
    }
    const url = new URL(req.url ?? '/', `http://${host}`)
    const sourceReq = httpRequest(
      {
        hostname: url.hostname,
        port: Number(url.port || 80),
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers: { ...req.headers, host }
      },
      (sourceRes) => {
        res.writeHead(sourceRes.statusCode ?? 502, sourceRes.headers)
        sourceRes.pipe(res)
      }
    )
    sourceReq.on('error', () => {
      this.refuse(res, 'PureScience egress proxy: target unreachable')
    })
    req.pipe(sourceReq)
  }

  // HTTPS CONNECT tunnel: open a raw TCP tunnel to the target if allowed.
  private handleConnect(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const host = req.url?.split(':')[0] ?? ''
    if (!host || !this.isAllowed(host)) {
      this.refuse(socket, 'PureScience egress allowlist: host not permitted')
      socket.destroy()
      return
    }
    const port = Number(req.url?.split(':')[1] ?? 443)
    const targetConn = tcpConnect({ host, port })
    targetConn.on('error', () => socket.destroy())
    targetConn.on('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) targetConn.write(head)
      socket.pipe(targetConn)
      targetConn.pipe(socket)
    })
  }
}
