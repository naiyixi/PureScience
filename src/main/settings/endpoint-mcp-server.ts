// Agent-facing managed-endpoint MCP server: lets the agent register local model services
// (endpoint_register), manage their lifecycle (endpoint_start / endpoint_stop), inspect state
// (endpoint_status / endpoint_list), allocate ports (endpoint_free_port), and remove a service
// (endpoint_unregister). The MCP process runs as a stdio child of the agent; persistence and
// the lifecycle state machine live in the main process over the app's local RPC gateway (same
// pattern as memory / context-summary / routine), so the store keeps a single writer.

import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  ENDPOINT_FREE_PORT_TOOL_DESCRIPTION,
  ENDPOINT_FREE_PORT_TOOL_NAME,
  ENDPOINT_LIST_TOOL_DESCRIPTION,
  ENDPOINT_LIST_TOOL_NAME,
  ENDPOINT_MCP_SERVER_NAME,
  ENDPOINT_REGISTER_TOOL_DESCRIPTION,
  ENDPOINT_REGISTER_TOOL_NAME,
  ENDPOINT_START_TOOL_DESCRIPTION,
  ENDPOINT_START_TOOL_NAME,
  ENDPOINT_STATUS_TOOL_DESCRIPTION,
  ENDPOINT_STATUS_TOOL_NAME,
  ENDPOINT_STOP_TOOL_DESCRIPTION,
  ENDPOINT_STOP_TOOL_NAME,
  ENDPOINT_UNREGISTER_TOOL_DESCRIPTION,
  ENDPOINT_UNREGISTER_TOOL_NAME
} from '../../shared/endpoint'
import type {
  EndpointFreePortResult,
  EndpointListResult,
  EndpointRegisterRequest,
  EndpointRegisterResult,
  EndpointStartResult,
  EndpointStatusResult,
  EndpointStopResult,
  EndpointUnregisterResult
} from '../../shared/endpoint'
import { fetchLocalRpc, type LocalRpcTransport } from '../local-rpc-transport'
import { ENDPOINT_MCP_SERVER_ARG } from '../mcp-server-args'

const endpointRegisterToolSchema = {
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/)
    .describe('Endpoint name, 1-64 chars [a-z0-9-]. Doubles as the provider id callers use.'),
  url: z
    .string()
    .min(1)
    .describe(
      'Local loopback URL: http://127.0.0.1:<port>[/path]. Use endpoint_free_port to allocate the port.'
    ),
  skill_name: z.string().min(1).describe('Name of the runbook skill documenting the model API.'),
  start: z
    .string()
    .min(1)
    .describe('Opaque idempotent bash; receives HOST_PORT, SERVICE_DIR, CREDENTIAL_VALUE in env.'),
  stop: z
    .string()
    .min(1)
    .describe('Opaque bash; must exit 0 only when the service is fully stopped.'),
  live: z
    .string()
    .min(1)
    .describe('Readiness route on the endpoint URL, e.g. /health/ready or /v1/models.'),
  credential_name: z
    .string()
    .min(1)
    .optional()
    .describe('Name of a saved credential whose value is injected into the start script env.')
}
const endpointRegisterToolDefinition = {
  title: 'Register a local model server',
  description: ENDPOINT_REGISTER_TOOL_DESCRIPTION,
  inputSchema: endpointRegisterToolSchema
}

const endpointUnregisterToolSchema = {
  name: z.string().min(1).describe('Endpoint name to remove (stopped first if live).')
}
const endpointUnregisterToolDefinition = {
  title: 'Remove a local model server',
  description: ENDPOINT_UNREGISTER_TOOL_DESCRIPTION,
  inputSchema: endpointUnregisterToolSchema
}

const endpointStartToolSchema = {
  name: z.string().min(1).describe('Endpoint name to start.')
}
const endpointStartToolDefinition = {
  title: 'Start a local model server',
  description: ENDPOINT_START_TOOL_DESCRIPTION,
  inputSchema: endpointStartToolSchema
}

const endpointStopToolSchema = {
  name: z.string().min(1).describe('Endpoint name to stop.')
}
const endpointStopToolDefinition = {
  title: 'Stop a local model server',
  description: ENDPOINT_STOP_TOOL_DESCRIPTION,
  inputSchema: endpointStopToolSchema
}

const endpointStatusToolSchema = {
  name: z.string().min(1).describe('Endpoint name to inspect.')
}
const endpointStatusToolDefinition = {
  title: 'Inspect a local model server',
  description: ENDPOINT_STATUS_TOOL_DESCRIPTION,
  inputSchema: endpointStatusToolSchema
}

const endpointListToolDefinition = {
  title: 'List local model servers',
  description: ENDPOINT_LIST_TOOL_DESCRIPTION,
  inputSchema: {}
}

const endpointFreePortToolDefinition = {
  title: 'Allocate a managed host port',
  description: ENDPOINT_FREE_PORT_TOOL_DESCRIPTION,
  inputSchema: {}
}

export type EndpointMcpEnvironment = {
  endpoint: string
  socketPath?: string
  token: string
  sessionId: string
}

export type EndpointRpcConnection = LocalRpcTransport & {
  token: string
  release?: () => void
}

type EndpointMcpHandler = {
  register: (request: EndpointRegisterRequest) => Promise<EndpointRegisterResult>
  unregister: (name: string) => Promise<EndpointUnregisterResult>
  start: (name: string) => Promise<EndpointStartResult>
  stop: (name: string) => Promise<EndpointStopResult>
  status: (name: string) => Promise<EndpointStatusResult>
  list: () => Promise<EndpointListResult>
  freePort: () => Promise<EndpointFreePortResult>
}

type EndpointMcpServerConfigRequest = EndpointMcpEnvironment & {
  command: string
  entryPath: string
}

type RpcResponse = {
  result?:
    | EndpointRegisterResult
    | EndpointUnregisterResult
    | EndpointStartResult
    | EndpointStopResult
    | EndpointStatusResult
    | EndpointListResult
    | EndpointFreePortResult
  error?: string
}

const createEndpointMcpServer = (handler: EndpointMcpHandler): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: ENDPOINT_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(
    ENDPOINT_REGISTER_TOOL_NAME,
    endpointRegisterToolDefinition,
    async (input) => {
      const result = await handler.register({
        name: input.name,
        url: input.url,
        skillName: input.skill_name,
        startScript: input.start,
        stopScript: input.stop,
        livePath: input.live,
        credentialName: input.credential_name
      })
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      }
    }
  )

  server.registerTool(
    ENDPOINT_UNREGISTER_TOOL_NAME,
    endpointUnregisterToolDefinition,
    async (input) => {
      const result = await handler.unregister(input.name)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      }
    }
  )

  server.registerTool(ENDPOINT_START_TOOL_NAME, endpointStartToolDefinition, async (input) => {
    const result = await handler.start(input.name)
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  server.registerTool(ENDPOINT_STOP_TOOL_NAME, endpointStopToolDefinition, async (input) => {
    const result = await handler.stop(input.name)
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  server.registerTool(ENDPOINT_STATUS_TOOL_NAME, endpointStatusToolDefinition, async (input) => {
    const result = await handler.status(input.name)
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  server.registerTool(ENDPOINT_LIST_TOOL_NAME, endpointListToolDefinition, async () => {
    const result = await handler.list()
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  server.registerTool(ENDPOINT_FREE_PORT_TOOL_NAME, endpointFreePortToolDefinition, async () => {
    const result = await handler.freePort()
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  return server
}

const createEndpointMcpServerConfig = ({
  command,
  entryPath,
  endpoint,
  socketPath,
  token,
  sessionId
}: EndpointMcpServerConfigRequest): McpServerStdio => ({
  name: ENDPOINT_MCP_SERVER_NAME,
  command,
  args: [entryPath, ENDPOINT_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'PURESCIENCE_ENDPOINT_RPC_ENDPOINT', value: endpoint },
    ...(socketPath ? [{ name: 'PURESCIENCE_ENDPOINT_RPC_SOCKET_PATH', value: socketPath }] : []),
    { name: 'PURESCIENCE_ENDPOINT_RPC_TOKEN', value: token },
    { name: 'PURESCIENCE_ENDPOINT_SESSION_ID', value: sessionId }
  ]
})

const requireEnvironmentVariable = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Missing endpoint MCP environment variable: ${name}`)
  return value
}

const createEndpointMcpEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): EndpointMcpEnvironment => ({
  endpoint: requireEnvironmentVariable(env, 'PURESCIENCE_ENDPOINT_RPC_ENDPOINT'),
  socketPath: env.PURESCIENCE_ENDPOINT_RPC_SOCKET_PATH,
  token: requireEnvironmentVariable(env, 'PURESCIENCE_ENDPOINT_RPC_TOKEN'),
  sessionId: requireEnvironmentVariable(env, 'PURESCIENCE_ENDPOINT_SESSION_ID')
})

const callEndpointRpc = async (
  environment: EndpointMcpEnvironment,
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
        params: { sessionId: environment.sessionId, ...params }
      })
    },
    `Endpoint ${method} RPC`
  )
  const payload = (await response.json()) as RpcResponse

  if (!response.ok || payload.error || !payload.result) {
    throw new Error(payload.error ?? `Endpoint ${method} RPC failed with status ${response.status}`)
  }
  return payload.result
}

const runEndpointMcpServer = async (
  environment = createEndpointMcpEnvironmentFromProcess()
): Promise<void> => {
  const server = createEndpointMcpServer({
    register: (request) =>
      callEndpointRpc(environment, 'endpointRegister', {
        ...request
      }) as Promise<EndpointRegisterResult>,
    unregister: (name) =>
      callEndpointRpc(environment, 'endpointUnregister', {
        name
      }) as Promise<EndpointUnregisterResult>,
    start: (name) =>
      callEndpointRpc(environment, 'endpointStart', { name }) as Promise<EndpointStartResult>,
    stop: (name) =>
      callEndpointRpc(environment, 'endpointStop', { name }) as Promise<EndpointStopResult>,
    status: (name) =>
      callEndpointRpc(environment, 'endpointStatus', { name }) as Promise<EndpointStatusResult>,
    list: () => callEndpointRpc(environment, 'endpointList', {}) as Promise<EndpointListResult>,
    freePort: () =>
      callEndpointRpc(environment, 'endpointFreePort', {}) as Promise<EndpointFreePortResult>
  })
  await server.connect(new StdioServerTransport())
}

export {
  ENDPOINT_MCP_SERVER_ARG,
  ENDPOINT_MCP_SERVER_NAME,
  ENDPOINT_REGISTER_TOOL_NAME,
  ENDPOINT_UNREGISTER_TOOL_NAME,
  ENDPOINT_START_TOOL_NAME,
  ENDPOINT_STOP_TOOL_NAME,
  ENDPOINT_STATUS_TOOL_NAME,
  ENDPOINT_LIST_TOOL_NAME,
  ENDPOINT_FREE_PORT_TOOL_NAME,
  endpointRegisterToolDefinition,
  endpointUnregisterToolDefinition,
  endpointStartToolDefinition,
  endpointStopToolDefinition,
  endpointStatusToolDefinition,
  endpointListToolDefinition,
  endpointFreePortToolDefinition,
  createEndpointMcpEnvironmentFromProcess,
  createEndpointMcpServer,
  createEndpointMcpServerConfig,
  runEndpointMcpServer
}
export type { EndpointMcpHandler }
