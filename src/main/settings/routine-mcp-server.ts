// Agent-facing routine MCP server: lets the agent register recurring scheduled tasks
// (routine_configure), inspect them (routine_status), and remove them (routine_cancel). The MCP
// process runs as a stdio child of the agent; schedule persistence and the tick loop live in the
// main process over the app's local RPC gateway (same pattern as memory + context-summary), so
// the session store keeps a single writer.

import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  ROUTINE_CANCEL_TOOL_DESCRIPTION,
  ROUTINE_CANCEL_TOOL_NAME,
  ROUTINE_CONFIGURE_TOOL_DESCRIPTION,
  ROUTINE_CONFIGURE_TOOL_NAME,
  ROUTINE_MCP_SERVER_NAME,
  ROUTINE_STATUS_TOOL_DESCRIPTION,
  ROUTINE_STATUS_TOOL_NAME
} from '../../shared/routine'
import type {
  RoutineCancelResult,
  RoutineConfigureRequest,
  RoutineConfigureResult,
  RoutineStatusResult
} from '../../shared/routine'
import { fetchLocalRpc, type LocalRpcTransport } from '../local-rpc-transport'
import { ROUTINE_MCP_SERVER_ARG } from '../mcp-server-args'

const routineConfigureToolSchema = {
  routine_id: z
    .string()
    .min(1)
    .optional()
    .describe('Existing routine id to update; omit to create a new schedule.'),
  every_minutes: z
    .number()
    .int()
    .min(5)
    .max(1440)
    .describe('Tick interval in minutes (5–1440).'),
  instruction: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      'Self-contained prompt dispatched as a task run on each tick. State what to do, check, and report.'
    ),
  label: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('Short human label shown in the settings panel.')
}
const routineConfigureToolDefinition = {
  title: 'Schedule a recurring task',
  description: ROUTINE_CONFIGURE_TOOL_DESCRIPTION,
  inputSchema: routineConfigureToolSchema
}

const routineStatusToolDefinition = {
  title: 'List scheduled tasks',
  description: ROUTINE_STATUS_TOOL_DESCRIPTION,
  inputSchema: {}
}

const routineCancelToolSchema = {
  routine_id: z.string().min(1).describe('The routine id to cancel.')
}
const routineCancelToolDefinition = {
  title: 'Cancel a scheduled task',
  description: ROUTINE_CANCEL_TOOL_DESCRIPTION,
  inputSchema: routineCancelToolSchema
}

export type RoutineMcpEnvironment = {
  endpoint: string
  socketPath?: string
  token: string
  sessionId: string
}

export type RoutineRpcConnection = LocalRpcTransport & {
  token: string
  release?: () => void
}

type RoutineMcpHandler = {
  configure: (request: RoutineConfigureRequest) => Promise<RoutineConfigureResult>
  status: () => Promise<RoutineStatusResult>
  cancel: (routineId: string) => Promise<RoutineCancelResult>
}

type RoutineMcpServerConfigRequest = RoutineMcpEnvironment & {
  command: string
  entryPath: string
}

type RpcResponse = {
  result?: RoutineConfigureResult | RoutineStatusResult | RoutineCancelResult
  error?: string
}

const createRoutineMcpServer = (handler: RoutineMcpHandler): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: ROUTINE_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(ROUTINE_CONFIGURE_TOOL_NAME, routineConfigureToolDefinition, async (input) => {
    const result = await handler.configure({
      routineId: input.routine_id,
      everyMinutes: input.every_minutes,
      instruction: input.instruction,
      label: input.label
    })
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  server.registerTool(ROUTINE_STATUS_TOOL_NAME, routineStatusToolDefinition, async () => {
    const result = await handler.status()
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  server.registerTool(ROUTINE_CANCEL_TOOL_NAME, routineCancelToolDefinition, async (input) => {
    const result = await handler.cancel(input.routine_id)
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  return server
}

const createRoutineMcpServerConfig = ({
  command,
  entryPath,
  endpoint,
  socketPath,
  token,
  sessionId
}: RoutineMcpServerConfigRequest): McpServerStdio => ({
  name: ROUTINE_MCP_SERVER_NAME,
  command,
  args: [entryPath, ROUTINE_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'PURESCIENCE_ROUTINE_RPC_ENDPOINT', value: endpoint },
    ...(socketPath
      ? [{ name: 'PURESCIENCE_ROUTINE_RPC_SOCKET_PATH', value: socketPath }]
      : []),
    { name: 'PURESCIENCE_ROUTINE_RPC_TOKEN', value: token },
    { name: 'PURESCIENCE_ROUTINE_SESSION_ID', value: sessionId }
  ]
})

const requireEnvironmentVariable = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Missing routine MCP environment variable: ${name}`)
  return value
}

const createRoutineMcpEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): RoutineMcpEnvironment => ({
  endpoint: requireEnvironmentVariable(env, 'PURESCIENCE_ROUTINE_RPC_ENDPOINT'),
  socketPath: env.PURESCIENCE_ROUTINE_RPC_SOCKET_PATH,
  token: requireEnvironmentVariable(env, 'PURESCIENCE_ROUTINE_RPC_TOKEN'),
  sessionId: requireEnvironmentVariable(env, 'PURESCIENCE_ROUTINE_SESSION_ID')
})

const callRoutineRpc = async (
  environment: RoutineMcpEnvironment,
  method: string,
  params: Record<string, unknown>
): Promise<RoutineConfigureResult | RoutineStatusResult | RoutineCancelResult> => {
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
    `Routine ${method} RPC`
  )
  const payload = (await response.json()) as RpcResponse

  if (!response.ok || payload.error || !payload.result) {
    throw new Error(payload.error ?? `Routine ${method} RPC failed with status ${response.status}`)
  }
  return payload.result
}

const runRoutineMcpServer = async (
  environment = createRoutineMcpEnvironmentFromProcess()
): Promise<void> => {
  const server = createRoutineMcpServer({
    configure: (request) =>
      callRoutineRpc(environment, 'routineConfigure', {
        ...request,
        everyMinutes: request.everyMinutes
      }) as Promise<RoutineConfigureResult>,
    status: () =>
      callRoutineRpc(environment, 'routineStatus', {}) as Promise<RoutineStatusResult>,
    cancel: (routineId) =>
      callRoutineRpc(environment, 'routineCancel', { routineId }) as Promise<RoutineCancelResult>
  })
  await server.connect(new StdioServerTransport())
}

export {
  ROUTINE_MCP_SERVER_ARG,
  ROUTINE_MCP_SERVER_NAME,
  ROUTINE_CONFIGURE_TOOL_NAME,
  ROUTINE_STATUS_TOOL_NAME,
  ROUTINE_CANCEL_TOOL_NAME,
  routineConfigureToolDefinition,
  routineStatusToolDefinition,
  routineCancelToolDefinition,
  createRoutineMcpEnvironmentFromProcess,
  createRoutineMcpServer,
  createRoutineMcpServerConfig,
  runRoutineMcpServer
}
export type { RoutineMcpHandler }
