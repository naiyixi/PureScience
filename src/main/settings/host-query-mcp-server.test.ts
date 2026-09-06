// Host-query MCP server unit tests: contract surface (server name/arg/env wiring) and tool
// identity, mirroring the figure MCP server test style.

import { describe, expect, it, vi } from 'vitest'

import {
  HOST_QUERY_MCP_SERVER_ARG,
  HOST_QUERY_MCP_SERVER_NAME,
  HOST_QUERY_TOOL_NAME,
  createHostQueryMcpServer,
  createHostQueryMcpServerConfig
} from './host-query-mcp-server'

describe('host-query MCP server contract', () => {
  it('names the server and the tool', () => {
    expect(HOST_QUERY_MCP_SERVER_NAME).toBe('purescience-host-query')
    expect(HOST_QUERY_MCP_SERVER_ARG).toBe('--purescience-host-query-mcp')
    expect(HOST_QUERY_TOOL_NAME).toBe('host_query')
  })

  it('registers the tool with its handler wiring', () => {
    const handler = {
      query: vi.fn(async () => ({
        rows: [],
        truncated: false,
        elapsedMs: 1,
        scopedToProject: true
      }))
    }
    const server = createHostQueryMcpServer(handler)
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    expect(Object.keys(tools)).toHaveLength(1)
    expect(handler.query).not.toHaveBeenCalled()
  })

  it('builds a stdio server config with the host-query env', () => {
    const config = createHostQueryMcpServerConfig({
      command: '/usr/local/bin/purescience',
      entryPath: '/app/out/main/index.js',
      endpoint: 'http://127.0.0.1:8642',
      token: 'tok-123',
      sessionId: 'session-9',
      projectId: 'project-1'
    })
    expect(config.name).toBe('purescience-host-query')
    expect(config.args).toEqual(['/app/out/main/index.js', '--purescience-host-query-mcp'])
    const env = Object.fromEntries((config.env ?? []).map((entry) => [entry.name, entry.value]))
    expect(env.PURESCIENCE_HOST_QUERY_RPC_ENDPOINT).toBe('http://127.0.0.1:8642')
    expect(env.PURESCIENCE_HOST_QUERY_PROJECT_ID).toBe('project-1')
  })

  it('round-trips a query call through the handler', async () => {
    const handler = {
      query: vi.fn(async () => ({
        rows: [{ id: 1 }],
        truncated: false,
        elapsedMs: 2,
        scopedToProject: true
      }))
    }
    const server = createHostQueryMcpServer(handler)
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    const queryTool = tools[HOST_QUERY_TOOL_NAME] as {
      handler: (
        input: Record<string, unknown>
      ) => Promise<{ content: { type: string; text: string }[] }>
    }
    const result = await queryTool.handler({ sql: 'SELECT id FROM Review LIMIT 1' })
    expect(handler.query).toHaveBeenCalledWith('SELECT id FROM Review LIMIT 1')
    expect(result.content[0]?.text).toContain('scopedToProject')
  })
})
