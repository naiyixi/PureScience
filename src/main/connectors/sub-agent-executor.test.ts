import { describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import type { Project } from '../../shared/projects'
import type { TaskAgentPort } from '../tasks/task-runner'
import {
  createSubAgentExecutor,
  type SubAgentExecutor,
  type SubAgentExecutorDependencies
} from './sub-agent-executor'

const makeProject = (name: string, id = `project-${name}`): Project => ({
  id,
  name,
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
})

// Faithful to ApplicationCommandByNameDispatcher.invoke: (commandName, { callerContext,
// callerLease, args }) — the application-command-client wrapper supplies the latter two.
const createDispatcher = (
  initialProjects: Project[] = []
): {
  commands: SubAgentExecutorDependencies['commands']
  invoke: ReturnType<typeof vi.fn>
  projects: Project[]
} => {
  const projects = [...initialProjects]
  const invoke = vi.fn(async (commandName: string, invocation: { args: readonly unknown[] }) => {
    const args = invocation.args ?? []
    switch (commandName) {
      case 'projects:list':
        return projects
      case 'projects:create': {
        const request = args[0] as { name: string }
        const created = makeProject(request.name)
        projects.push(created)
        return created
      }
      case 'sessions:load-all':
        return { sessions: [] }
      case 'sessions:save-session':
        return undefined
      default:
        throw new Error(`unexpected command: ${commandName}`)
    }
  })
  const commands = { invoke } as unknown as SubAgentExecutorDependencies['commands']
  return { commands, invoke, projects }
}

type MockedAgentPort = {
  [K in keyof TaskAgentPort]: ReturnType<typeof vi.fn>
}

const createAgent = (overrides: Partial<TaskAgentPort> = {}): MockedAgentPort => {
  const agent = {
    withSessionAvailable: vi.fn(
      async (_projectId: string, _sessionId: string, operation: () => Promise<unknown>) =>
        operation()
    ),
    listAttachedSessionIds: vi.fn(async () => []),
    createSession: vi.fn(async () => ({ sessionId: 'session-1' })),
    resumeSession: vi.fn(async () => ({ sessionId: 'session-1' })),
    setPermissionProfile: vi.fn(async () => undefined),
    prompt: vi.fn(async () => undefined),
    ...overrides
  }
  return agent as unknown as MockedAgentPort
}

const createHarness = (
  options: { initialProjects?: Project[]; agent?: Partial<TaskAgentPort> } = {}
): {
  dispatcher: ReturnType<typeof createDispatcher>
  agent: ReturnType<typeof createAgent>
  executor: SubAgentExecutor
  emitEvent: () => ((event: AcpRuntimeEvent) => void) | undefined
} => {
  const dispatcher = createDispatcher(options.initialProjects)
  const agent = createAgent(options.agent)
  let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
  const executor = createSubAgentExecutor({
    commands: dispatcher.commands,
    agent: agent as unknown as TaskAgentPort,
    subscribeEvents: (listener) => {
      emitEvent = listener
      return () => undefined
    }
  })
  return { dispatcher, agent, executor, emitEvent: () => emitEvent }
}

const assistantTurnEvents = (sessionId = 'session-1'): AcpRuntimeEvent[] => [
  {
    id: 'event-1',
    timestamp: 10,
    kind: 'message',
    level: 'info',
    sessionId,
    role: 'assistant',
    text: 'Research complete.'
  },
  {
    id: 'event-2',
    timestamp: 11,
    kind: 'stop',
    level: 'info',
    sessionId,
    text: 'end_turn'
  }
]

describe('createSubAgentExecutor', () => {
  it('bootstraps the delegate project, runs a sub-agent and returns its output', async () => {
    const { dispatcher, agent, executor, emitEvent } = createHarness()
    agent.prompt.mockImplementation(async () => {
      for (const event of assistantTurnEvents()) emitEvent()?.(event)
    })

    const outcome = await executor.runSubAgent({ prompt: 'Summarize these papers.' })

    expect(outcome).toEqual({ output: 'Research complete.' })
    expect(dispatcher.invoke).toHaveBeenCalledWith(
      'projects:create',
      expect.objectContaining({ args: [{ name: 'delegate-tasks' }] })
    )
    expect(agent.createSession).toHaveBeenCalledWith({
      projectId: 'project-delegate-tasks',
      permissionProfile: 'auto'
    })
    expect(agent.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Summarize these papers.' })
    )
  })

  it('reuses an existing delegate project instead of creating a second one', async () => {
    const existing = makeProject('delegate-tasks')
    const { dispatcher, agent, executor, emitEvent } = createHarness({
      initialProjects: [existing]
    })
    agent.prompt.mockImplementation(async () => {
      for (const event of assistantTurnEvents()) emitEvent()?.(event)
    })

    await executor.runSubAgent({ prompt: 'Quick review.' })

    expect(dispatcher.invoke).not.toHaveBeenCalledWith('projects:create', expect.anything())
    expect(agent.createSession).toHaveBeenCalledWith({
      projectId: existing.id,
      permissionProfile: 'auto'
    })
  })

  it('surfaces the completion contract inside the sub-agent prompt', async () => {
    const { agent, executor, emitEvent } = createHarness()
    agent.prompt.mockImplementation(async () => {
      for (const event of assistantTurnEvents()) emitEvent()?.(event)
    })

    await executor.runSubAgent({
      prompt: 'Compare the two approaches.',
      completionContract: ['advantages', 'limitations']
    })

    const promptCall = agent.prompt.mock.calls[0]?.[0] as { text: string }
    expect(promptCall.text).toContain('Compare the two approaches.')
    expect(promptCall.text).toContain('advantages; limitations')
  })

  it('reports a failed run as an error outcome instead of throwing', async () => {
    const { executor, agent } = createHarness()
    agent.prompt.mockRejectedValueOnce(new Error('prompt boom'))

    const outcome = await executor.runSubAgent({ prompt: 'Will fail.' })

    expect(outcome.error).toBe('prompt boom')
    expect(outcome.output).toBe('')
  })

  it('times out a sub-agent that never completes and reports the timeout', async () => {
    const { executor, agent } = createHarness()
    agent.prompt.mockImplementation(() => new Promise(() => undefined))

    const outcome = await executor.runSubAgent({ prompt: 'Hangs forever.', timeoutMs: 30 })

    expect(outcome.output).toBe('')
    expect(outcome.error).toContain('timed out after 30 ms')
  })

  it('dispose stops event capture without throwing', () => {
    const { executor } = createHarness()
    expect(() => executor.dispose()).not.toThrow()
  })
})
