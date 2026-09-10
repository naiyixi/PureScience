// Agent-facing memory MCP server: lets the agent save a note into the user's memory during a
// session. The MCP process runs as a stdio child of the agent; persistence happens in the main
// process over the app's local RPC gateway (same pattern as skill-import), so the settings
// repository keeps a single writer and all sanitization/dedup rules stay in one place.

import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  CHECKPOINT_LOAD_TOOL_DESCRIPTION,
  CHECKPOINT_LOAD_TOOL_NAME,
  CHECKPOINT_SAVE_TOOL_DESCRIPTION,
  CHECKPOINT_SAVE_TOOL_NAME,
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
    .describe(
      'Optional short source note for provenance — e.g. which artifact, file, or session the fact came from.'
    )
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

const checkpointSaveToolSchema = {
  project_id: z.string().min(1).max(200).describe('Project id the checkpoint belongs to.'),
  active_step: z.string().max(200).optional().describe('What step is in progress right now.'),
  input_fingerprint_inputs: z
    .array(z.string().max(500))
    .max(50)
    .optional()
    .describe('Exact inputs this work depends on (dataset paths, tool/model versions).'),
  verified_facts: z
    .array(
      z.object({
        key: z.string().min(1).max(200),
        value: z.string().min(1).max(2000),
        source: z.string().max(200)
      })
    )
    .max(50)
    .optional()
    .describe('Facts that must not be re-derived, e.g. a resolved identifier and its source.'),
  installed_packages: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        version: z.string().max(100).optional(),
        manager: z.enum(['python', 'r', 'other'])
      })
    )
    .max(50)
    .optional(),
  computed_outputs: z
    .array(
      z.object({
        label: z.string().min(1).max(300),
        path: z.string().max(1000).optional(),
        summary: z.string().max(1000).optional()
      })
    )
    .max(50)
    .optional(),
  notes: z.array(z.string().max(2000)).max(20).optional()
}
const checkpointSaveToolDefinition = {
  title: 'Save task checkpoint',
  description: CHECKPOINT_SAVE_TOOL_DESCRIPTION,
  inputSchema: checkpointSaveToolSchema
}

const checkpointLoadToolSchema = {
  project_id: z.string().min(1).max(200).describe('Project id whose checkpoint to load.'),
  input_fingerprint_inputs: z
    .array(z.string().max(500))
    .max(50)
    .optional()
    .describe('The inputs the upcoming work depends on, so freshness can be judged.')
}
const checkpointLoadToolDefinition = {
  title: 'Load task checkpoint',
  description: CHECKPOINT_LOAD_TOOL_DESCRIPTION,
  inputSchema: checkpointLoadToolSchema
}

export type MemoryRpcConnection = LocalRpcTransport & {
  token: string
  release?: () => void
}

type MemoryMcpEnvironment = MemoryRpcConnection & {
  sessionId: string
}

type CheckpointSaveRequest = {
  projectId: string
  activeStep?: string
  fingerprintInputs?: string[]
  verifiedFacts?: { key: string; value: string; source: string }[]
  installedPackages?: { name: string; version?: string; manager: 'python' | 'r' | 'other' }[]
  computedOutputs?: { label: string; path?: string; summary?: string }[]
  notes?: string[]
}

type CheckpointLoadRequest = {
  projectId: string
  fingerprintInputs?: string[]
}

type MemoryMcpHandler = {
  saveNote: (categoryName: string, text: string, evidence?: string) => Promise<MemorySaveNoteResult>
  checkpointSave: (request: CheckpointSaveRequest) => Promise<unknown>
  checkpointLoad: (request: CheckpointLoadRequest) => Promise<unknown>
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

  server.registerTool(CHECKPOINT_SAVE_TOOL_NAME, checkpointSaveToolDefinition, async (input) => {
    const result = await handler.checkpointSave({
      projectId: input.project_id.trim(),
      activeStep: input.active_step?.trim() || undefined,
      fingerprintInputs: input.input_fingerprint_inputs,
      verifiedFacts: input.verified_facts,
      installedPackages: input.installed_packages,
      computedOutputs: input.computed_outputs,
      notes: input.notes
    })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  })

  server.registerTool(CHECKPOINT_LOAD_TOOL_NAME, checkpointLoadToolDefinition, async (input) => {
    const result = await handler.checkpointLoad({
      projectId: input.project_id.trim(),
      fingerprintInputs: input.input_fingerprint_inputs
    })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
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
    ...(socketPath ? [{ name: 'PURESCIENCE_MEMORY_RPC_SOCKET_PATH', value: socketPath }] : []),
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

const callCheckpointRpc = async (
  environment: MemoryMcpEnvironment,
  method: 'taskCheckpointSave' | 'taskCheckpointLoad',
  params: Record<string, unknown>
): Promise<unknown> => {
  const response = await fetchLocalRpc(
    environment,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method,
        params: { sessionId: environment.sessionId, ...params }
      })
    },
    method === 'taskCheckpointSave' ? 'Task checkpoint save RPC' : 'Task checkpoint load RPC'
  )
  const payload = (await response.json()) as { result?: unknown; error?: string }
  if (!response.ok || payload.error || payload.result === undefined) {
    throw new Error(payload.error ?? `${method} RPC failed with status ${response.status}`)
  }
  return payload.result
}

const runMemoryMcpServer = async (
  environment = createMemoryMcpEnvironmentFromProcess()
): Promise<void> => {
  const server = createMemoryMcpServer({
    saveNote: (categoryName, text, evidence) =>
      callMemorySaveNoteRpc(environment, categoryName, text, evidence),
    checkpointSave: (request) =>
      callCheckpointRpc(environment, 'taskCheckpointSave', {
        projectId: request.projectId,
        activeStep: request.activeStep,
        fingerprintInputs: request.fingerprintInputs,
        verifiedFacts: request.verifiedFacts,
        installedPackages: request.installedPackages,
        computedOutputs: request.computedOutputs,
        notes: request.notes
      }),
    checkpointLoad: (request) =>
      callCheckpointRpc(environment, 'taskCheckpointLoad', {
        projectId: request.projectId,
        fingerprintInputs: request.fingerprintInputs
      })
  })
  await server.connect(new StdioServerTransport())
}

export {
  MEMORY_MCP_SERVER_ARG,
  MEMORY_MCP_SERVER_NAME,
  MEMORY_SAVE_NOTE_TOOL_NAME,
  CHECKPOINT_LOAD_TOOL_NAME,
  CHECKPOINT_SAVE_TOOL_NAME,
  checkpointLoadToolDefinition,
  checkpointSaveToolDefinition,
  createMemoryMcpEnvironmentFromProcess,
  createMemoryMcpServer,
  createMemoryMcpServerConfig,
  memorySaveNoteToolDefinition,
  memorySaveNoteToolSchema,
  runMemoryMcpServer
}
export type {
  CheckpointLoadRequest,
  CheckpointSaveRequest,
  MemoryMcpEnvironment,
  MemoryMcpHandler,
  MemorySaveNoteResult
}
