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
// Pending approval decisions keyed by requestId; `decide` settles the suspended request.
const pendingDecisions = new Map<
  string,
  { host: string; decide: (d: EgressApprovalDecision) => void }
>()
let runtimeOptions: EgressRuntimeOptions | undefined

const approvalHandler: EgressApprovalHandler = (request, decide) => {
  pendingDecisions.set(request.requestId, { host: request.host, decide })
  runtimeOptions?.onApprovalRequest?.(request)
}

// Settles a pending approval from the renderer. Returns false when the requestId is unknown
// (already settled, timed out, or never routed through approval).
export const respondToEgressApproval = async (
  requestId: string,
  decision: EgressApprovalDecision
): Promise<boolean> => {
  const pending = pendingDecisions.get(requestId)
  if (!pending) return false
  pendingDecisions.delete(requestId)
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
  proxy.setAllowlist(allowlist)
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
    NO_PROXY: '',
    no_proxy: ''
  }
}

// Whether egress restrictions are currently active (for diagnostics/tests).
export const isEgressActive = (): boolean => currentEnabled
export const egressAllowlistForTest = (): string[] | undefined => currentAllowlist
export const pendingEgressApprovalsForTest = (): number => pendingDecisions.size
export const resetEgressRuntimeForTest = (): void => {
  pendingDecisions.clear()
}
