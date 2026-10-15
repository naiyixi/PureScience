// Agent-facing goal MCP server: lets the agent register a persistent goal (goal_configure) and read back
// what has actually advanced it (goal_status). Shaped exactly like the routine server — same stdio child,
// same local-RPC gateway back to the main process — because the reason is the same: the record has ONE
// writer (the main process), and a tool process that wrote its own file would be a second one.
//
// What this surface deliberately does NOT offer: advancing progress. That goes through goal_advance, which
// requires a reading the app itself took, and it lands with F2 — a tool that could set `metBy` from the
// agent's own words would make "the criteria are met only by assertion" unfalsifiable by construction.

import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  GOAL_ADVANCE_TOOL_DESCRIPTION,
  GOAL_ADVANCE_TOOL_NAME,
  GOAL_CONFIGURE_TOOL_DESCRIPTION,
  GOAL_CONFIGURE_TOOL_NAME,
  GOAL_MAX_ACCEPTANCE_ITEMS,
  GOAL_MAX_OBJECTIVE_CHARS,
  GOAL_MAX_TEXT_CHARS,
  GOAL_MCP_SERVER_NAME,
  GOAL_STATUS_TOOL_DESCRIPTION,
  GOAL_STATUS_TOOL_NAME
} from '../../shared/goal'
import type { Goal, GoalAdvanceRequest, GoalReadingKind } from '../../shared/goal'
import { fetchLocalRpc, type LocalRpcTransport } from '../local-rpc-transport'
import { GOAL_MCP_SERVER_ARG } from '../mcp-server-args'

const goalConfigureToolSchema = {
  goal_id: z
    .string()
    .min(1)
    .optional()
    .describe('Existing goal id to update; omit to register a new goal.'),
  objective: z
    .string()
    .min(1)
    .max(GOAL_MAX_OBJECTIVE_CHARS)
    .describe('What has to be true when this is finished, in one objective.'),
  acceptance: z
    .array(z.string().min(1).max(GOAL_MAX_TEXT_CHARS))
    .min(1)
    .max(GOAL_MAX_ACCEPTANCE_ITEMS)
    .describe(
      'The criteria that decide the goal is finished. Each one is met only by a reading the app took, ' +
        'so write them as things a run or an artifact can demonstrate.'
    )
}
const goalConfigureToolDefinition = {
  title: 'Register a persistent goal',
  description: GOAL_CONFIGURE_TOOL_DESCRIPTION,
  inputSchema: goalConfigureToolSchema
}

const goalStatusToolDefinition = {
  title: 'Read the goals and what advanced them',
  description: GOAL_STATUS_TOOL_DESCRIPTION,
  inputSchema: {}
}

const goalAdvanceToolSchema = {
  goal_id: z.string().min(1).describe('The goal to advance.'),
  criterion: z
    .string()
    .min(1)
    .describe('The acceptance criterion, by its id or by its exact text.'),
  note: z
    .string()
    .min(1)
    .optional()
    .describe('One line saying what this step did; defaults to the criterion text.'),
  reading_kind: z
    .enum(['run', 'artifact-version', 'connector-reading'])
    .describe('What kind of reading grounds this step. Only "run" is wired in this version.'),
  reading_id: z.string().min(1).describe('The reading\u2019s id (for a run: the run id).'),
  reading_fingerprint: z
    .string()
    .min(1)
    .describe(
      'The fingerprint the reading was taken with. The app recomputes it and stores its own value — a ' +
        'claim that does not match the record is refused.'
    )
}
const goalAdvanceToolDefinition = {
  title: 'Advance a goal on a real reading',
  description: GOAL_ADVANCE_TOOL_DESCRIPTION,
  inputSchema: goalAdvanceToolSchema
}

export type GoalMcpEnvironment = {
  endpoint: string
  socketPath?: string
  token: string
  sessionId: string
}

export type GoalRpcConnection = LocalRpcTransport & {
  token: string
  release?: () => void
}

export type GoalConfigureInput = {
  goalId?: string
  objective: string
  acceptance: string[]
}

type GoalMcpHandler = {
  configure: (request: GoalConfigureInput) => Promise<Goal>
  status: () => Promise<Goal[]>
  advance: (request: GoalAdvanceRequest) => Promise<Goal>
}

type GoalMcpServerConfigRequest = GoalMcpEnvironment & {
  command: string
  entryPath: string
}

type RpcResponse = {
  result?: Goal | Goal[]
  error?: string
}

const createGoalMcpServer = (handler: GoalMcpHandler): ModelContextProtocolServer => {
  const server = new ModelContextProtocolServer({
    name: GOAL_MCP_SERVER_NAME,
    version: '1.0.0'
  })

  server.registerTool(GOAL_CONFIGURE_TOOL_NAME, goalConfigureToolDefinition, async (input) => {
    const result = await handler.configure({
      goalId: input.goal_id,
      objective: input.objective,
      acceptance: input.acceptance
    })
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  server.registerTool(GOAL_STATUS_TOOL_NAME, goalStatusToolDefinition, async () => {
    const result = await handler.status()
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  server.registerTool(GOAL_ADVANCE_TOOL_NAME, goalAdvanceToolDefinition, async (input) => {
    // snake_case in the schema, camelCase in the type — mapped explicitly, so a rename can never quietly
    // drop the reading that this call is supposed to be grounded in.
    const result = await handler.advance({
      goalId: input.goal_id,
      criterion: input.criterion,
      note: input.note,
      reading: {
        kind: input.reading_kind as GoalReadingKind,
        id: input.reading_id,
        fingerprint: input.reading_fingerprint
      }
    })
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  })

  return server
}

const createGoalMcpServerConfig = ({
  command,
  entryPath,
  endpoint,
  socketPath,
  token,
  sessionId
}: GoalMcpServerConfigRequest): McpServerStdio => ({
  name: GOAL_MCP_SERVER_NAME,
  command,
  args: [entryPath, GOAL_MCP_SERVER_ARG],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'PURESCIENCE_GOAL_RPC_ENDPOINT', value: endpoint },
    ...(socketPath ? [{ name: 'PURESCIENCE_GOAL_RPC_SOCKET_PATH', value: socketPath }] : []),
    { name: 'PURESCIENCE_GOAL_RPC_TOKEN', value: token },
    { name: 'PURESCIENCE_GOAL_SESSION_ID', value: sessionId }
  ]
})

const requireEnvironmentVariable = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`Missing goal MCP environment variable: ${name}`)
  return value
}

const createGoalMcpEnvironmentFromProcess = (
  env: NodeJS.ProcessEnv = process.env
): GoalMcpEnvironment => ({
  endpoint: requireEnvironmentVariable(env, 'PURESCIENCE_GOAL_RPC_ENDPOINT'),
  socketPath: env.PURESCIENCE_GOAL_RPC_SOCKET_PATH,
  token: requireEnvironmentVariable(env, 'PURESCIENCE_GOAL_RPC_TOKEN'),
  sessionId: requireEnvironmentVariable(env, 'PURESCIENCE_GOAL_SESSION_ID')
})

const callGoalRpc = async (
  environment: GoalMcpEnvironment,
  method: 'goalConfigure' | 'goalStatus' | 'goalAdvance',
  params: Record<string, unknown>
): Promise<Goal | Goal[]> => {
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
    `Goal ${method} RPC`
  )
  const payload = (await response.json()) as RpcResponse

  if (!response.ok || payload.error || payload.result === undefined) {
    throw new Error(payload.error ?? `Goal ${method} RPC failed with status ${response.status}`)
  }
  return payload.result
}

const runGoalMcpServer = async (
  environment = createGoalMcpEnvironmentFromProcess()
): Promise<void> => {
  const server = createGoalMcpServer({
    configure: (request) =>
      callGoalRpc(environment, 'goalConfigure', { ...request }) as Promise<Goal>,
    status: () => callGoalRpc(environment, 'goalStatus', {}) as Promise<Goal[]>,
    advance: (request) => callGoalRpc(environment, 'goalAdvance', { ...request }) as Promise<Goal>
  })
  await server.connect(new StdioServerTransport())
}

export {
  GOAL_MCP_SERVER_ARG,
  GOAL_MCP_SERVER_NAME,
  GOAL_ADVANCE_TOOL_NAME,
  GOAL_CONFIGURE_TOOL_NAME,
  GOAL_STATUS_TOOL_NAME,
  goalAdvanceToolDefinition,
  goalConfigureToolDefinition,
  goalStatusToolDefinition,
  createGoalMcpEnvironmentFromProcess,
  createGoalMcpServer,
  createGoalMcpServerConfig,
  runGoalMcpServer
}
export type { GoalMcpHandler }
