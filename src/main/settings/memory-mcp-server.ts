// Agent-facing memory MCP server: lets the agent save a note into the user's memory during a
// session. The MCP process runs as a stdio child of the agent; persistence happens in the main
// process over the app's local RPC gateway (same pattern as skill-import), so the settings
// repository keeps a single writer and all sanitization/dedup rules stay in one place.

import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  MEMORY_MCP_SERVER_NAME,
  MEMORY_SAVE_NOTE_TOOL_DESCRIPTION,
  MEMORY_SAVE_NOTE_TOOL_NAME
} from '../../shared/memory-mcp'
import { fetchLocalRpc, type LocalRpcTransport } from '../local-rpc-transport'
import { MEMORY_MCP_SERVER_ARG } from '../mcp-server-args'

const memorySaveNoteToolSchema = {
  category_name: z
    .string()
    .min(1)
    .max(80)
    .describe('Exact name of an existing memory category, e.g. "About you".'),
  text: z
    .string()
    .min(1)
    .max(4000)
    .describe('The note to remember. Keep it concise and self-contained.'),
  evidence: z
    .string()
    .max(500)
    .optional()
    .describe('Optional short source note for provenance — e.g. which artifact, file, or session the fact came from.')
}
const memorySaveNoteToolDefinition = {
  title: 'Save a memory note',
  description: MEMORY_SAVE_NOTE_TOOL_DESCRIPTION,
  inputSchema: memorySaveNoteToolSchema
}

type MemorySaveNoteResult = {
  saved: boolean
  categoryId?: string
  noteId?: string
  reason?: string
}

export type MemoryRpcConnection = LocalRpcTransport & {
  token: string
  release?: () => void
}

type MemoryMcpEnvironment = MemoryRpcConnection & {
  sessionId: string
}

type MemoryMcpHandler = {
  saveNote: (
    categoryName: string,
    text: string,
    evidence?: string
  ) => Promise<MemorySaveNoteResult>
}

type MemoryMcpServerConfigRequest = MemoryMcpEnvironment & {
  command: string
  entryPath: string
}

type RpcResponse = {
  result?: MemorySaveNoteResult
  error?: string
}

const createMemoryMcpServer = (handler: MemoryMcpHandler): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: MEMORY_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(MEMORY_SAVE_NOTE_TOOL_NAME, memorySaveNoteToolDefinition, async (input) => {
    const evidence = typeof input.evidence === 'string' ? input.evidence.trim() : undefined
    const result = await handler.saveNote(
      input.category_name.trim(),
      input.text.trim(),
      evidence || undefined
    )
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  return server
}

const createMemoryMcpServerConfig = ({
  command,
  entryPath,
  endpoint,
  socketPath,
  token,
  sessionId
}: MemoryMcpServerConfigRequest): McpServerStdio => ({
  name: MEMORY_MCP_SERVER_NAME,
  command,
  args: [entryPath, MEMORY_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'PURESCIENCE_MEMORY_RPC_ENDPOINT', value: endpoint },
    ...(socketPath
      ? [{ name: 'PURESCIENCE_MEMORY_RPC_SOCKET_PATH', value: socketPath }]
      : []),
    { name: 'PURESCIENCE_MEMORY_RPC_TOKEN', value: token },
    { name: 'PURESCIENCE_MEMORY_SESSION_ID', value: sessionId }
  ]
})

const requireEnvironmentVariable = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Missing memory MCP environment variable: ${name}`)
  return value
}

const createMemoryMcpEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): MemoryMcpEnvironment => ({
  endpoint: requireEnvironmentVariable(env, 'PURESCIENCE_MEMORY_RPC_ENDPOINT'),
  socketPath: env.PURESCIENCE_MEMORY_RPC_SOCKET_PATH,
  token: requireEnvironmentVariable(env, 'PURESCIENCE_MEMORY_RPC_TOKEN'),
  sessionId: requireEnvironmentVariable(env, 'PURESCIENCE_MEMORY_SESSION_ID')
})

const callMemorySaveNoteRpc = async (
  environment: MemoryMcpEnvironment,
  categoryName: string,
  text: string,
  evidence?: string
): Promise<MemorySaveNoteResult> => {
  const response = await fetchLocalRpc(
    environment,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'memorySaveNote',
        params: { sessionId: environment.sessionId, categoryName, text, evidence }
      })
    },
    'Memory save-note RPC'
  )
  const payload = (await response.json()) as RpcResponse

  if (!response.ok || payload.error || !payload.result) {
    throw new Error(payload.error ?? `Memory save-note RPC failed with status ${response.status}`)
  }
  return payload.result
}

const runMemoryMcpServer = async (
  environment = createMemoryMcpEnvironmentFromProcess()
): Promise<void> => {
  const server = createMemoryMcpServer({
    saveNote: (categoryName, text, evidence) =>
      callMemorySaveNoteRpc(environment, categoryName, text, evidence)
  })
  await server.connect(new StdioServerTransport())
}

export {
  MEMORY_MCP_SERVER_ARG,
  MEMORY_MCP_SERVER_NAME,
  MEMORY_SAVE_NOTE_TOOL_NAME,
  createMemoryMcpEnvironmentFromProcess,
  createMemoryMcpServer,
  createMemoryMcpServerConfig,
  memorySaveNoteToolDefinition,
  memorySaveNoteToolSchema,
  runMemoryMcpServer
}
export type { MemoryMcpEnvironment, MemoryMcpHandler, MemorySaveNoteResult }
