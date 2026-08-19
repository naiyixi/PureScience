import { randomUUID } from 'node:crypto'

import type { AcpRuntimeEvent } from '../../shared/acp'
import type { FinalizeRunArtifactsResult } from '../../shared/artifacts'
import type { Project } from '../../shared/projects'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createApplicationCommandClient } from '../application-command-client'
import type { ApplicationCommandByNameDispatcher } from '../application-command-composition'
import { createTaskCallerContext } from '../caller-context'
import { TaskRunner, type TaskAgentPort } from '../tasks/task-runner'
import type { ToolContext } from './types'

// Multi-agent orchestration (delegate_tasks): bridges the connector tool layer to the app's
// task-runner seam. Each delegated sub-task becomes a fresh agent session under the app's ACTIVE
// provider/model — the task seam's createSession does not expose per-session model selection, so a
// requested `model` override is accepted for API compatibility but not applied. Sub-agents run
// unattended with permissionProfile 'auto' ('ask' would hang a headless sub-agent on a permission
// dialog with no UI to approve it). Runs persist under a dedicated 'delegate-tasks' project that is
// auto-created on first use and accumulates task sessions (the same known behavior as web-service
// task runs). A sub-agent that exceeds its timeout keeps running in the background — the task seam
// has no abort path — and its run eventually completes and persists under the same project.

const DELEGATE_PROJECT_NAME = 'delegate-tasks'
const DEFAULT_SUB_AGENT_TIMEOUT_MS = 300_000
const SUB_AGENT_CALLER_CONTEXT = createTaskCallerContext()

type SubAgentExecutorDependencies = {
  commands: ApplicationCommandByNameDispatcher
  agent: TaskAgentPort
  subscribeEvents?: (listener: (event: AcpRuntimeEvent) => void) => () => void
}

type SubAgentExecutor = {
  runSubAgent: NonNullable<ToolContext['runSubAgent']>
  dispose: () => void
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let handle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      reject(new Error(`Sub-agent timed out after ${timeoutMs} ms.`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (handle) clearTimeout(handle)
  }
}

const createSubAgentExecutor = (dependencies: SubAgentExecutorDependencies): SubAgentExecutor => {
  const commandClient = createApplicationCommandClient()
  const subscribeEvents = dependencies.subscribeEvents ?? (() => () => undefined)
  const runner = new TaskRunner({
    projects: {
      list: () =>
        commandClient.invoke(
          dependencies.commands,
          'projects:list',
          SUB_AGENT_CALLER_CONTEXT,
          []
        ) as Promise<Project[]>,
      create: (request) =>
        commandClient.invoke(dependencies.commands, 'projects:create', SUB_AGENT_CALLER_CONTEXT, [
          request
        ]) as Promise<Project>
    },
    sessions: {
      list: async () => {
        const result = (await commandClient.invoke(
          dependencies.commands,
          'sessions:load-all',
          SUB_AGENT_CALLER_CONTEXT,
          []
        )) as { sessions: PersistedChatSession[] }
        return result.sessions
      },
      save: (session) =>
        commandClient.invoke(
          dependencies.commands,
          'sessions:save-session',
          SUB_AGENT_CALLER_CONTEXT,
          [session]
        ) as Promise<void>
    },
    agent: dependencies.agent,
    // Delegate sub-agents are text-only — the executor never finalizes artifact ownership itself.
    artifacts: {
      finalizeRun: async (): Promise<FinalizeRunArtifactsResult> => ({ ok: true, artifacts: [] })
    },
    previewResources: {
      acquire: async () => {
        throw new Error('Delegate sub-agents do not acquire preview resources.')
      },
      release: async () => undefined
    },
    runtimeEvents: { subscribe: subscribeEvents },
    createId: randomUUID,
    now: Date.now
  })

  // Single-flight project bootstrap: TaskRunner.resolveProject does NOT auto-create in this base
  // (it throws project_not_found), and two parallel first-use sub-agents must not race two
  // projects:create calls.
  let ensureProjectPromise: Promise<Project> | undefined
  const ensureDelegateProject = (): Promise<Project> => {
    if (!ensureProjectPromise) {
      ensureProjectPromise = (async () => {
        const projects = await runner.listProjects()
        const existing = projects.find(
          (project) =>
            project.name === DELEGATE_PROJECT_NAME || project.id === DELEGATE_PROJECT_NAME
        )
        if (existing) return existing
        return runner.createProject({ name: DELEGATE_PROJECT_NAME })
      })().catch((error) => {
        ensureProjectPromise = undefined
        throw error
      })
    }
    return ensureProjectPromise
  }

  const runSubAgent: SubAgentExecutor['runSubAgent'] = async (request) => {
    try {
      await ensureDelegateProject()
      const prompt = [
        request.prompt,
        ...(request.completionContract?.length
          ? [
              `\n\nInclude each of the following in your final answer: ${request.completionContract.join(
                '; '
              )}`
            ]
          : [])
      ].join('')
      const run = await runner.startRun({
        project: DELEGATE_PROJECT_NAME,
        prompt,
        permissionProfile: 'auto'
      })
      const completed = await withTimeout(
        runner.waitForRun(run.id),
        request.timeoutMs ?? DEFAULT_SUB_AGENT_TIMEOUT_MS
      )
      if (completed.status === 'failed') {
        return {
          output: completed.output ?? '',
          error: completed.error ?? 'Sub-agent run failed.'
        }
      }
      return { output: completed.output ?? '' }
    } catch (error) {
      return {
        output: '',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  return {
    runSubAgent,
    dispose: () => {
      runner.dispose()
      commandClient.dispose()
    }
  }
}

export { createSubAgentExecutor }
export type { SubAgentExecutor, SubAgentExecutorDependencies }
