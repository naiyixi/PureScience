import { describe, expect, it } from 'vitest'

import {
  ACTIVITY_GROUP_MCP_SERVER_NAME,
  BEGIN_ACTIVITY_GROUP_TOOL_NAME,
  getActivityGroupTitleFromToolEvent,
  isActivityGroupToolEvent
} from '../../shared/activity-groups'
import { FIGURE_MCP_SERVER_NAME } from '../../shared/figure'
import { MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp'
import { SKILL_IMPORT_MCP_SERVER_NAME } from '../../shared/skill-import'
import { ARTIFACT_MCP_SERVER_NAME } from '../artifacts/mcp-server'
import { NOTEBOOK_MCP_SERVER_NAME } from '../notebook/mcp-server'
import { PLAN_MCP_SERVER_NAME } from '../session-plan/plan-mcp-server'
import { PRE_REGISTERED_PERMISSION_IDENTITIES } from '../permission-grants/identity-catalog'
import { SESSION_PLAN_SYSTEM_PROMPT_APPEND } from '../session-plan/guidance'
import {
  appMcpToolIdentities,
  appMcpServerAliases,
  renderAppMcpToolReferences,
  resolveCanonicalMcpToolIdentity
} from './app-mcp-names'

const APP_MCP_CODEC_CASES = appMcpToolIdentities().flatMap((identity) => {
  const separator = identity.indexOf('/')
  const server = identity.slice(0, separator)
  const tool = identity.slice(separator + 1)
  const safeServer = server.replace(/[^a-zA-Z0-9_]/g, '_')
  return [
    [server, `mcp__${safeServer}__${tool}`, identity],
    [server, `mcp.${server}.${tool}`, identity],
    [server, `${safeServer}_${tool}`, identity]
  ] as const
})

describe('resolveCanonicalMcpToolIdentity', () => {
  it('keeps the app MCP inventory aligned with the remembered-permission catalog', () => {
    expect(PRE_REGISTERED_PERMISSION_IDENTITIES.mcp_tool.toSorted()).toEqual(
      appMcpToolIdentities()
        .map((identity) => `mcp:${identity}`)
        .toSorted()
    )
  })

  it('documents complete generation and approval call shapes', () => {
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'generation supplies all four Plan fields (`task_summary`, `phases`, `desired_outputs`, and `feasibility`) in one call'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'call `generate_plan` again with only `decision: "approved"` or `decision: "rejected"`'
    )
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'Never call `update_step_status` while approval is pending'
    )
  })

  it('keeps Conversation Turn completion independent from Session Plan status', () => {
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).not.toContain('Do not call `end_turn`')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).not.toContain('do not end the turn')
    expect(SESSION_PLAN_SYSTEM_PROMPT_APPEND).toContain(
      'If an irreversible blocker makes later steps unreachable'
    )
  })

  it.each([
    [
      'claude-code',
      'mcp__purescience_plan__generate_plan',
      'mcp__purescience_plan__update_step_status'
    ],
    ['codex', 'generate_plan', 'update_step_status'],
    ['opencode', 'purescience_plan_generate_plan', 'purescience_plan_update_step_status']
  ] as const)(
    'renders the same planning policy with callable names for %s',
    (frameworkId, generateTool, updateTool) => {
      const guidance = renderAppMcpToolReferences(frameworkId, SESSION_PLAN_SYSTEM_PROMPT_APPEND)

      expect(guidance).toContain('genuinely multi-stage')
      expect(guidance).toContain('discover applicable skills before generating')
      expect(guidance).toContain(generateTool)
      expect(guidance).toContain(updateTool)
      expect(guidance).toContain('Do not generate a Plan for simple')
      expect(guidance).not.toContain('get_active_plan')
      expect(guidance).not.toContain('Plan mode')
    }
  )

  it.each([
    'mcp__purescience-notebook__notebook_execute',
    'mcp__purescience_notebook__notebook_execute',
    'mcp__purescience__notebook__notebook_execute',
    'mcp.purescience-notebook.notebook_execute',
    'purescience_notebook_notebook_execute'
  ])('normalizes a configured framework alias %s', (reportedName) => {
    // The configured name is the pre-rename spelling on purpose: a grant or config written before the
    // rename still has to resolve to the same identity.
    expect(resolveCanonicalMcpToolIdentity(reportedName, ['purescience-notebook'])).toBe(
      'purescience_notebook/notebook_execute'
    )
  })

  it('resolves a call whose server name had its hyphen escaped as a separator', () => {
    expect(
      resolveCanonicalMcpToolIdentity('mcp__purescience__notebook__notebook_execute', [
        'purescience_notebook'
      ])
    ).toBe('purescience_notebook/notebook_execute')
  })

  it('does not turn an unregistered Claude MCP prefix into durable identity', () => {
    expect(
      resolveCanonicalMcpToolIdentity('mcp__reported-only__dangerous_tool', [])
    ).toBeUndefined()
  })

  it.each(APP_MCP_CODEC_CASES)(
    'maps every registered app MCP identity from %s using provider name %s',
    (server, reportedName, identity) => {
      expect(resolveCanonicalMcpToolIdentity(reportedName, [server])).toBe(identity)
    }
  )

  it('normalizes framework-safe aliases for configured dynamic servers', () => {
    expect(appMcpServerAliases('custom-server')).toEqual(['custom-server', 'custom_server'])
    expect(resolveCanonicalMcpToolIdentity('mcp__custom_server__lookup', ['custom-server'])).toBe(
      'custom-server/lookup'
    )
    expect(resolveCanonicalMcpToolIdentity('mcp.custom_server.lookup', ['custom-server'])).toBe(
      'custom-server/lookup'
    )
    expect(resolveCanonicalMcpToolIdentity('custom_server_lookup', ['custom-server'])).toBe(
      'custom-server/lookup'
    )
  })

  it('rejects a sanitized dynamic server alias when configured names collide', () => {
    expect(
      resolveCanonicalMcpToolIdentity('mcp__custom_server__lookup', [
        'custom-server',
        'custom_server'
      ])
    ).toBeUndefined()
  })

  // A hyphen in a server name is rendered as one underscore by one framework and as two by another, so
  // the agent was handed two different callable names for the same tool and guessed wrong: the real log
  // has failed calls whose only difference from a real tool was the separator.
  it('keeps every app-owned MCP server name separator-free', () => {
    const declared = appMcpToolIdentities().map((identity) =>
      identity.slice(0, identity.indexOf('/'))
    )
    expect(declared.filter((name) => name.includes('-'))).toEqual([])
    expect(FIGURE_MCP_SERVER_NAME).not.toContain('-')
  })

  it('registers each app-owned MCP server under the name this module declares', () => {
    const declared = new Set(
      appMcpToolIdentities().map((identity) => identity.slice(0, identity.indexOf('/')))
    )
    for (const registered of [
      ACTIVITY_GROUP_MCP_SERVER_NAME,
      ARTIFACT_MCP_SERVER_NAME,
      MEMORY_MCP_SERVER_NAME,
      NOTEBOOK_MCP_SERVER_NAME,
      PLAN_MCP_SERVER_NAME,
      SKILL_IMPORT_MCP_SERVER_NAME
    ]) {
      expect(declared.has(registered)).toBe(true)
    }
  })

  it('resolves a spelling written before the rename to the same identity', () => {
    for (const identity of appMcpToolIdentities()) {
      const separator = identity.indexOf('/')
      const server = identity.slice(0, separator)
      const tool = identity.slice(separator + 1)
      const legacyServer = server.replace(/_/gu, '-')

      expect(appMcpServerAliases(server)).toContain(legacyServer)
      expect(resolveCanonicalMcpToolIdentity(`mcp__${legacyServer}__${tool}`, [server])).toBe(
        identity
      )
    }
  })

  it('keeps answering to the hyphen spelling of a server it does not declare here', () => {
    expect(appMcpServerAliases(FIGURE_MCP_SERVER_NAME)).toContain('purescience-figure')
  })

  // The activity-group matcher lives in shared/ and carries its own copy of the old spelling, because
  // shared code cannot import this module. These assertions are what keep that copy a reflection of the
  // alias list instead of a second guess: the legacy name is taken from here, and the matcher has to
  // accept it — a rename that silently dropped the old spelling would stop recognising activity the
  // user already has.
  it('still recognises an activity group call made under the pre-rename server spelling', () => {
    const legacyServer = appMcpServerAliases(ACTIVITY_GROUP_MCP_SERVER_NAME).find((alias) =>
      alias.includes('-')
    )
    expect(legacyServer).toBeDefined()

    expect(
      isActivityGroupToolEvent({
        providerToolName: `mcp__${legacyServer}__${BEGIN_ACTIVITY_GROUP_TOOL_NAME}`
      })
    ).toBe(true)
    expect(
      getActivityGroupTitleFromToolEvent({
        rawInput: {
          server: legacyServer,
          tool: BEGIN_ACTIVITY_GROUP_TOOL_NAME,
          arguments: { title: 'Recorded before the rename' }
        }
      })
    ).toBe('Recorded before the rename')
  })
})
