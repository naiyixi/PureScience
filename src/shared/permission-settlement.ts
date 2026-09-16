import type { AcpPermissionRequest } from './acp'

// One credential, many prompts: when an agent fans out several tool calls against the same target, the
// reader gets one dialog per call for what is really a single decision. This groups pending requests by
// the thing the decision is *about*, so they can be settled together instead of answered one by one.
//
// The identity deliberately ignores everything that differs between two calls to the same target — the
// request id, the tool-call id and the human-readable title all vary per call, and grouping on any of
// them would produce one group per prompt, which is where we already are.
export const permissionSettlementKey = (request: AcpPermissionRequest): string => {
  // An MCP tool's identity is the server/tool pair the broker resolved: the same pair means the same
  // credential and the same data source.
  if (request.isMcp && request.mcpIdentity) {
    return `mcp:${request.mcpIdentity}`
  }
  // A command group is identified by its argv prefix, which is exactly what a remembered scope
  // authorizes.
  if (request.commandPrefix && request.commandPrefix.length > 0) {
    return `command:${request.commandPrefix.join(' ')}`
  }
  // Otherwise fall back to the provider tool, which is the closest thing to "the same capability" the
  // request carries. No tool identity at all is its own key: two anonymous requests must not be settled
  // together on the strength of a shared absence.
  if (request.providerToolName) {
    return `tool:${request.providerToolName}`
  }
  return `request:${request.requestId}`
}

export type PermissionSettlementBatch = {
  key: string
  requests: readonly AcpPermissionRequest[]
}

/** Groups pending requests that share a settlement identity. Order follows the first appearance. */
export const groupPermissionSettlementBatches = (
  requests: readonly AcpPermissionRequest[]
): readonly PermissionSettlementBatch[] => {
  const groups = new Map<string, AcpPermissionRequest[]>()
  for (const request of requests) {
    const key = permissionSettlementKey(request)
    const existing = groups.get(key)
    if (existing) existing.push(request)
    else groups.set(key, [request])
  }
  return [...groups.entries()].map(([key, grouped]) => ({ key, requests: grouped }))
}

/**
 * The options that can be applied to every request in the batch, in the order the first request lists
 * them. An option only some of the requests offer cannot be settled for the whole batch: settling it
 * anyway would decide something a request never asked about.
 */
export const permissionSettlementOptions = (
  requests: readonly AcpPermissionRequest[]
): readonly string[] => {
  if (requests.length === 0) return []
  const [first, ...rest] = requests
  return first.options
    .map((option) => option.optionId)
    .filter((optionId) =>
      rest.every((request) => request.options.some((o) => o.optionId === optionId))
    )
}

/** The other pending requests that would be settled together with this one (empty when it is alone). */
export const permissionSettlementSiblings = (
  request: AcpPermissionRequest,
  requests: readonly AcpPermissionRequest[]
): readonly AcpPermissionRequest[] => {
  const key = permissionSettlementKey(request)
  return requests.filter(
    (candidate) =>
      candidate.requestId !== request.requestId && permissionSettlementKey(candidate) === key
  )
}
