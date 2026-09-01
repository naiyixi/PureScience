export const PERMISSION_CAPABILITY_KINDS = [
  'customize_mutation',
  'mcp_tool',
  'execution',
  'file_operation',
  'skill_operation',
  'builtin_tool'
] as const

export const EXACT_PERMISSION_QUALIFIER_PATTERN = /^sha256:v1:[a-f0-9]{64}$/

export type PermissionCapabilityKind = (typeof PERMISSION_CAPABILITY_KINDS)[number]

export type PermissionCapabilityQualifier =
  { mode: 'any' } | { mode: 'category' | 'exact'; value: string }

export type PermissionCapability = {
  kind: PermissionCapabilityKind
  key: string
  qualifier?: PermissionCapabilityQualifier
}

export type PermissionGrantScope =
  | { kind: 'global' }
  | { kind: 'project'; projectId: string }
  | { kind: 'session'; projectId: string; sessionId: string }

export type PermissionGrantRecord = {
  id: string
  capability: PermissionCapability
  scope: PermissionGrantScope
  createdAt?: number
  revision: number
}

export type PermissionGrantContext = {
  projectId?: string
  sessionId?: string
}

export type PermissionGrantMatch = {
  grant: PermissionGrantRecord
  matchedScope: PermissionGrantScope['kind']
}

export type RememberPermissionGrant = {
  capability: PermissionCapability
  scope: PermissionGrantScope
}

export type RevokePermissionGrants = {
  grants: Array<{ id: string; revision: number }>
}

export type RestorePermissionGrants = {
  undoToken: string
}

export type ExtendPermissionGrantUndo = {
  undoToken: string
}

export type PermissionGrantUndoReceipt = {
  undoToken: string
  expiresAt: number
  revokedCount: number
}

export type PermissionGrantOwner =
  | { kind: 'project'; projectId: string }
  | { kind: 'session'; projectId: string; sessionId: string }
  | { kind: 'mcp_server'; serverId: string }
  | { kind: 'compute_provider'; providerId: string }

export type PermissionGrantMutationConflict = {
  id: string
  reason: 'stale' | 'missing' | 'target-unavailable'
}

export type PermissionGrantMutationResult = {
  grants: PermissionGrantRecord[]
  receipt?: PermissionGrantUndoReceipt
  conflicts: PermissionGrantMutationConflict[]
}

export const PERMISSION_GRANT_FAMILIES = [
  'registry_writes',
  'local_compute',
  'connectors',
  'file_operations',
  'skills',
  'built_in_tools'
] as const

export type PermissionGrantFamily = (typeof PERMISSION_GRANT_FAMILIES)[number]

// Renderer-safe projection. Exact qualifier digests and raw tool inputs never cross IPC.
export type PermissionGrantView = {
  id: string
  revision: number
  family: PermissionGrantFamily
  capabilityKind: PermissionCapabilityKind
  capabilityLabel: string
  qualifierLabel?: string
  scopeKind: PermissionGrantScope['kind']
  scopeLabel: string
  // A broader matching grant that remains effective after this exact row is revoked.
  coveredBy?: 'global' | 'project'
  effectiveState?: 'active' | 'covered_by_policy' | 'blocked_by_policy'
  policyHint?: string
  connectorServerId?: string
  connectorToolName?: string
  projectId?: string
  sessionId?: string
  createdAt?: number
}

export type PermissionGrantSnapshot = {
  version: number
  incompleteStores: Array<'projects' | 'sessions' | 'connector_policy'>
  grants: PermissionGrantView[]
  counts: {
    all: number
    global: number
    project: number
    session: number
  }
}

export type PermissionGrantRevokeRequest = {
  grants: Array<{ id: string; revision: number }>
}

export type PermissionGrantRestoreRequest = {
  undoToken: string
}

// Baseline safe grants restored by Settings → Permissions → Restore defaults.
// These mirror the fresh-install seeding: skill invocation plus reading literature
// linked to the current message. Restore defaults re-adds only the missing baseline
// grants (global scope) and never touches any other remembered permission.
export const DEFAULT_SAFE_GRANTS: ReadonlyArray<PermissionCapability> = [
  { kind: 'skill_operation', key: 'skill:invoke' }
]

export type RestoreDefaultsPermissionGrants = {
  // Capabilities the baseline expects; the app resolves each against its live
  // identity catalog, so unknown baseline entries degrade to a conflict instead
  // of silently granting nothing.
  capabilities: ReadonlyArray<PermissionCapability>
}

export type PermissionGrantUndoExtendRequest = {
  undoToken: string
}

export type PermissionGrantMutationView = PermissionGrantSnapshot & {
  receipt?: PermissionGrantUndoReceipt
  conflicts: PermissionGrantMutationConflict[]
}

export type PermissionGrantsChangedEvent = { revision: number }
