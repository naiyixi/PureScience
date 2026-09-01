// Agent-facing annotation MCP server: lets the agent attach labeled notes to files
// (annotation_set), list them (annotation_list), and remove them (annotation_remove). The MCP
// process runs as a stdio child of the agent; persistence lives in the main process over the
// app's local RPC gateway (same pattern as memory / routine / endpoints), so the store keeps a
// single writer.

import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  ANNOTATION_LIST_TOOL_DESCRIPTION,
  ANNOTATION_LIST_TOOL_NAME,
  ANNOTATION_MCP_SERVER_NAME,
  ANNOTATION_REMOVE_TOOL_DESCRIPTION,
  ANNOTATION_REMOVE_TOOL_NAME,
  ANNOTATION_SET_TOOL_DESCRIPTION,
  ANNOTATION_SET_TOOL_NAME,
  ANNOTATION_LABELS
} from '../../shared/annotation'
import type {
  AnnotationListResult,
  AnnotationRemoveResult,
  AnnotationSetRequest,
  AnnotationSetResult
} from '../../shared/annotation'
import { fetchLocalRpc, type LocalRpcTransport } from '../local-rpc-transport'
import { ANNOTATION_MCP_SERVER_ARG } from '../mcp-server-args'

const annotationSetToolSchema = {
  target: z
    .string()
    .min(1)
    .max(4096)
    .describe('File path relative to the project root (e.g. "src/main.ts").'),
  label: z
    .enum(ANNOTATION_LABELS)
    .describe('Annotation label: todo, question, important, note, review.'),
  note: z
    .string()
    .min(1)
    .max(4000)
    .describe('Short note (a few sentences max). Replaces the previous note for the same label.'),
  file_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional()
    .describe('Optional sha256 of the annotated file content — anchors the note to that exact content.')
}
const annotationSetToolDefinition = {
  title: 'Annotate a file',
  description: ANNOTATION_SET_TOOL_DESCRIPTION,
  inputSchema: annotationSetToolSchema
}

const annotationListToolSchema = {
  target: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe('Optional file path to filter to; omit for all annotations in the project.')
}
const annotationListToolDefinition = {
  title: 'List file annotations',
  description: ANNOTATION_LIST_TOOL_DESCRIPTION,
  inputSchema: annotationListToolSchema
}

const annotationRemoveToolSchema = {
  annotation_id: z.string().min(1).describe('Annotation id from annotation_list.')
}
const annotationRemoveToolDefinition = {
  title: 'Remove a file annotation',
  description: ANNOTATION_REMOVE_TOOL_DESCRIPTION,
  inputSchema: annotationRemoveToolSchema
}

export type AnnotationMcpEnvironment = {
  endpoint: string
  socketPath?: string
  token: string
  sessionId: string
  projectId: string
}

export type AnnotationRpcConnection = LocalRpcTransport & {
  token: string
  release?: () => void
}

type AnnotationMcpHandler = {
  set: (request: AnnotationSetRequest) => Promise<AnnotationSetResult>
  list: (target?: string) => Promise<AnnotationListResult>
  remove: (annotationId: string) => Promise<AnnotationRemoveResult>
}

type AnnotationMcpServerConfigRequest = AnnotationMcpEnvironment & {
  command: string
  entryPath: string
}

type RpcResponse = {
  result?: AnnotationSetResult | AnnotationListResult | AnnotationRemoveResult
  error?: string
}

const createAnnotationMcpServer = (handler: AnnotationMcpHandler): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: ANNOTATION_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(ANNOTATION_SET_TOOL_NAME, annotationSetToolDefinition, async (input) => {
    const result = await handler.set({
      target: input.target,
      label: input.label,
      note: input.note,
      fileSha256: input.file_sha256
    })
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  server.registerTool(ANNOTATION_LIST_TOOL_NAME, annotationListToolDefinition, async (input) => {
    const result = await handler.list(input.target)
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  server.registerTool(ANNOTATION_REMOVE_TOOL_NAME, annotationRemoveToolDefinition, async (input) => {
    const result = await handler.remove(input.annotation_id)
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  return server
}

const createAnnotationMcpServerConfig = ({
  command,
  entryPath,
  endpoint,
  socketPath,
  token,
  sessionId,
  projectId
}: AnnotationMcpServerConfigRequest): McpServerStdio => ({
  name: ANNOTATION_MCP_SERVER_NAME,
  command,
  args: [entryPath, ANNOTATION_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'PURESCIENCE_ANNOTATION_RPC_ENDPOINT', value: endpoint },
    ...(socketPath
      ? [{ name: 'PURESCIENCE_ANNOTATION_RPC_SOCKET_PATH', value: socketPath }]
      : []),
    { name: 'PURESCIENCE_ANNOTATION_RPC_TOKEN', value: token },
    { name: 'PURESCIENCE_ANNOTATION_SESSION_ID', value: sessionId },
    { name: 'PURESCIENCE_ANNOTATION_PROJECT_ID', value: projectId }
  ]
})

const requireEnvironmentVariable = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Missing annotation MCP environment variable: ${name}`)
  return value
}

const createAnnotationMcpEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): AnnotationMcpEnvironment => ({
  endpoint: requireEnvironmentVariable(env, 'PURESCIENCE_ANNOTATION_RPC_ENDPOINT'),
  socketPath: env.PURESCIENCE_ANNOTATION_RPC_SOCKET_PATH,
  token: requireEnvironmentVariable(env, 'PURESCIENCE_ANNOTATION_RPC_TOKEN'),
  sessionId: requireEnvironmentVariable(env, 'PURESCIENCE_ANNOTATION_SESSION_ID'),
  projectId: requireEnvironmentVariable(env, 'PURESCIENCE_ANNOTATION_PROJECT_ID')
})

const callAnnotationRpc = async (
  environment: AnnotationMcpEnvironment,
  method: string,
  params: Record<string, unknown>
): Promise<RpcResponse['result']> => {
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
        params: {
          sessionId: environment.sessionId,
          projectId: environment.projectId,
          ...params
        }
      })
    },
    `Annotation ${method} RPC`
  )
  const payload = (await response.json()) as RpcResponse

  if (!response.ok || payload.error || !payload.result) {
    throw new Error(payload.error ?? `Annotation ${method} RPC failed with status ${response.status}`)
  }
  return payload.result
}

const runAnnotationMcpServer = async (
  environment = createAnnotationMcpEnvironmentFromProcess()
): Promise<void> => {
  const server = createAnnotationMcpServer({
    set: (request) =>
      callAnnotationRpc(environment, 'annotationSet', { ...request }) as Promise<AnnotationSetResult>,
    list: (target) =>
      callAnnotationRpc(environment, 'annotationList', {
        target: target ?? null
      }) as Promise<AnnotationListResult>,
    remove: (annotationId) =>
      callAnnotationRpc(environment, 'annotationRemove', {
        annotationId
      }) as Promise<AnnotationRemoveResult>
  })
  await server.connect(new StdioServerTransport())
}

export {
  ANNOTATION_MCP_SERVER_ARG,
  ANNOTATION_MCP_SERVER_NAME,
  ANNOTATION_SET_TOOL_NAME,
  ANNOTATION_LIST_TOOL_NAME,
  ANNOTATION_REMOVE_TOOL_NAME,
  annotationSetToolDefinition,
  annotationListToolDefinition,
  annotationRemoveToolDefinition,
  createAnnotationMcpEnvironmentFromProcess,
  createAnnotationMcpServer,
  createAnnotationMcpServerConfig,
  runAnnotationMcpServer
}
export type { AnnotationMcpHandler }
