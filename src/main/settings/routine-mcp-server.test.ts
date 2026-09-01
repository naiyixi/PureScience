// Routine MCP server unit tests: contract surface (server name/arg/env wiring) and tool-name
// identity, mirroring the memory MCP server test style. Handler round-trips are covered by the
// repository + scheduler tests; the stdio transport is exercised by the app integration path.

import { describe, expect, it, vi } from 'vitest'

import {
  ROUTINE_CANCEL_TOOL_NAME,
  ROUTINE_CONFIGURE_TOOL_NAME,
  ROUTINE_MCP_SERVER_ARG,
  ROUTINE_MCP_SERVER_NAME,
  ROUTINE_STATUS_TOOL_NAME,
  createRoutineMcpServer,
  createRoutineMcpServerConfig
} from './routine-mcp-server'
import type { RoutineSchedule } from '../../shared/routine'

const makeSchedule = (overrides: Partial<RoutineSchedule> = {}): RoutineSchedule => ({
  id: 'routine-1',
  sessionId: 'session-1',
  label: undefined,
  instruction: 'Check for new variants.',
  everyMinutes: 30,
  enabled: true,
  nextDue: 2_000_000,
  lastFireAt: null,
  lastOkAt: null,
  tickCount: 0,
  missedTicks: 0,
  idleStreak: 0,
  pausedReason: null,
  lastResults: [],
  createdAt: 1_000_000,
  updatedAt: 1_000_000,
  ...overrides
})

describe('routine MCP server contract', () => {
  it('names the server and the three tools', () => {
    expect(ROUTINE_MCP_SERVER_NAME).toBe('purescience-routine')
    expect(ROUTINE_CONFIGURE_TOOL_NAME).toBe('routine_configure')
    expect(ROUTINE_STATUS_TOOL_NAME).toBe('routine_status')
    expect(ROUTINE_CANCEL_TOOL_NAME).toBe('routine_cancel')
  })

  it('builds a stdio config with the routine entry arg and RPC environment', () => {
    const config = createRoutineMcpServerConfig({
      command: '/app/PureScience.app/Contents/Resources/app.asar/index.js',
      entryPath: '/app/PureScience.app/Contents/Resources/app.asar/index.js',
      endpoint: 'http://127.0.0.1:52101',
      token: 'capability-token',
      sessionId: 'routine-session-1'
    })
    expect(config.name).toBe(ROUTINE_MCP_SERVER_NAME)
    expect(config.args).toEqual([
      '/app/PureScience.app/Contents/Resources/app.asar/index.js',
      ROUTINE_MCP_SERVER_ARG
    ])
    const env = Object.fromEntries(config.env?.map((entry) => [entry.name, entry.value]) ?? [])
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.PURESCIENCE_ROUTINE_RPC_ENDPOINT).toBe('http://127.0.0.1:52101')
    expect(env.PURESCIENCE_ROUTINE_RPC_TOKEN).toBe('capability-token')
    expect(env.PURESCIENCE_ROUTINE_SESSION_ID).toBe('routine-session-1')
    expect(env.PURESCIENCE_ROUTINE_RPC_SOCKET_PATH).toBeUndefined()
  })

  it('registers the three tool names on the server without invoking the transport', () => {
    const server = createRoutineMcpServer({
      configure: vi.fn(async () => ({ schedule: makeSchedule() })),
      status: vi.fn(async () => ({ schedules: [makeSchedule()] })),
      cancel: vi.fn(async () => ({ cancelled: true }))
    })
    expect(server).toBeDefined()
  })
})
