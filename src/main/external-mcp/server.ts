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
//    code when refused, the approval decision when there was one, and the duration — the operational
//    counterpart of the broker's `permission decision` line, which carries the same `toolCallId`.
//
// One tool declares `risk: 'write'` (`archive_session`), and its path has three steps that cannot be
// reordered or skipped: resolve the target with reads, park the act on the app's own approval card (the
// same broker the agent's tool calls use), and only then perform it. A write with no planner, a card
// nobody can answer, and an answer that is not "approved" each end in a named refusal with nothing
// changed, so this gate can fail closed but never open.

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
  /**
   * Parks an outside client's write on the app's approval card. Absent means "no approval surface" — every
   * write tool then refuses with `approval-unavailable` instead of running unapproved.
   */
  requestApproval?: ExternalMcpRequestApproval
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

// The ids whose surface entry says `risk: 'write'`. Typing them here (and pairing the list with the surface
// in the suite) is what turns "this tool needs the gate" into a compile-time fact: the read handlers are a
// total record over the remaining ids, so a new read tool without an implementation does not compile, and a
// write tool that is not listed here has no planner and is refused at runtime.
export const EXTERNAL_MCP_WRITE_TOOL_IDS = Object.freeze(['archive_session'] as const)
type WriteToolId = (typeof EXTERNAL_MCP_WRITE_TOOL_IDS)[number]
type ReadToolId = Exclude<ExternalMcpToolId, WriteToolId>

// What a write tool knows once it has resolved its target: a sentence for the card, the arguments the card
// shows (the resolved ones, not only what the client typed), and the act itself. Planning performs reads
// only, which is why the card can name the target and a typo never costs the reader an approval.
type WritePlan = Readonly<{
  title: string
  /** The conversation the card is parked on, so the reader answers where the change applies. */
  sessionId?: string
  rawInput: Record<string, unknown>
  /** Performs the change. Called only after the card answered "approved". */
  act: () => Promise<unknown>
}>

type WritePlanner = (input: ToolCallInput) => Promise<WritePlan>

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

// Handlers are a total record over the declared read ids: adding a read tool to the surface without
// writing its handler is a type error, and the paired suite asserts the same thing at runtime.
const createReadHandlers = (invoke: ExternalMcpInvoke): Record<ReadToolId, ToolHandler> => {
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

// The write tools, each as a plan rather than a handler. The dispatcher builds the plan (reads only), shows
// the card with what the plan resolved, and calls `act` only after the answer is "approved" — so the target
// lookup that names a typo happens before anybody is asked, and the act cannot run on its own.
const createWritePlans = (invoke: ExternalMcpInvoke): Record<WriteToolId, WritePlanner> => ({
  // Two things about archiving are deliberate:
  //
  // 1. It resolves the row from the list tier instead of round-tripping the whole document. The archive
  //    request needs `projectId` and the current `archivedAt` for its optimistic-concurrency check, and the
  //    list row carries both; a read-document/save-session round trip would write back a document whose
  //    heavy members (`activities`, `conversationGraph`) the list projection does not carry.
  // 2. A conversation that is already archived is refused here rather than re-sent as an identical write:
  //    the card would be asking the reader to approve a change that changes nothing.
  archive_session: async ({ clientId, args }) => {
    const sessionId = requiredString(args, 'sessionId')
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
    if (typeof entry.archivedAt === 'number' && entry.archivedAt > 0) {
      throw new ExternalMcpRefusal(
        'already-archived',
        `Session "${sessionId}" is already archived; nothing was changed.`
      )
    }
    const titled = typeof entry.title === 'string' ? entry.title.trim() : ''
    return {
      // The card names the conversation, not just an id: the reader is being asked to approve a change to
      // something they can recognise, and the id alone would make that a guess.
      title: `An outside MCP client asks to archive ${titled === '' ? `session “${sessionId}”` : `“${titled}”`}`,
      sessionId,
      // The card shows what was resolved, so what it describes is what will happen.
      rawInput: { sessionId, projectId: entry.projectId, archived: true },
      act: async () => {
        const updated = (await invoke({
          clientId,
          commandName: 'sessions:update-archive',
          args: [
            {
              projectId: entry.projectId,
              sessionId,
              archived: true,
              // The row said this conversation is live, so the state the write expects to find is "no
              // archivedAt". A concurrent archive makes the command refuse instead of overwriting.
              expectedArchivedAt: null
            }
          ]
        })) as { archivedAt?: number }
        return {
          sessionId,
          projectId: entry.projectId,
          archived: true,
          ...(typeof updated.archivedAt === 'number' ? { archivedAt: updated.archivedAt } : {})
        }
      }
    }
  }
})

type ToolOutcome = 'ok' | 'refused' | 'failed'

// How an outside client's write reaches the app's own approval card. Bound by the composition root to the
// same broker the agent's tool calls use, so there is one approval surface and one audit line — not a
// second consent mechanism invented for outside clients.
export type ExternalMcpApprovalOutcome = 'approved' | 'declined' | 'unavailable'

export type ExternalMcpRequestApproval = (input: {
  toolId: string
  /** Shared with this call's `external mcp call` line and the broker's `permission decision` line. */
  toolCallId: string
  /** What the card says the client is asking to do, in the reader's words. */
  title: string
  rawInput: unknown
  /** The conversation the tool acts on; the card is parked there, so the reader answers where it applies. */
  sessionId: string | undefined
}) => Promise<ExternalMcpApprovalOutcome>

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
  private readonly handlers: Record<ReadToolId, ToolHandler>
  private readonly writePlans: Record<WriteToolId, WritePlanner>
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
    this.handlers = createReadHandlers(options.invoke)
    this.writePlans = createWritePlans(options.invoke)
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

    const finish = (outcome: ToolOutcome, code?: string, decision?: string): void => {
      log.info('external mcp call', {
        toolCallId,
        tool: name,
        clientId,
        risk: tool?.risk ?? 'unknown',
        outcome,
        ...(code ? { code } : {}),
        // Present only for a tool that needed an answer. The same `toolCallId` is on the broker's
        // `permission decision` line, so a call and its approval pair up without guessing.
        ...(decision ? { decision } : {}),
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

    let approvalDecision: ExternalMcpApprovalOutcome | undefined
    let act: () => Promise<unknown>

    if (tool.risk === 'write') {
      // Step 1: resolve what the write is about with reads only. This is where a typo, a stale id, or an
      // already-archived conversation is named — before anybody is asked, and with nothing changed.
      let plan: WritePlan
      try {
        const planner = this.writePlans[tool.id as WriteToolId]
        if (!planner) {
          // A surface entry that says `risk: 'write'` without a planner would otherwise fall through to the
          // read path and act unapproved. Refusing here keeps that mistake impossible rather than unlikely.
          finish('refused', 'permission-gate-not-wired')
          return refusalResult(
            new ExternalMcpRefusal(
              'permission-gate-not-wired',
              `"${tool.id}" would change data, and this build has no approval path for it. Nothing was ` +
                'changed.'
            )
          )
        }
        plan = await planner({ clientId, args })
      } catch (error) {
        const code = error instanceof ExternalMcpRefusal ? error.code : 'command-failed'
        finish(error instanceof ExternalMcpRefusal ? 'refused' : 'failed', code)
        return refusalResult(error)
      }

      // Step 2: the card, before the act. A write that has already happened cannot be refused, so a
      // refusal that arrives afterwards would be a report instead of a gate.
      approvalDecision = await this.requestApproval(tool, toolCallId, plan)
      if (approvalDecision !== 'approved') {
        const decision = approvalDecision
        const code = decision === 'declined' ? 'not-approved' : 'approval-unavailable'
        const message =
          decision === 'declined'
            ? `"${tool.id}" changes data, and the app's user did not approve this call. Nothing was changed.`
            : `"${tool.id}" changes data, and no approval card could be shown for it: the conversation it ` +
              'acts on is not open in the app. Open that conversation and call again. Nothing was changed.'
        log.warn('external mcp write refused', { toolCallId, tool: tool.id, decision })
        finish('refused', code, decision)
        return refusalResult(new ExternalMcpRefusal(code, message))
      }

      // Step 3: the act, and only now.
      act = plan.act
    } else {
      // A read: its surface entry says so, and the handler record is total over the read ids.
      const readId = tool.id as ReadToolId
      act = () => this.handlers[readId]({ clientId, args })
    }

    try {
      const payload = await act()
      // One line per call, and the decision rides on it: a write that ran approved and a write that
      // never ran must not both read as `outcome: ok`.
      finish('ok', undefined, approvalDecision)
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
    } catch (error) {
      // A refusal and a failure are different facts for whoever reads the log: the first means the client
      // asked for something that is not there (or asked wrongly) and nothing was attempted; the second
      // means the app tried and could not answer. Both carry a code, so neither is a silent empty result.
      const code = error instanceof ExternalMcpRefusal ? error.code : 'command-failed'
      finish(error instanceof ExternalMcpRefusal ? 'refused' : 'failed', code, approvalDecision)
      return refusalResult(error)
    }
  }

  // Asks the app's own approval surface about a plan the caller already resolved. A port that is absent, or
  // one that throws (the conversation is not loaded in this process, so there is nobody to ask), is
  // `unavailable` — never "allowed".
  private async requestApproval(
    tool: { id: string; title: string },
    toolCallId: string,
    plan: Pick<WritePlan, 'title' | 'sessionId' | 'rawInput'>
  ): Promise<ExternalMcpApprovalOutcome> {
    const requestApproval = this.options.requestApproval
    if (!requestApproval) return 'unavailable'
    try {
      return await requestApproval({
        toolId: tool.id,
        toolCallId,
        title: plan.title,
        rawInput: plan.rawInput,
        sessionId: plan.sessionId
      })
    } catch (error) {
      log.warn('external mcp approval unavailable', {
        toolCallId,
        tool: tool.id,
        message: error instanceof Error ? error.message : String(error)
      })
      return 'unavailable'
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

export { EXTERNAL_MCP_SERVER_NAME, ExternalMcpRefusal }
