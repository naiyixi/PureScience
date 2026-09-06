// Managed-endpoint MCP server unit tests: contract surface (server name/arg/env wiring) and
// tool-name identity, mirroring the routine MCP server test style. Handler round-trips are
// covered by the repository + manager tests; the stdio transport is exercised by the app
// integration path.

import { describe, expect, it, vi } from 'vitest'

import {
  ENDPOINT_FREE_PORT_TOOL_NAME,
  ENDPOINT_LIST_TOOL_NAME,
  ENDPOINT_MCP_SERVER_ARG,
  ENDPOINT_MCP_SERVER_NAME,
  ENDPOINT_REGISTER_TOOL_NAME,
  ENDPOINT_START_TOOL_NAME,
  ENDPOINT_STATUS_TOOL_NAME,
  ENDPOINT_STOP_TOOL_NAME,
  ENDPOINT_UNREGISTER_TOOL_NAME,
  createEndpointMcpServer,
  createEndpointMcpServerConfig
} from './endpoint-mcp-server'
import type { ManagedEndpoint } from '../../shared/endpoint'

const makeEndpoint = (overrides: Partial<ManagedEndpoint> = {}): ManagedEndpoint => ({
  name: 'esm-fold',
  url: 'http://127.0.0.1:20001',
  port: 20001,
  skillName: 'esm-runbook',
  startScript: 'docker start esm-fold',
  stopScript: 'docker stop esm-fold',
  livePath: '/health/ready',
  approvedScriptHash: 'a'.repeat(64),
  state: 'stopped',
  stateChangedAt: null,
  lastError: null,
  transcript: null,
  createdAt: 1_000_000,
  updatedAt: 1_000_000,
  ...overrides
})

describe('endpoint MCP server contract', () => {
  it('names the server and the seven tools', () => {
    expect(ENDPOINT_MCP_SERVER_NAME).toBe('purescience-endpoints')
    expect(ENDPOINT_MCP_SERVER_ARG).toBe('--purescience-endpoint-mcp')
    expect(ENDPOINT_REGISTER_TOOL_NAME).toBe('endpoint_register')
    expect(ENDPOINT_UNREGISTER_TOOL_NAME).toBe('endpoint_unregister')
    expect(ENDPOINT_START_TOOL_NAME).toBe('endpoint_start')
    expect(ENDPOINT_STOP_TOOL_NAME).toBe('endpoint_stop')
    expect(ENDPOINT_STATUS_TOOL_NAME).toBe('endpoint_status')
    expect(ENDPOINT_LIST_TOOL_NAME).toBe('endpoint_list')
    expect(ENDPOINT_FREE_PORT_TOOL_NAME).toBe('endpoint_free_port')
  })

  it('registers the tools with their handler wiring', async () => {
    const handler = {
      register: vi.fn(async () => ({ endpoint: makeEndpoint(), newlyApproved: true })),
      unregister: vi.fn(async () => ({ removed: true })),
      start: vi.fn(async () => ({ endpoint: makeEndpoint({ state: 'live' }) })),
      stop: vi.fn(async () => ({ endpoint: makeEndpoint() })),
      status: vi.fn(async () => ({ endpoint: makeEndpoint() })),
      list: vi.fn(async () => ({ endpoints: [makeEndpoint()] })),
      freePort: vi.fn(async () => ({ port: 20042 }))
    }
    const server = createEndpointMcpServer(handler)
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    expect(Object.keys(tools)).toHaveLength(7)
    expect(handler.freePort).not.toHaveBeenCalled()
  })

  it('builds a stdio server config with the endpoint env', () => {
    const config = createEndpointMcpServerConfig({
      command: '/usr/local/bin/purescience',
      entryPath: '/app/out/main/index.js',
      endpoint: 'http://127.0.0.1:8642',
      token: 'tok-123',
      sessionId: 'session-9'
    })
    expect(config.name).toBe('purescience-endpoints')
    expect(config.args).toEqual(['/app/out/main/index.js', '--purescience-endpoint-mcp'])
    const env = Object.fromEntries((config.env ?? []).map((entry) => [entry.name, entry.value]))
    expect(env.PURESCIENCE_ENDPOINT_RPC_ENDPOINT).toBe('http://127.0.0.1:8642')
    expect(env.PURESCIENCE_ENDPOINT_RPC_TOKEN).toBe('tok-123')
    expect(env.PURESCIENCE_ENDPOINT_SESSION_ID).toBe('session-9')
  })

  it('round-trips a register call through the handler', async () => {
    const handler = {
      register: vi.fn(async () => ({ endpoint: makeEndpoint(), newlyApproved: true })),
      unregister: vi.fn(async () => ({ removed: true })),
      start: vi.fn(async () => ({ endpoint: makeEndpoint({ state: 'live' }) })),
      stop: vi.fn(async () => ({ endpoint: makeEndpoint() })),
      status: vi.fn(async () => ({ endpoint: makeEndpoint() })),
      list: vi.fn(async () => ({ endpoints: [makeEndpoint()] })),
      freePort: vi.fn(async () => ({ port: 20042 }))
    }
    const server = createEndpointMcpServer(handler)
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    const registerTool = tools[ENDPOINT_REGISTER_TOOL_NAME] as {
      handler: (
        input: Record<string, unknown>
      ) => Promise<{ content: { type: string; text: string }[] }>
    }
    const result = await registerTool.handler({
      name: 'esm-fold',
      url: 'http://127.0.0.1:20001',
      skill_name: 'esm-runbook',
      start: 'docker start esm-fold',
      stop: 'docker stop esm-fold',
      live: '/health/ready'
    })
    expect(handler.register).toHaveBeenCalledWith({
      name: 'esm-fold',
      url: 'http://127.0.0.1:20001',
      skillName: 'esm-runbook',
      startScript: 'docker start esm-fold',
      stopScript: 'docker stop esm-fold',
      livePath: '/health/ready',
      credentialName: undefined
    })
    expect(result.content[0]?.text).toContain('newlyApproved')
  })
})
