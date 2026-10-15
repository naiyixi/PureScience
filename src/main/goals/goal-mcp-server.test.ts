// Goal MCP server unit tests: contract surface (server name/arg/env wiring), tool registration, and the
// handler round-trips — same style as the endpoint/routine server tests, with two additions that the
// routine one does not make: the registration list is compared EXACTLY (so a stray third tool fails), and
// the snake→camel mapping is pinned (`goal_id` must arrive as `goalId`), because a silent rename would
// drop the id and quietly register a second goal instead of updating the first.
import { describe, expect, it, vi } from 'vitest'

import type { Goal } from '../../shared/goal'
import {
  GOAL_CONFIGURE_TOOL_NAME,
  GOAL_MCP_SERVER_ARG,
  GOAL_MCP_SERVER_NAME,
  GOAL_STATUS_TOOL_NAME,
  createGoalMcpServer,
  createGoalMcpServerConfig
} from './goal-mcp-server'

const makeGoal = (overrides: Partial<Goal> = {}): Goal => ({
  id: 'goal-1',
  sessionId: 'session-1',
  objective: '把方法编译成可调用能力',
  acceptance: [{ id: 'criterion-1', text: '运行记录能编译成技能', metBy: null }],
  milestones: [],
  state: 'active',
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides
})

type RegisteredTools = Record<
  string,
  {
    handler: (
      input: Record<string, unknown>
    ) => Promise<{ content: { type: string; text: string }[] }>
  }
>

const toolsOf = (server: unknown): RegisteredTools =>
  (server as { _registeredTools: RegisteredTools })._registeredTools

describe('goal MCP server contract', () => {
  it('names the server and the two tools', () => {
    expect(GOAL_MCP_SERVER_NAME).toBe('purescience-goal')
    expect(GOAL_CONFIGURE_TOOL_NAME).toBe('goal_configure')
    expect(GOAL_STATUS_TOOL_NAME).toBe('goal_status')
  })

  it('builds a stdio config with the goal entry arg and RPC environment', () => {
    const config = createGoalMcpServerConfig({
      command: '/app/PureScience.app/Contents/Resources/app.asar/index.js',
      entryPath: '/app/PureScience.app/Contents/Resources/app.asar/index.js',
      endpoint: 'http://127.0.0.1:52101',
      token: 'capability-token',
      sessionId: 'goal-session-1'
    })
    expect(config.name).toBe(GOAL_MCP_SERVER_NAME)
    expect(config.args).toEqual([
      '/app/PureScience.app/Contents/Resources/app.asar/index.js',
      GOAL_MCP_SERVER_ARG
    ])
    const env = Object.fromEntries(config.env?.map((entry) => [entry.name, entry.value]) ?? [])
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.PURESCIENCE_GOAL_RPC_ENDPOINT).toBe('http://127.0.0.1:52101')
    expect(env.PURESCIENCE_GOAL_RPC_TOKEN).toBe('capability-token')
    expect(env.PURESCIENCE_GOAL_SESSION_ID).toBe('goal-session-1')
    expect(env.PURESCIENCE_GOAL_RPC_SOCKET_PATH).toBeUndefined()

    // A socket path, when the app uses one, is passed through rather than dropped.
    const socketConfig = createGoalMcpServerConfig({
      command: 'node',
      entryPath: '/app/out/main/index.js',
      endpoint: 'http://127.0.0.1:52101',
      socketPath: '/tmp/purescience-rpc.sock',
      token: 'capability-token',
      sessionId: 'goal-session-1'
    })
    const socketEnv = Object.fromEntries(
      socketConfig.env?.map((entry) => [entry.name, entry.value]) ?? []
    )
    expect(socketEnv.PURESCIENCE_GOAL_RPC_SOCKET_PATH).toBe('/tmp/purescience-rpc.sock')
  })

  it('registers exactly the two tool names, and calls no handler at registration', () => {
    const configure = vi.fn(async () => makeGoal())
    const status = vi.fn(async () => [makeGoal()])
    const server = createGoalMcpServer({ configure, status })

    expect(Object.keys(toolsOf(server)).sort()).toEqual(
      [GOAL_CONFIGURE_TOOL_NAME, GOAL_STATUS_TOOL_NAME].sort()
    )
    expect(configure).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
  })

  it('round-trips goal_configure, mapping goal_id to goalId instead of dropping it', async () => {
    // Typed at the mock, so the call arguments stay visible to the assertion below (no cast).
    const configure = vi.fn(
      async (_input: { goalId?: string; objective: string; acceptance: string[] }) => makeGoal()
    )
    const server = createGoalMcpServer({
      configure,
      status: vi.fn(async () => [makeGoal()])
    })

    const result = await toolsOf(server)[GOAL_CONFIGURE_TOOL_NAME]?.handler({
      goal_id: 'goal-1',
      objective: '把方法编译成可调用能力',
      acceptance: ['运行记录能编译成技能']
    })

    expect(configure).toHaveBeenCalledTimes(1)
    expect(configure.mock.calls[0]?.[0]).toEqual({
      goalId: 'goal-1',
      objective: '把方法编译成可调用能力',
      acceptance: ['运行记录能编译成技能']
    })
    // The tool answers with the record itself, serialized — so a caller can read back what was stored.
    const text = result?.content[0]?.text ?? ''
    expect(JSON.parse(text)).toMatchObject({ id: 'goal-1', objective: '把方法编译成可调用能力' })
  })

  it('round-trips goal_status', async () => {
    const server = createGoalMcpServer({
      configure: vi.fn(async () => makeGoal()),
      status: vi.fn(async () => [makeGoal({ id: 'goal-2' })])
    })
    const result = await toolsOf(server)[GOAL_STATUS_TOOL_NAME]?.handler({})
    const parsed = JSON.parse(result?.content[0]?.text ?? '[]') as Goal[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.id).toBe('goal-2')
    // An unmet criterion is null, not false: "no reading proved it" is the absence of evidence.
    expect(parsed[0]?.acceptance[0]?.metBy).toBeNull()
  })
})
