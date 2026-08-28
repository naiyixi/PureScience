import type { PermissionCapabilityKind } from '../../shared/permission-grants'

// Closed v1 bootstrap catalog. Dynamic Connector, ComputeHost, and redacted exact-command identities
// are admitted only by their trusted runtime adapters and do not change this fixed inventory.
const PRE_REGISTERED_PERMISSION_IDENTITIES: Readonly<
  Record<PermissionCapabilityKind, readonly string[]>
> = {
  customize_mutation: [
    'customize:agent_create',
    'customize:agent_update',
    'customize:skill_publish',
    'customize:skill_edit',
    'customize:agent_attach_skill',
    'customize:agent_detach_skill',
    'customize:agent_attach_connector',
    'customize:agent_detach_connector'
  ],
  mcp_tool: [
    'mcp:purescience-notebook/notebook_execute',
    'mcp:purescience-notebook/repl_execute',
    'mcp:purescience-notebook/bash_execute',
    'mcp:purescience-notebook/notebook_state',
    'mcp:purescience-notebook/list_notebook_runtimes',
    'mcp:purescience-notebook/notebook_bind_runtime',
    'mcp:purescience-notebook/notebook_switch_runtime',
    'mcp:purescience-notebook/notebook_restart',
    'mcp:purescience-notebook/notebook_shutdown',
    'mcp:purescience-notebook/inspect_packages',
    'mcp:purescience-notebook/manage_packages',
    'mcp:purescience-notebook/manage_environments',
    'mcp:purescience-artifacts/write_artifact_file',
    'mcp:purescience-activity/begin_activity_group',
    'mcp:purescience-skills/request_skill_import',
    'mcp:purescience-plan/generate_plan',
    'mcp:purescience-plan/update_step_status',
    'mcp:purescience-memory/memory_save_note'
  ],
  execution: ['exec:local/python', 'exec:local/bash'],
  file_operation: [
    'file:read',
    'file:write',
    'file:edit',
    'file:notebook_edit',
    'file:delete',
    'file:move'
  ],
  skill_operation: ['skill:invoke'],
  builtin_tool: []
}

const PRE_REGISTERED_PERMISSION_IDENTITY_COUNT = Object.values(
  PRE_REGISTERED_PERMISSION_IDENTITIES
).reduce((count, identities) => count + identities.length, 0)

const isPreRegisteredPermissionIdentity = (kind: PermissionCapabilityKind, key: string): boolean =>
  PRE_REGISTERED_PERMISSION_IDENTITIES[kind].includes(key)

export {
  PRE_REGISTERED_PERMISSION_IDENTITIES,
  PRE_REGISTERED_PERMISSION_IDENTITY_COUNT,
  isPreRegisteredPermissionIdentity
}
