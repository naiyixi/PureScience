// A2A (Agent2Agent) surface: a card an external agent can read, and a JSON-RPC `message/send` that maps
// onto the same headless task API the CLI uses.
//
// Why this exists at all: `/api/v1/agent-card` is PureScience's own capability statement, not an A2A
// AgentCard — it has no `url`, no `protocolVersion`, no `skills[]` — and there was no JSON-RPC endpoint at
// all (measured 2026-10-27: `message/send` returned 404 on /, /a2a, /api/v1/a2a and /message/send). So the
// card said `interop.a2a: 'unverified'` and it was telling the truth. This module is the minimum that makes
// the claim testable: a card in A2A shape plus one method, `message/send`, with a synchronous reply.
//
// Deliberately NOT implemented: `message/stream`, `tasks/cancel`, push notifications. The card says
// `streaming: false` and `pushNotifications: false` so a client can tell instead of guessing.
import type { TaskRun, TaskRunStatus } from '../../shared/task-api'

/** The slice of the headless task API this surface needs. */
export type A2ATaskSource = {
  listProjects: () => Promise<Array<{ id: string; name: string }>>
  startRun: (request: { project: string; prompt: string }) => Promise<TaskRun>
  getRun: (runId: string) => TaskRun
}

export type A2ACardInput = {
  /** Absolute base URL an external agent should POST to (no token: the caller adds its own). */
  baseUrl: string
  version: string
  platform: string
  /** The build's capability ids, projected as A2A skills. */
  capabilities: readonly string[]
}

const A2A_PROTOCOL_VERSION = '0.2.3'

export const buildA2AAgentCard = (input: A2ACardInput): Record<string, unknown> => ({
  protocolVersion: A2A_PROTOCOL_VERSION,
  name: 'PureScience',
  description:
    'Local-first scientific workbench agent: artifacts, notebooks, plans, references and PDFs, exposed over the same headless task API the CLI uses.',
  url: input.baseUrl,
  preferredTransport: 'JSONRPC',
  version: input.version,
  provider: {
    organization: 'NEOlab',
    url: 'https://github.com/naiyixi/PureScience'
  },
  // Both false on purpose: claiming them would be a promise this transport does not keep.
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: input.capabilities.map((capability) => ({
    id: capability,
    name: capability,
    description: `PureScience capability "${capability}", attached to every session this build creates.`,
    tags: ['purescience', 'science', input.platform],
    examples: [],
    inputModes: ['text/plain'],
    outputModes: ['text/plain']
  }))
})

const TERMINAL: ReadonlySet<TaskRunStatus> = new Set<TaskRunStatus>(['completed', 'failed'])

const textOfMessage = (message: unknown): string => {
  if (typeof message !== 'object' || message === null) return ''
  const parts = (message as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return ''
  return parts
    .map((part) => {
      if (typeof part !== 'object' || part === null) return ''
      const record = part as { kind?: unknown; text?: unknown }
      return record.kind === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .filter((text) => text.length > 0)
    .join('\n')
}

const projectOfMessage = (message: unknown, override: unknown): string | undefined => {
  if (typeof override === 'string' && override.trim().length > 0) return override.trim()
  if (typeof message !== 'object' || message === null) return undefined
  const metadata = (message as { metadata?: unknown }).metadata
  if (typeof metadata !== 'object' || metadata === null) return undefined
  const project = (metadata as { project?: unknown }).project
  return typeof project === 'string' && project.trim().length > 0 ? project.trim() : undefined
}

const taskStateOf = (status: TaskRunStatus): 'working' | 'completed' | 'failed' =>
  status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'working'

const taskOf = (run: TaskRun, contextId: string): Record<string, unknown> => ({
  id: run.sessionId,
  contextId,
  kind: 'task',
  status: {
    state: taskStateOf(run.status),
    timestamp: new Date(run.completedAt ?? run.startedAt).toISOString(),
    ...(run.error ? { message: { role: 'agent', parts: [{ kind: 'text', text: run.error }] } } : {})
  },
  // Only a completed run has an artifact: a `working` reply carrying partial text would read as a
  // finished result to any client that stores what it receives.
  artifacts:
    run.status === 'completed' && typeof run.output === 'string' && run.output.length > 0
      ? [
          {
            artifactId: `${run.id}-output`,
            name: 'output',
            parts: [{ kind: 'text', text: run.output }]
          }
        ]
      : [],
  metadata: { runId: run.id, projectId: run.projectId, sessionId: run.sessionId }
})

export type A2AOutcome = { status: number; body: Record<string, unknown> }

const rpcError = (id: unknown, code: number, message: string, status = 200): A2AOutcome => ({
  status,
  body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
})

export type A2ARequestDeps = {
  tasks: A2ATaskSource
  /** How long a blocking `message/send` waits for the run before answering `working`. */
  blockingTimeoutMs?: number
  now?: () => number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const handleA2ARequest = async (
  payload: unknown,
  deps: A2ARequestDeps
): Promise<A2AOutcome> => {
  if (typeof payload !== 'object' || payload === null) {
    return rpcError(null, -32700, 'Parse error: body must be a JSON-RPC object.')
  }
  const request = payload as {
    jsonrpc?: unknown
    id?: unknown
    method?: unknown
    params?: unknown
  }
  if (request.jsonrpc !== '2.0')
    return rpcError(request.id, -32600, 'Invalid Request: jsonrpc must be "2.0".')
  const id = request.id ?? null
  const params = (request.params ?? {}) as Record<string, unknown>

  if (request.method === 'message/send') {
    const message = params.message
    const prompt = textOfMessage(message)
    if (prompt.trim().length === 0) {
      return rpcError(
        id,
        -32602,
        'Invalid params: message.parts must carry at least one text part.'
      )
    }
    const requested = projectOfMessage(message, params.project)
    let project = requested
    if (!project) {
      // No implicit "first project" guess: a message with no project goes to the only project when there
      // is exactly one, and is refused with a named error otherwise. Guessing here would write into
      // whichever project happened to sort first.
      const projects = await deps.tasks.listProjects()
      if (projects.length === 1) project = projects[0]?.id
      if (projects.length > 1) {
        return rpcError(
          id,
          -32602,
          `Invalid params: message.metadata.project is required when this instance has ${projects.length} projects.`
        )
      }
    }
    if (!project) {
      return rpcError(
        id,
        -32602,
        'Invalid params: message.metadata.project is required (no projects exist).'
      )
    }

    let run: TaskRun
    try {
      run = await deps.tasks.startRun({ project, prompt })
    } catch (error) {
      return rpcError(id, -32603, `Run could not be started: ${(error as Error).message}`)
    }

    const contextId = `ctx-${run.sessionId}`
    const deadline = (deps.now?.() ?? Date.now()) + (deps.blockingTimeoutMs ?? 120_000)
    let current = run
    while (!TERMINAL.has(current.status) && (deps.now?.() ?? Date.now()) < deadline) {
      await sleep(500)
      current = deps.tasks.getRun(run.id)
    }
    return { status: 200, body: { jsonrpc: '2.0', id, result: taskOf(current, contextId) } }
  }

  if (request.method === 'tasks/get') {
    const taskId = typeof params.id === 'string' ? params.id : undefined
    if (!taskId) return rpcError(id, -32602, 'Invalid params: id is required.')
    try {
      const run = deps.tasks.getRun(taskId)
      return {
        status: 200,
        body: { jsonrpc: '2.0', id, result: taskOf(run, `ctx-${run.sessionId}`) }
      }
    } catch {
      return rpcError(id, -32001, `Task not found: ${taskId}`)
    }
  }

  return rpcError(id, -32601, `Method not found: ${String(request.method)}`)
}
