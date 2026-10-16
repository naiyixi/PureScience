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
    'mcp:purescience_notebook/notebook_execute',
    'mcp:purescience_notebook/repl_execute',
    'mcp:purescience_notebook/bash_execute',
    'mcp:purescience_notebook/notebook_state',
    'mcp:purescience_notebook/list_notebook_runtimes',
    'mcp:purescience_notebook/notebook_bind_runtime',
    'mcp:purescience_notebook/notebook_switch_runtime',
    'mcp:purescience_notebook/notebook_restart',
    'mcp:purescience_notebook/notebook_shutdown',
    'mcp:purescience_notebook/inspect_packages',
    'mcp:purescience_notebook/manage_packages',
    'mcp:purescience_notebook/manage_environments',
    'mcp:purescience_artifacts/write_artifact_file',
    'mcp:purescience_activity/begin_activity_group',
    'mcp:purescience_skills/request_skill_import',
    'mcp:purescience_plan/generate_plan',
    'mcp:purescience_plan/update_step_status',
    'mcp:purescience_memory/memory_save_note',
    // The rest of the app-owned servers. They were named with a hyphen, which each framework escaped
    // differently (`mcp__purescience-pdf__…` vs `mcp__purescience_pdf__…`), so the agent was handed two
    // callable names for one tool and guessed. The identity key is the separator-free canonical name;
    // the hyphenated spelling stays a legacy alias in the naming module.
    'mcp:purescience_pdf/pdf_open',
    'mcp:purescience_pdf/pdf_pages',
    'mcp:purescience_pdf/pdf_outline',
    'mcp:purescience_pdf/pdf_scan',
    'mcp:purescience_pdf/pdf_tables',
    'mcp:purescience_pdf/pdf_figures',
    'mcp:purescience_pdf/pdf_translate',
    'mcp:purescience_annotations/annotation_set',
    'mcp:purescience_annotations/annotation_list',
    'mcp:purescience_annotations/annotation_remove',
    'mcp:purescience_context_summary/summary_query',
    'mcp:purescience_context_summary/boundary',
    'mcp:purescience_endpoints/endpoint_register',
    'mcp:purescience_endpoints/endpoint_unregister',
    'mcp:purescience_endpoints/endpoint_start',
    'mcp:purescience_endpoints/endpoint_stop',
    'mcp:purescience_endpoints/endpoint_status',
    'mcp:purescience_endpoints/endpoint_list',
    'mcp:purescience_endpoints/endpoint_free_port',
    'mcp:purescience_goal/goal_configure',
    'mcp:purescience_goal/goal_status',
    'mcp:purescience_goal/goal_advance',
    'mcp:purescience_host_query/host_query',
    'mcp:purescience_routine/routine_configure',
    'mcp:purescience_routine/routine_status',
    'mcp:purescience_routine/routine_cancel'
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
