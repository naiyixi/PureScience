// Egress restriction runtime: owns the single filtering proxy and derives the child-process env
// that routes kernel / repl / shell traffic through it. The allowlist is pushed in by the settings
// layer whenever egress settings change; kernel/shell spawn paths read `egressProxyEnv()` and merge
// the result into their env when defined (restrictions on) — otherwise they keep current behavior.
//
// Conversation approval: when the proxy blocks a destination that is not on the deny list, it
// suspends the request and routes it through the installed approval handler. The handler broadcasts
// an approval request to the renderer (in-conversation card) and keeps the `decide` callback until
// the user answers. `allow_always` additionally persists the host into the egress customDomains via
// the persistence hook so future requests bypass approval.

import { createLogger } from '../logger'
import { resolveEgressAllowlist, type EgressSettings } from '../../shared/egress'
import {
  EgressProxy,
  type EgressApprovalDecision,
  type EgressApprovalRequest,
  type EgressApprovalHandler
} from './egress-proxy'

export type { EgressApprovalDecision, EgressApprovalRequest, EgressApprovalHandler }

type EgressRuntimeOptions = {
  // Broadcasts one blocked-destination approval request to renderers.
  onApprovalRequest?: (request: EgressApprovalRequest) => void
  // Persists a host into the egress customDomains (allow_always) and re-applies settings.
  persistCustomDomain?: (host: string) => Promise<void>
}

let proxy: EgressProxy | undefined
let currentAllowlist: string[] | undefined
let currentEnabled = false
const log = createLogger('egress')
// Pending approval decisions keyed by requestId; `decide` settles the suspended request.
const pendingDecisions = new Map<
  string,
  { host: string; decide: (d: EgressApprovalDecision) => void }
>()
let runtimeOptions: EgressRuntimeOptions | undefined

const approvalHandler: EgressApprovalHandler = (request, decide) => {
  pendingDecisions.set(request.requestId, { host: request.host, decide })
  log.info('egress approval requested', {
    requestId: request.requestId,
    host: request.host,
    method: request.method,
    pending: pendingDecisions.size,
    hasRenderer: Boolean(runtimeOptions?.onApprovalRequest)
  })
  runtimeOptions?.onApprovalRequest?.(request)
}

// Settles a pending approval from the renderer. Returns false when the requestId is unknown
// (already settled, timed out, or never routed through approval).
export const respondToEgressApproval = async (
  requestId: string,
  decision: EgressApprovalDecision
): Promise<boolean> => {
  const pending = pendingDecisions.get(requestId)
  if (!pending) {
    log.info('egress decision ignored', { requestId, decision, reason: 'no pending request' })
    return false
  }
  pendingDecisions.delete(requestId)
  log.info('egress decision applied', { requestId, decision, host: pending.host })
  pending.decide(decision)
  if (decision === 'allow_always' && runtimeOptions?.persistCustomDomain) {
    // Persist the host so future requests bypass approval; the caller re-applies settings
    // and refreshes the allowlist inside persistCustomDomain.
    await runtimeOptions.persistCustomDomain(pending.host)
  }
  return true
}

// Updates the runtime from persisted settings and returns the proxy env for child processes
// (undefined when egress is off). `options` wires conversation approval; pass once at startup.
export const applyEgressSettings = async (
  settings: EgressSettings | undefined,
  options?: EgressRuntimeOptions
): Promise<NodeJS.ProcessEnv | undefined> => {
  if (options) runtimeOptions = options
  const allowlist = resolveEgressAllowlist(settings)
  currentEnabled = allowlist !== undefined
  currentAllowlist = allowlist

  if (!currentEnabled) {
    if (proxy) {
      proxy.setAllowlist(undefined)
      proxy.setApprovalHandler(undefined)
      await proxy.stop()
      proxy = undefined
    }
    return undefined
  }

  proxy ??= new EgressProxy()
  // Implicit hosts (the app's own configured endpoints) ride along with the settings allowlist, so a
  // settings change never drops them.
  proxy.setAllowlist(mergedAllowlist())
  proxy.setApprovalHandler(approvalHandler)
  const port = await proxy.start()
  return {
    HTTP_PROXY: `http://127.0.0.1:${port}`,
    HTTPS_PROXY: `http://127.0.0.1:${port}`,
    // Route everything through the proxy; the proxy itself decides.
    NO_PROXY: '',
    no_proxy: ''
  }
}

// Returns the current child-process proxy env (undefined = unrestricted). Cheap: no I/O.
export const egressProxyEnv = (): NodeJS.ProcessEnv | undefined => {
  if (!currentEnabled || !proxy) return undefined
  return {
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
    HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
    // The proxy decides, per request; nothing is bypassed by name here.
    NO_PROXY: '',
    no_proxy: ''
  }
}

// The proxy env merged into a child process's environment. Kept as one function so every spawn path that
// is supposed to be governed routes the same way — the ACP agent was left out of this once, and its shell
// traffic reached the network with the allowlist not applying at all.
export const applyEgressToChildEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const proxyEnv = egressProxyEnv()
  return proxyEnv ? { ...env, ...proxyEnv } : env
}

const implicitHosts = new Set<string>()

// Adds an app-configured destination to the allowlist for as long as the app is running. Idempotent;
// removing happens through the returned function so a caller can undo exactly what it added.
export const allowImplicitEgressHost = (value: string | undefined): (() => void) => {
  const host = normalizeImplicitHost(value)
  if (!host) return () => undefined
  implicitHosts.add(host)
  void pushAllowlistToProxy()
  return () => {
    implicitHosts.delete(host)
    void pushAllowlistToProxy()
  }
}

// Extracts a bare hostname from a configured endpoint URL. Returns undefined for anything unusable, so a
// malformed setting cannot silently widen the allowlist.
export const normalizeImplicitHost = (value: string | undefined): string | undefined => {
  if (!value || typeof value !== 'string') return undefined
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`)
    const host = url.hostname.toLowerCase()
    return host.length > 0 ? host : undefined
  } catch {
    return undefined
  }
}

export const implicitEgressHostsForTest = (): string[] => [...implicitHosts]

// Recomputes what the proxy enforces: the settings allowlist plus the implicit hosts. Called both when
// settings change and when an implicit host is added or removed.
const pushAllowlistToProxy = async (): Promise<void> => {
  if (!proxy || !currentEnabled) return
  proxy.setAllowlist(mergedAllowlist())
}

const mergedAllowlist = (): string[] | undefined =>
  currentAllowlist === undefined ? undefined : [...new Set([...currentAllowlist, ...implicitHosts])]

// Whether egress restrictions are currently active (for diagnostics/tests).
export const isEgressActive = (): boolean => currentEnabled
export const egressAllowlistForTest = (): string[] | undefined => currentAllowlist
export const pendingEgressApprovalsForTest = (): number => pendingDecisions.size
export const resetEgressRuntimeForTest = (): void => {
  pendingDecisions.clear()
  implicitHosts.clear()
}
