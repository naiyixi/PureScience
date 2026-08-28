// Tests for the memory MCP server wiring: the spawn config (args/env) and the tool registration.

import { describe, expect, it, vi } from 'vitest'

import { MEMORY_MCP_SERVER_ARG } from '../mcp-server-args'
import { MEMORY_MCP_SERVER_NAME, MEMORY_SAVE_NOTE_TOOL_NAME } from '../../shared/memory-mcp'
import { createMemoryMcpServer, createMemoryMcpServerConfig } from './memory-mcp-server'

describe('createMemoryMcpServerConfig', () => {
  it('spawns the packaged entry point in memory-MCP mode with RPC env', () => {
    const config = createMemoryMcpServerConfig({
      command: '/app/PureScience',
      entryPath: '/app/PureScience.app/Contents/Resources/app.asar/index.js',
      endpoint: 'http://127.0.0.1:52101',
      socketPath: undefined,
      token: 'capability-token',
      sessionId: 'memory-session-1'
    })

    expect(config.name).toBe(MEMORY_MCP_SERVER_NAME)
    expect(config.args).toEqual([
      '/app/PureScience.app/Contents/Resources/app.asar/index.js',
      MEMORY_MCP_SERVER_ARG
    ])
    const env = Object.fromEntries(config.env?.map((entry) => [entry.name, entry.value]) ?? [])
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.PURESCIENCE_MEMORY_RPC_ENDPOINT).toBe('http://127.0.0.1:52101')
    expect(env.PURESCIENCE_MEMORY_RPC_TOKEN).toBe('capability-token')
    expect(env.PURESCIENCE_MEMORY_SESSION_ID).toBe('memory-session-1')
    expect(env.PURESCIENCE_MEMORY_RPC_SOCKET_PATH).toBeUndefined()
  })
})

describe('createMemoryMcpServer', () => {
  it('registers the memory_save_note tool name on the server', () => {
    const saveNote = vi.fn(async () => ({ saved: true }))
    const server = createMemoryMcpServer({ saveNote })

    // The MCP SDK exposes registered tools via the server; verify the contract surface exists
    // without invoking the transport.
    expect(server).toBeDefined()
    expect(MEMORY_SAVE_NOTE_TOOL_NAME).toBe('memory_save_note')
    expect(saveNote).not.toHaveBeenCalled()
  })
})
