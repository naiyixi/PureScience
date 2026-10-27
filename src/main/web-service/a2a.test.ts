import { describe, expect, it, vi } from 'vitest'

import type { TaskRun } from '../../shared/task-api'
import { buildA2AAgentCard, handleA2ARequest, type A2ATaskSource } from './a2a'

const run = (overrides: Partial<TaskRun> = {}): TaskRun => ({
  id: 'run-1',
  sessionId: 'session-1',
  projectId: 'project-1',
  status: 'completed',
  startedAt: 1_700_000_000_000,
  completedAt: 1_700_000_001_000,
  output: 'ok',
  artifacts: [],
  ...overrides
})

const tasks = (
  options: {
    projects?: Array<{ id: string; name: string }>
    statuses?: TaskRun['status'][]
  } = {}
): A2ATaskSource => {
  const statuses = [...(options.statuses ?? ['completed'])]
  return {
    listProjects: vi.fn(async () => options.projects ?? [{ id: 'project-1', name: 'p' }]),
    // With explicit statuses the run starts as 'running' and the polls below move it; without them it is
    // already completed, which is the fast path a synchronous client sees.
    startRun: vi.fn(async () => run({ status: options.statuses ? 'running' : 'completed' })),
    getRun: vi.fn(() => {
      const status = statuses.shift() ?? 'completed'
      return run({ status })
    })
  }
}

describe('A2A surface', () => {
  it('serves a card with the fields an A2A client requires', () => {
    const card = buildA2AAgentCard({
      baseUrl: 'http://127.0.0.1:1234',
      version: '2.18.5',
      platform: 'darwin',
      capabilities: ['artifacts', 'notebook']
    })

    // The six fields whose absence made the old card unusable as an AgentCard.
    expect(card.url).toBe('http://127.0.0.1:1234')
    expect(card.protocolVersion).toBe('0.2.3')
    expect(card.preferredTransport).toBe('JSONRPC')
    expect(card.defaultInputModes).toEqual(['text/plain'])
    expect(card.defaultOutputModes).toEqual(['text/plain'])
    expect(Array.isArray(card.skills)).toBe(true)
    expect((card.skills as Array<{ id: string }>).map((skill) => skill.id)).toEqual([
      'artifacts',
      'notebook'
    ])
    // False on purpose: the transport does not stream.
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false })
  })

  it('answers message/send with a task carrying the run output', async () => {
    const source = tasks()
    const outcome = await handleA2ARequest(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'message/send',
        params: { message: { role: 'user', parts: [{ kind: 'text', text: 'ping' }] } }
      },
      { tasks: source }
    )

    expect(outcome.status).toBe(200)
    const body = outcome.body as {
      id: number
      result: {
        id: string
        status: { state: string }
        artifacts: Array<{ parts: Array<{ text: string }> }>
      }
    }
    expect(body.id).toBe(7)
    expect(body.result.id).toBe('session-1')
    expect(body.result.status.state).toBe('completed')
    expect(body.result.artifacts[0]?.parts[0]?.text).toBe('ok')
    expect(source.startRun).toHaveBeenCalledWith({ project: 'project-1', prompt: 'ping' })
  })

  it('refuses to guess a project when the instance has several', async () => {
    const outcome = await handleA2ARequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: { message: { role: 'user', parts: [{ kind: 'text', text: 'ping' }] } }
      },
      {
        tasks: tasks({
          projects: [
            { id: 'a', name: 'a' },
            { id: 'b', name: 'b' }
          ]
        })
      }
    )

    const body = outcome.body as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32602)
    expect(body.error.message).toContain('message.metadata.project is required')
  })

  it('honours an explicit project in the message metadata', async () => {
    const source = tasks({
      projects: [
        { id: 'a', name: 'a' },
        { id: 'b', name: 'b' }
      ]
    })
    await handleA2ARequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{ kind: 'text', text: 'ping' }],
            metadata: { project: 'b' }
          }
        }
      },
      { tasks: source }
    )
    expect(source.startRun).toHaveBeenCalledWith({ project: 'b', prompt: 'ping' })
  })

  it('answers working when the run outlives the blocking budget, and never invents output', async () => {
    const source = tasks({ statuses: ['running', 'running', 'running'] })
    const outcome = await handleA2ARequest(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'message/send',
        params: { message: { role: 'user', parts: [{ kind: 'text', text: 'ping' }] } }
      },
      // A zero budget means one poll; the run stays running.
      { tasks: source, blockingTimeoutMs: 0 }
    )
    const body = outcome.body as { result: { status: { state: string }; artifacts: unknown[] } }
    expect(body.result.status.state).toBe('working')
    expect(body.result.artifacts).toEqual([])
  })

  it('rejects unknown methods and malformed envelopes by name', async () => {
    const unknown = await handleA2ARequest(
      { jsonrpc: '2.0', id: 4, method: 'message/stream', params: {} },
      { tasks: tasks() }
    )
    expect((unknown.body as { error: { code: number } }).error.code).toBe(-32601)

    const malformed = await handleA2ARequest({ id: 5, method: 'message/send' }, { tasks: tasks() })
    expect((malformed.body as { error: { code: number } }).error.code).toBe(-32600)

    const noText = await handleA2ARequest(
      { jsonrpc: '2.0', id: 6, method: 'message/send', params: { message: { parts: [] } } },
      { tasks: tasks() }
    )
    expect((noText.body as { error: { code: number } }).error.code).toBe(-32602)
  })
})
