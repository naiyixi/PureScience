import { describe, expect, it } from 'vitest'

import {
  PRE_REGISTERED_PERMISSION_IDENTITIES,
  PRE_REGISTERED_PERMISSION_IDENTITY_COUNT
} from './identity-catalog'

describe('permission identity catalog', () => {
  it('contains the closed 65-identity v1 bootstrap inventory', () => {
    expect(PRE_REGISTERED_PERMISSION_IDENTITY_COUNT).toBe(65)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.builtin_tool).toEqual([])
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.customize_mutation).toHaveLength(8)
    // 18 identities for the six servers that were declared first, plus the 26 the app-owned servers
    // named with a hyphen contributed once their canonical spelling became separator-free.
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.mcp_tool).toHaveLength(48)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.execution).toHaveLength(2)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.file_operation).toHaveLength(6)
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.skill_operation).toHaveLength(1)
  })

  it('admits both Session Plan capabilities to remembered permission scopes', () => {
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.mcp_tool).toEqual(
      expect.arrayContaining([
        'mcp:purescience_plan/generate_plan',
        'mcp:purescience_plan/update_step_status'
      ])
    )
  })

  it('does not expose internal Reviewer MCP identities', () => {
    expect(JSON.stringify(PRE_REGISTERED_PERMISSION_IDENTITIES)).not.toMatch(/review/i)
  })
})
