// Agent-facing context-summary MCP server: lets the agent query folded-away context chunks
// (summary_query) and mark task boundaries (boundary) during a session. The MCP process runs as a
// stdio child of the agent; chunk persistence happens in the main process over the app's local RPC
// gateway (same pattern as memory + skill-import), so the session store keeps a single writer.
//
// Chunks are immutable once written: a summary_query answers against the ORIGINAL transcript text
// captured at fold time, so a later transcript edit can never rewrite audit evidence.

import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  BOUNDARY_TOOL_DESCRIPTION,
  BOUNDARY_TOOL_NAME,
  CONTEXT_SUMMARY_MCP_SERVER_NAME,
  SUMMARY_QUERY_TOOL_DESCRIPTION,
  SUMMARY_QUERY_TOOL_NAME
} from '../../shared/context-summary-mcp'
import { fetchLocalRpc, type LocalRpcTransport } from '../local-rpc-transport'
import { CONTEXT_SUMMARY_MCP_SERVER_ARG } from '../mcp-server-args'

const summaryQueryToolSchema = {
  summary_id: z
    .string()
    .min(1)
    .describe('The <summary id=…> of the folded chunk to query, e.g. "fold-1234".'),
  question: z
    .string()
    .min(1)
    .max(2000)
    .describe('What you need from the original chunk. Ask for the exact detail (a value, a name, a decision).')
}
const summaryQueryToolDefinition = {
  title: 'Query a folded context chunk',
  description: SUMMARY_QUERY_TOOL_DESCRIPTION,
  inputSchema: summaryQueryToolSchema
}

const boundaryToolSchema = {
  label: z
    .string()
    .min(1)
    .max(200)
    .describe('A short label for the work that just closed, e.g. "finished variant filtering".')
}
const boundaryToolDefinition = {
  title: 'Mark a task boundary',
  description: BOUNDARY_TOOL_DESCRIPTION,
  inputSchema: boundaryToolSchema
}

export type SummaryQueryResult = {
  found: boolean
  summaryId?: string
  // The exact answer text (matching excerpt from the chunk's original transcript).
  answer?: string
  // The full chunk summary (the <summary id=…> block) for context.
  summaryText?: string
  reason?: string
}

type SummaryBoundaryResult = {
  recorded: boolean
  boundaryId?: string
  reason?: string
}

export type ContextSummaryMcpEnvironment = {
  endpoint: string
  socketPath?: string
  token: string
  sessionId: string
}

export type ContextSummaryRpcConnection = LocalRpcTransport & {
  token: string
  release?: () => void
}

type ContextSummaryMcpHandler = {
  queryChunk: (summaryId: string, question: string) => Promise<SummaryQueryResult>
  recordBoundary: (label: string) => Promise<SummaryBoundaryResult>
}

type ContextSummaryMcpServerConfigRequest = ContextSummaryMcpEnvironment & {
  command: string
  entryPath: string
}

type RpcResponse = {
  result?: SummaryQueryResult | SummaryBoundaryResult
  error?: string
}

const createContextSummaryMcpServer = (
  handler: ContextSummaryMcpHandler
): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: CONTEXT_SUMMARY_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(SUMMARY_QUERY_TOOL_NAME, summaryQueryToolDefinition, async (input) => {
    const result = await handler.queryChunk(input.summary_id.trim(), input.question.trim())
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  server.registerTool(BOUNDARY_TOOL_NAME, boundaryToolDefinition, async (input) => {
    const result = await handler.recordBoundary(input.label.trim())
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  return server
}

const createContextSummaryMcpServerConfig = ({
  command,
  entryPath,
  endpoint,
  socketPath,
  token,
  sessionId
}: ContextSummaryMcpServerConfigRequest): McpServerStdio => ({
  name: CONTEXT_SUMMARY_MCP_SERVER_NAME,
  command,
  args: [entryPath, CONTEXT_SUMMARY_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'PURESCIENCE_CONTEXT_SUMMARY_RPC_ENDPOINT', value: endpoint },
    ...(socketPath
      ? [{ name: 'PURESCIENCE_CONTEXT_SUMMARY_RPC_SOCKET_PATH', value: socketPath }]
      : []),
    { name: 'PURESCIENCE_CONTEXT_SUMMARY_RPC_TOKEN', value: token },
    { name: 'PURESCIENCE_CONTEXT_SUMMARY_SESSION_ID', value: sessionId }
  ]
})

const requireEnvironmentVariable = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Missing context-summary MCP environment variable: ${name}`)
  return value
}

const createContextSummaryMcpEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): ContextSummaryMcpEnvironment => ({
  endpoint: requireEnvironmentVariable(env, 'PURESCIENCE_CONTEXT_SUMMARY_RPC_ENDPOINT'),
  socketPath: env.PURESCIENCE_CONTEXT_SUMMARY_RPC_SOCKET_PATH,
  token: requireEnvironmentVariable(env, 'PURESCIENCE_CONTEXT_SUMMARY_RPC_TOKEN'),
  sessionId: requireEnvironmentVariable(env, 'PURESCIENCE_CONTEXT_SUMMARY_SESSION_ID')
})

const callSummaryQueryRpc = async (
  environment: ContextSummaryMcpEnvironment,
  summaryId: string,
  question: string
): Promise<SummaryQueryResult> => {
  const response = await fetchLocalRpc(
    environment,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'summaryQueryChunk',
        params: { sessionId: environment.sessionId, summaryId, question }
      })
    },
    'Context-summary query RPC'
  )
  const payload = (await response.json()) as RpcResponse

  if (!response.ok || payload.error || !payload.result) {
    throw new Error(payload.error ?? `Context-summary query RPC failed with status ${response.status}`)
  }
  return payload.result as SummaryQueryResult
}

const callRecordBoundaryRpc = async (
  environment: ContextSummaryMcpEnvironment,
  label: string
): Promise<SummaryBoundaryResult> => {
  const response = await fetchLocalRpc(
    environment,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'recordBoundary',
        params: { sessionId: environment.sessionId, label }
      })
    },
    'Context-summary boundary RPC'
  )
  const payload = (await response.json()) as RpcResponse

  if (!response.ok || payload.error || !payload.result) {
    throw new Error(payload.error ?? `Context-summary boundary RPC failed with status ${response.status}`)
  }
  return payload.result as SummaryBoundaryResult
}

const runContextSummaryMcpServer = async (
  environment = createContextSummaryMcpEnvironmentFromProcess()
): Promise<void> => {
  const server = createContextSummaryMcpServer({
    queryChunk: (summaryId, question) => callSummaryQueryRpc(environment, summaryId, question),
    recordBoundary: (label) => callRecordBoundaryRpc(environment, label)
  })
  await server.connect(new StdioServerTransport())
}

export {
  CONTEXT_SUMMARY_MCP_SERVER_ARG,
  CONTEXT_SUMMARY_MCP_SERVER_NAME,
  SUMMARY_QUERY_TOOL_NAME,
  BOUNDARY_TOOL_NAME,
  summaryQueryToolDefinition,
  boundaryToolDefinition,
  createContextSummaryMcpEnvironmentFromProcess,
  createContextSummaryMcpServer,
  createContextSummaryMcpServerConfig,
  runContextSummaryMcpServer
}
export type { ContextSummaryMcpHandler }
