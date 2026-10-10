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
import { createLogger } from '../logger'
import { describeEgressFailure, formatEgressFailure } from './egress-failure'

const log = createLogger('egress-proxy')

export type EgressProxyState = {
  // Current allowlist; undefined means unrestricted (proxy refuses to start or is idle).
  allowlist: string[] | undefined
}

// Outcome of a conversation approval decision for one blocked destination.
export type EgressApprovalDecision = 'deny' | 'allow_once' | 'allow_always'

// A blocked destination surfaced for in-conversation approval. The proxy suspends the
// offending request (HTTP response or CONNECT tunnel) until the decision arrives or the
// approval times out, so the user's choice applies to the exact request that triggered it.
export type EgressApprovalRequest = {
  requestId: string
  host: string
  method: string
  path: string
  // Seconds until the suspended request is refused without an answer.
  expiresInSec: number
}

export type EgressApprovalHandler = (
  request: EgressApprovalRequest,
  decide: (decision: EgressApprovalDecision) => void
) => void

const APPROVAL_TIMEOUT_MS = 60_000
let approvalSequence = 0

// Local loopback egress proxy. Exposes an HTTP server that handles plain HTTP requests (via the
// request URL host) and CONNECT tunnels (used by HTTPS clients through a proxy). Only hosts on the
// allowlist are forwarded; everything else is either refused outright (deny-list hosts) or routed
// through the conversation approval handler, which suspends the request until the user decides.
export class EgressProxy {
  private readonly server: Server
  // How long a suspended approval waits before the request is refused without an answer. Injectable for the
  // same reason `TimeoutController` takes its graces: the 60s deadline is the behaviour under test, and a test
  // that has to sleep a real minute to prove it either gets skipped or gets flaky (see the expiry case in
  // `egress.test.ts`). Production always takes the default.
  private readonly approvalTimeoutMs: number
  private allowlist: string[] | undefined
  private listeningPort = 0
  private approvalHandler: EgressApprovalHandler | undefined

  constructor(options: { approvalTimeoutMs?: number } = {}) {
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS
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

  // Routes blocked (non-deny) destinations through conversation approval. Without a handler the
  // proxy keeps the historical behavior: refuse with 403 immediately.
  setApprovalHandler(handler: EgressApprovalHandler | undefined): void {
    this.approvalHandler = handler
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

  // Suspends the pending response until the user decides; refuses (403) when no approval handler
  // is installed, the request times out, or the decision is Deny.
  private requireApproval(
    host: string,
    method: string,
    path: string,
    onAllowed: () => void,
    onDenied: () => void
  ): void {
    if (!this.approvalHandler) {
      onDenied()
      return
    }
    const requestId = `egress-${++approvalSequence}`
    let settled = false
    log.info('egress approval suspending', { requestId, host, method, path })
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      log.warn('egress approval timed out', { requestId, host })
      onDenied()
    }, this.approvalTimeoutMs)
    this.approvalHandler(
      { requestId, host, method, path, expiresInSec: this.approvalTimeoutMs / 1000 },
      (decision) => {
        if (settled) {
          log.info('egress decision arrived late', {
            requestId,
            host,
            decision,
            outcome: 'ignored'
          })
          return
        }
        settled = true
        clearTimeout(timeout)
        log.info('egress approval decided', { requestId, host, decision })
        if (decision === 'deny') {
          onDenied()
          return
        }
        // allow_once / allow_always both let this exact request through; the allowlist for
        // always is persisted by the caller, which re-applies settings and refreshes the list.
        onAllowed()
      }
    )
  }

  private refuse(res: ServerResponse | Duplex, message: string, status = 403): void {
    if ('writeHead' in res) {
      // The response may already be streaming a source body when the source fails; the status line is
      // then already on the wire, so all that is left is to drop the connection.
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(status, { 'content-type': 'text/plain' })
      res.end(message)
    } else {
      res.end(`HTTP/1.1 ${status} ${status === 502 ? 'Bad Gateway' : 'Forbidden'}\r\n\r\n${message}`)
    }
  }

  // Plain HTTP request: forward via the target host if allowed, otherwise ask the user (or 403).
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const host = req.headers.host
    if (!host || !this.isAllowed(host)) {
      const forward = (): void => {
        if (!host) {
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
        sourceReq.on('error', (error: Error) => {
          this.refuseTargetFailure(res, host, error)
        })
        req.pipe(sourceReq)
      }
      const deny = (): void => {
        this.refuse(res, 'PureScience egress allowlist: host not permitted')
      }
      if (!host || isHostDenied(host)) {
        deny()
        return
      }
      if (this.allowlist !== undefined && !isHostAllowed(host, this.allowlist)) {
        this.requireApproval(host, req.method ?? 'GET', req.url ?? '/', forward, deny)
        return
      }
      forward()
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
    sourceReq.on('error', (error: Error) => {
      this.refuseTargetFailure(res, host, error)
    })
    req.pipe(sourceReq)
  }

  // A failure of the *source*, not of the allowlist: it is logged with the named family (the log used
  // to answer a generic string while discarding the error, so these failures left no trace at all) and
  // answered as 502 — a 403 would mislabel a dead source as an authorization decision.
  private refuseTargetFailure(
    res: ServerResponse | Duplex,
    host: string,
    error: Error,
    port?: number
  ): void {
    const failure = describeEgressFailure(error)
    // The tunnel keeps its historical message name so the existing log-grep recipes (and any reading
    // taken before this change) still join across it; `family` is the field that is new.
    log.warn(port === undefined ? 'egress target failed' : 'egress tunnel target failed', {
      host,
      ...(port === undefined ? {} : { port }),
      family: failure.family,
      code: failure.code,
      error: error.message
    })
    this.refuse(res, `PureScience egress proxy: ${formatEgressFailure(failure, host)}`, 502)
  }

  // HTTPS CONNECT tunnel: open a raw TCP tunnel to the target if allowed, or ask first.
  private handleConnect(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const host = req.url?.split(':')[0] ?? ''
    const open = (): void => {
      const port = Number(req.url?.split(':')[1] ?? 443)
      log.info('egress tunnel opening', { host, port })
      const targetConn = tcpConnect({ host, port })
      targetConn.on('error', (error: Error) => {
        // Answer before dropping the tunnel. A bare destroy reaches the client as an anonymous socket
        // hang up, exactly like a connection that was cut mid-flight, so the reason never leaves this
        // process — which is how 86 of these became unanswerable "failed to reach the target" reports.
        this.refuseTargetFailure(socket, host, error, port)
        socket.destroy()
      })
      targetConn.on('connect', () => {
        log.info('egress tunnel established', { host, port })
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) targetConn.write(head)
        socket.pipe(targetConn)
        targetConn.pipe(socket)
      })
    }
    const deny = (): void => {
      this.refuse(socket, 'PureScience egress allowlist: host not permitted')
      socket.destroy()
    }
    if (!host || !this.isAllowed(host)) {
      if (!host || isHostDenied(host)) {
        deny()
        return
      }
      if (this.allowlist !== undefined && !isHostAllowed(host, this.allowlist)) {
        this.requireApproval(host, 'CONNECT', req.url ?? '', open, deny)
        return
      }
      open()
      return
    }
    open()
  }
}
