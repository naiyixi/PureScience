// The external MCP server: the app-side half of `purescience mcp`.
//
// An outside MCP client (a desktop assistant, a script) launches `purescience mcp`, which bridges its stdio
// JSON-RPC to the loopback endpoint this server listens on. Three properties matter and each has a test:
//
// 1. The reachable set is the declared one. `tools/list` is served straight from `surface.ts`, and every
//    handler goes through the injected `invoke` port, which the composition root binds to the narrow
//    external-MCP command whitelist — not to the Web/desktop dispatcher.
// 2. The caller is not `human`. `invoke` builds an `external-mcp` caller context, so a command that gates
//    on a human principal refuses it. (`canSatisfyHumanApproval` is false for it by construction.)
// 3. Every call leaves one line. `external mcp call` carries the tool, its risk, the outcome, the refusal
//    code when refused, and the duration — the operational counterpart of the broker's audit line, which
//    becomes the audit of record once a write tool exists.
//
// This slice declares only `risk: 'read'` tools, so no call can cross the permission gate yet. That is a
// property of the surface, not an omission in the dispatch path: `dispatchToolCall` refuses any tool whose
// risk is not `read` before it invokes anything, so adding a write tool without wiring the gate fails
// closed instead of performing an unapproved write.

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { ServerResponse } from 'node:http'

import { Server as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import type { PersistedChatSession } from '../../shared/session-persistence'
import { createLogger } from '../logger'
import { listenForLocalRpc, localRpcServerLogFields } from '../local-rpc-transport'
import {
  EXTERNAL_MCP_TOOLS,
  externalMcpToolById,
  projectRow,
  sessionExcerpt,
  sessionRow,
  type ExternalMcpToolId
} from './surface'
import { removeExternalMcpState, writeExternalMcpState } from './state-file'

const log = createLogger('external-mcp')

const EXTERNAL_MCP_SERVER_NAME = 'purescience'
const EXTERNAL_MCP_SERVER_VERSION = '1.0.0'

// The one place a tool's reach is decided. The composition root binds it to the external-MCP command
// whitelist and to an `external-mcp` caller context; the server itself never sees the router.
export type ExternalMcpInvoke = (input: {
  /** Per-connection id, so two clients keep separate caller leases. */
  clientId: string
  commandName: string
  args: readonly unknown[]
}) => Promise<unknown>

export type ExternalMcpServerOptions = Readonly<{
  invoke: ExternalMcpInvoke
  /** Where the discovery file (endpoint + token) is published for `purescience mcp`. */
  configRoot: string
  createId?: () => string
  now?: () => number
}>

// A refusal a client can act on. `code` is machine-readable and part of the contract; the message is what
// the outside model reads, so it names the missing field or the thing that was not found.
class ExternalMcpRefusal extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ExternalMcpRefusal'
  }
}

type ToolCallInput = Readonly<{
  clientId: string
  args: Record<string, unknown>
}>

type ToolHandler = (input: ToolCallInput) => Promise<unknown>

const optionalString = (args: Record<string, unknown>, field: string): string | undefined => {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ExternalMcpRefusal('invalid-argument', `\`${field}\` must be a non-empty string.`)
  }
  return value
}

const requiredString = (args: Record<string, unknown>, field: string): string => {
  const value = optionalString(args, field)
  if (value === undefined) {
    throw new ExternalMcpRefusal('missing-argument', `\`${field}\` is required.`)
  }
  return value
}

const optionalPositiveInteger = (
  args: Record<string, unknown>,
  field: string
): number | undefined => {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new ExternalMcpRefusal('invalid-argument', `\`${field}\` must be a positive number.`)
  }
  return Math.floor(value)
}

type ProjectRow = { id: string; name: string; description?: string }
type SessionCatalogResult = {
  // `sessions:list-catalog` answers with the list-tier projection (`SessionCatalogSummary`), which drops
  // the heavy conversation fields and carries `messageCount`. Typing it as a full document here would
  // promise fields the command does not return.
  sessions: readonly (Omit<
    PersistedChatSession,
    'messages' | 'conversationGraph' | 'activities' | 'activityGroups'
  > & {
    messageCount: number
  })[]
}

// Handlers are a total record over the declared ids: adding a tool to the surface without writing its
// handler is a type error, and the paired suite asserts the same thing at runtime.
const createToolHandlers = (invoke: ExternalMcpInvoke): Record<ExternalMcpToolId, ToolHandler> => {
  // A project may be named by id or by exact name. The resolution is against the app's own list, and an
  // unknown value is a named refusal: answering with every project's data for a typo is a wrong answer
  // that looks right. Both tools that take a project go through here so they cannot disagree.
  const resolveProject = async (clientId: string, requested: string): Promise<ProjectRow> => {
    const projects = (await invoke({
      clientId,
      commandName: 'projects:list',
      args: []
    })) as ProjectRow[]
    const match = projects.find((project) => project.id === requested || project.name === requested)
    if (!match) {
      throw new ExternalMcpRefusal(
        'project-not-found',
        `No project matches "${requested}". Call list_projects for the ids and exact names.`
      )
    }
    return match
  }

  return {
    list_projects: async ({ clientId }) => {
      const projects = (await invoke({
        clientId,
        commandName: 'projects:list',
        args: []
      })) as ProjectRow[]
      const rows = projects.map(projectRow)
      return { count: rows.length, projects: rows }
    },

    list_sessions: async ({ clientId, args }) => {
      const requested = optionalString(args, 'project')
      const projectId =
        requested === undefined ? undefined : (await resolveProject(clientId, requested)).id

      const catalog = (await invoke({
        clientId,
        commandName: 'sessions:list-catalog',
        args: []
      })) as SessionCatalogResult
      const sessions = catalog.sessions ?? []
      const filtered = projectId
        ? sessions.filter((session) => session.projectId === projectId)
        : sessions
      return {
        ...(projectId ? { projectId } : {}),
        count: filtered.length,
        sessions: filtered.map(sessionRow)
      }
    },

    read_session: async ({ clientId, args }) => {
      const sessionId = requiredString(args, 'sessionId')
      const limit = optionalPositiveInteger(args, 'limit')
      const catalog = (await invoke({
        clientId,
        commandName: 'sessions:list-catalog',
        args: []
      })) as SessionCatalogResult
      const entry = (catalog.sessions ?? []).find((session) => session.id === sessionId)
      if (!entry) {
        throw new ExternalMcpRefusal(
          'session-not-found',
          `No session has id "${sessionId}". Call list_sessions for the ids this machine holds.`
        )
      }
      const document = (await invoke({
        clientId,
        commandName: 'sessions:read-document',
        args: [{ projectId: entry.projectId, sessionId }]
      })) as PersistedChatSession
      return sessionExcerpt(document, limit)
    },

    list_project_files: async ({ clientId, args }) => {
      // The artifacts command keys its storage directory by the project **id**, not its display name —
      // its request field is named `projectName` but every real caller (the renderer, the task API)
      // passes the id, and any value with a space or slash is refused as an unsafe path segment. So the
      // id this resolves to is what travels, not whatever the client typed.
      const project = await resolveProject(clientId, requiredString(args, 'project'))
      const files = (await invoke({
        clientId,
        commandName: 'artifacts:list-project-files',
        args: [{ projectName: project.id }]
      })) as readonly Record<string, unknown>[]
      return { projectId: project.id, count: files.length, files }
    }
  }
}

type ToolOutcome = 'ok' | 'refused' | 'failed'

// The permission gate for the external surface, as a value that can be tested without registering a write
// tool: today every declared tool is a read, so this returns "allowed" for all of them. The refused branch
// is what a future write tool hits before it can act — it fails closed and says what would have happened.
const externalMcpRiskGate = (tool: {
  id: string
  risk: string
}): Readonly<{ allowed: true }> | Readonly<{ allowed: false; code: string; message: string }> => {
  if (tool.risk === 'read') return { allowed: true }
  return {
    allowed: false,
    code: 'permission-gate-not-wired',
    message:
      `"${tool.id}" would change data, and an outside client has no authority to approve that yet. ` +
      'Nothing was changed.'
  }
}

const refusalResult = (
  error: unknown
): { content: { type: 'text'; text: string }[]; isError: true } => {
  const refusal =
    error instanceof ExternalMcpRefusal
      ? error
      : new ExternalMcpRefusal(
          'command-failed',
          error instanceof Error ? error.message : String(error)
        )
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: { code: refusal.code, message: refusal.message } })
      }
    ],
    isError: true
  }
}

export class ExternalMcpServer {
  private readonly token: string
  private readonly httpServer: Server
  private readonly handlers: Record<ExternalMcpToolId, ToolHandler>
  private readonly transports = new Map<string, StreamableHTTPServerTransport>()
  private readonly servers = new Set<ModelContextProtocolServer>()
  private _endpoint: string | undefined
  private started = false
  private stopped = false
  // Set only when this instance published the discovery file: a failed start (port already in use) must
  // never delete the file of the instance that does own that port.
  private publishedState = false

  constructor(private readonly options: ExternalMcpServerOptions) {
    this.token = randomUUID()
    this.handlers = createToolHandlers(options.invoke)
    this.httpServer = createServer((request, response) => {
      void this.handleHttpRequest(request, response)
    })
  }

  /** Publishes the endpoint for `purescience mcp` and starts listening on loopback only. */
  async start(): Promise<{ endpoint: string; token: string }> {
    if (this.started) throw new Error('External MCP server is already started.')
    const connection = await listenForLocalRpc(this.httpServer, {
      name: 'external-mcp',
      // Loopback TCP on every platform: unlike the reviewer's child process, an outside client is a
      // separate, user-installed program and cannot be handed a Windows named pipe it has no path to.
      transport: 'tcp'
    })
    this._endpoint = `${connection.endpoint}/mcp`
    this.started = true
    await writeExternalMcpState(this.options.configRoot, {
      pid: process.pid,
      endpoint: this._endpoint,
      token: this.token,
      startedAt: new Date(this.now()).toISOString()
    })
    this.publishedState = true
    log.info('external MCP server started', {
      ...localRpcServerLogFields(this.httpServer),
      tools: EXTERNAL_MCP_TOOLS.length,
      stateFile: 'external-mcp.json'
    })
    return { endpoint: this._endpoint, token: this.token }
  }

  /** Stops listening and withdraws the discovery file. Safe to call twice, and after a failed start. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const connection = localRpcServerLogFields(this.httpServer)
    for (const transport of this.transports.values()) {
      await transport.close().catch(() => undefined)
    }
    this.transports.clear()
    this.servers.clear()
    if (this.started) {
      await new Promise<void>((resolve) => this.httpServer.close(() => resolve()))
    }
    if (this.publishedState) {
      await removeExternalMcpState(this.options.configRoot).catch((error: unknown) => {
        log.warn('external MCP state removal failed', {
          message: error instanceof Error ? error.message : String(error)
        })
      })
      this.publishedState = false
    }
    log.info('external MCP server stopped', {
      ...connection,
      listening: this.httpServer.listening
    })
  }

  endpoint(): string | undefined {
    return this._endpoint
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private createId(): string {
    return this.options.createId?.() ?? randomUUID()
  }

  // A fresh MCP server per connection: the SDK connects one Server instance to one transport, and two
  // outside clients must not share a request-handler graph.
  private buildMcpServer(sessionId: string): ModelContextProtocolServer {
    const server = new ModelContextProtocolServer(
      { name: EXTERNAL_MCP_SERVER_NAME, version: EXTERNAL_MCP_SERVER_VERSION },
      { capabilities: { tools: {} } }
    )

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: EXTERNAL_MCP_TOOLS.map((tool) => ({
        name: tool.id,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    }))

    server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.dispatchToolCall(sessionId, request.params.name, request.params.arguments)
    )

    return server
  }

  private async dispatchToolCall(
    clientId: string,
    name: string,
    rawArguments: unknown
  ): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
    const toolCallId = this.createId()
    const startedAt = this.now()
    const tool = externalMcpToolById(name)
    const args =
      typeof rawArguments === 'object' && rawArguments !== null
        ? (rawArguments as Record<string, unknown>)
        : {}

    const finish = (outcome: ToolOutcome, code?: string): void => {
      log.info('external mcp call', {
        toolCallId,
        tool: name,
        clientId,
        risk: tool?.risk ?? 'unknown',
        outcome,
        ...(code ? { code } : {}),
        durationMs: this.now() - startedAt
      })
    }

    if (!tool) {
      finish('refused', 'unknown-tool')
      return refusalResult(
        new ExternalMcpRefusal(
          'unknown-tool',
          `This app exposes no tool named "${name}". Call tools/list for the ones it does.`
        )
      )
    }

    if (tool.risk !== 'read') {
      // Fail closed. Nothing declared today reaches this branch; it exists so the first write tool cannot
      // run before the permission gate is wired, and the refusal says what it would have done.
      const gate = externalMcpRiskGate(tool)
      if (!gate.allowed) {
        finish('refused', gate.code)
        return refusalResult(new ExternalMcpRefusal(gate.code, gate.message))
      }
    }

    try {
      const payload = await this.handlers[tool.id]({ clientId, args })
      finish('ok')
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
    } catch (error) {
      // A refusal and a failure are different facts for whoever reads the log: the first means the client
      // asked for something that is not there (or asked wrongly) and nothing was attempted; the second
      // means the app tried and could not answer. Both carry a code, so neither is a silent empty result.
      const code = error instanceof ExternalMcpRefusal ? error.code : 'command-failed'
      finish(error instanceof ExternalMcpRefusal ? 'refused' : 'failed', code)
      return refusalResult(error)
    }
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (!this.isLoopbackHost(request.headers.host)) {
      response.writeHead(421, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Misdirected Request: non-loopback Host' }))
      return
    }

    const authHeader = request.headers['authorization'] ?? ''
    const bearer =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (bearer !== this.token) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    const sessionId = request.headers['mcp-session-id']
    const existing = typeof sessionId === 'string' ? this.transports.get(sessionId) : undefined

    let transport: StreamableHTTPServerTransport
    if (existing) {
      transport = existing
    } else if (sessionId === undefined && request.method === 'POST') {
      // `initialize` is the only request without a session id. `enableJsonResponse` keeps each reply a
      // single JSON body instead of an SSE stream — the CLI bridge forwards bytes, so a stream it cannot
      // parse would turn every call into a timeout.
      const connectionId = this.createId()
      const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          this.transports.set(id, created)
        }
      })
      const server = this.buildMcpServer(connectionId)
      this.servers.add(server)
      created.onclose = () => {
        this.servers.delete(server)
        if (created.sessionId) {
          this.transports.delete(created.sessionId)
          log.info('external MCP session closed', { sessionId: created.sessionId })
        }
      }
      await server.connect(created)
      transport = created
    } else {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Bad Request: missing or unknown mcp-session-id' }))
      return
    }

    await transport.handleRequest(request, response)
  }

  // Loopback only, and the Host header must agree: a page on another origin cannot reach this listener via
  // DNS rebinding, and a request addressed to a public name is refused before the token is even compared.
  private isLoopbackHost(host: string | undefined): boolean {
    if (host === undefined) return false
    const hostname = host.includes(']') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  }
}

export { EXTERNAL_MCP_SERVER_NAME, ExternalMcpRefusal, externalMcpRiskGate }
