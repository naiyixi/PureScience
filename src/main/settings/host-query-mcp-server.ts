// Agent-facing host-query MCP server: READ-ONLY database introspection for self-awareness
// (host_query). The MCP process runs as a stdio child of the agent; the query engine lives in
// the main process over the app's local RPC gateway (same pattern as figure/annotation/pdf).

import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  HOST_QUERY_MCP_SERVER_NAME,
  HOST_QUERY_TOOL_DESCRIPTION,
  HOST_QUERY_TOOL_NAME,
  HOST_QUERY_MAX_SQL_LENGTH
} from '../../shared/host-query'
import type { HostQueryResult } from '../../shared/host-query'
import { fetchLocalRpc, type LocalRpcTransport } from '../local-rpc-transport'
import { HOST_QUERY_MCP_SERVER_ARG } from '../mcp-server-args'

const hostQueryToolSchema = {
  sql: z
    .string()
    .min(1)
    .max(HOST_QUERY_MAX_SQL_LENGTH)
    .describe('A read-only SELECT statement against the self-awareness tables (see description).')
}
const hostQueryToolDefinition = {
  title: 'Query the app database (read-only)',
  description: HOST_QUERY_TOOL_DESCRIPTION,
  inputSchema: hostQueryToolSchema
}

export type HostQueryMcpEnvironment = {
  endpoint: string
  socketPath?: string
  token: string
  sessionId: string
  projectId: string
}

export type HostQueryRpcConnection = LocalRpcTransport & {
  token: string
  release?: () => void
}

type HostQueryMcpHandler = {
  query: (sql: string) => Promise<HostQueryResult>
}

type HostQueryMcpServerConfigRequest = HostQueryMcpEnvironment & {
  command: string
  entryPath: string
}

type RpcResponse = {
  result?: HostQueryResult
  error?: string
}

const createHostQueryMcpServer = (handler: HostQueryMcpHandler): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: HOST_QUERY_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(HOST_QUERY_TOOL_NAME, hostQueryToolDefinition, async (input) => {
    const result = await handler.query(input.sql)
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  return server
}

const createHostQueryMcpServerConfig = ({
  command,
  entryPath,
  endpoint,
  socketPath,
  token,
  sessionId,
  projectId
}: HostQueryMcpServerConfigRequest): McpServerStdio => ({
  name: HOST_QUERY_MCP_SERVER_NAME,
  command,
  args: [entryPath, HOST_QUERY_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'PURESCIENCE_HOST_QUERY_RPC_ENDPOINT', value: endpoint },
    ...(socketPath
      ? [{ name: 'PURESCIENCE_HOST_QUERY_RPC_SOCKET_PATH', value: socketPath }]
      : []),
    { name: 'PURESCIENCE_HOST_QUERY_RPC_TOKEN', value: token },
    { name: 'PURESCIENCE_HOST_QUERY_SESSION_ID', value: sessionId },
    { name: 'PURESCIENCE_HOST_QUERY_PROJECT_ID', value: projectId }
  ]
})

const requireEnvironmentVariable = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Missing host-query MCP environment variable: ${name}`)
  return value
}

const createHostQueryMcpEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): HostQueryMcpEnvironment => ({
  endpoint: requireEnvironmentVariable(env, 'PURESCIENCE_HOST_QUERY_RPC_ENDPOINT'),
  socketPath: env.PURESCIENCE_HOST_QUERY_RPC_SOCKET_PATH,
  token: requireEnvironmentVariable(env, 'PURESCIENCE_HOST_QUERY_RPC_TOKEN'),
  sessionId: requireEnvironmentVariable(env, 'PURESCIENCE_HOST_QUERY_SESSION_ID'),
  projectId: requireEnvironmentVariable(env, 'PURESCIENCE_HOST_QUERY_PROJECT_ID')
})

const callHostQueryRpc = async (
  environment: HostQueryMcpEnvironment,
  params: Record<string, unknown>
): Promise<HostQueryResult> => {
  const response = await fetchLocalRpc(
    environment,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'hostQuery',
        params: {
          sessionId: environment.sessionId,
          projectId: environment.projectId,
          ...params
        }
      })
    },
    'hostQuery RPC'
  )
  const payload = (await response.json()) as RpcResponse

  if (!response.ok || payload.error || !payload.result) {
    throw new Error(payload.error ?? `hostQuery RPC failed with status ${response.status}`)
  }
  return payload.result
}

const runHostQueryMcpServer = async (
  environment = createHostQueryMcpEnvironmentFromProcess()
): Promise<void> => {
  const server = createHostQueryMcpServer({
    query: (sql) => callHostQueryRpc(environment, { sql })
  })
  await server.connect(new StdioServerTransport())
}

export {
  HOST_QUERY_MCP_SERVER_ARG,
  HOST_QUERY_MCP_SERVER_NAME,
  HOST_QUERY_TOOL_NAME,
  hostQueryToolDefinition,
  createHostQueryMcpEnvironmentFromProcess,
  createHostQueryMcpServer,
  createHostQueryMcpServerConfig,
  runHostQueryMcpServer
}
export type { HostQueryMcpHandler }
