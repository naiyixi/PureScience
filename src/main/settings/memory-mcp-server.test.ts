// Tests for the memory MCP server wiring: the spawn config (args/env) and the tool registration.

import { describe, expect, it, vi } from 'vitest'

import { MEMORY_MCP_SERVER_ARG } from '../mcp-server-args'
import {
  CHECKPOINT_LOAD_TOOL_NAME,
  CHECKPOINT_SAVE_TOOL_NAME,
  MEMORY_MCP_SERVER_NAME,
  MEMORY_MCP_SYSTEM_PROMPT_APPEND,
  MEMORY_SAVE_NOTE_TOOL_DESCRIPTION,
  MEMORY_SAVE_NOTE_TOOL_NAME
} from '../../shared/memory-mcp'
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
    const checkpointSave = vi.fn(async () => ({ saved: true }))
    const checkpointLoad = vi.fn(async () => ({ checkpoint: null }))
    const server = createMemoryMcpServer({ saveNote, checkpointSave, checkpointLoad })

    // The MCP SDK exposes registered tools via the server; verify the contract surface exists
    // without invoking the transport.
    expect(server).toBeDefined()
    expect(MEMORY_SAVE_NOTE_TOOL_NAME).toBe('memory_save_note')
    expect(CHECKPOINT_SAVE_TOOL_NAME).toBe('checkpoint_save')
    expect(CHECKPOINT_LOAD_TOOL_NAME).toBe('checkpoint_load')
    expect(saveNote).not.toHaveBeenCalled()
    expect(checkpointSave).not.toHaveBeenCalled()
    expect(checkpointLoad).not.toHaveBeenCalled()
  })

  // Invitation mode: memory is opt-in, so a refusal is a user choice. The fact must not vanish — the
  // model gets the reason plus a ready-made offer to relay, and is told not to retry or smuggle the
  // fact somewhere else.
  it('passes a refused save (memory off) through with the offer to enable it', async () => {
    const saveNote = vi.fn(async () => ({
      saved: false,
      reason: 'memory-disabled',
      suggest: 'enable-memory',
      userAction:
        'Memory is off, so nothing was saved. It can be turned on in Settings \u2192 Memory.'
    }))
    const server = createMemoryMcpServer({
      saveNote,
      checkpointSave: vi.fn(async () => ({ saved: true })),
      checkpointLoad: vi.fn(async () => ({ checkpoint: null }))
    })
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
    const tool = tools[MEMORY_SAVE_NOTE_TOOL_NAME] as {
      handler: (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
    }

    const response = await tool.handler({
      category_name: 'About you',
      text: 'Prefers concise answers'
    })
    const payload = JSON.parse(response.content[0]?.text ?? '{}') as Record<string, unknown>

    expect(payload.saved).toBe(false)
    expect(payload.suggest).toBe('enable-memory')
    expect(String(payload.userAction)).toContain('Settings')
  })

  it('tells the model to surface the refusal instead of retrying or hiding the fact', () => {
    expect(MEMORY_MCP_SYSTEM_PROMPT_APPEND).toContain('do NOT retry')
    expect(MEMORY_MCP_SYSTEM_PROMPT_APPEND).toContain('Settings \u2192 Memory')
    expect(MEMORY_SAVE_NOTE_TOOL_DESCRIPTION).toContain('relay that to the user')
  })
})
