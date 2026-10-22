import * as acp from '@agentclientprotocol/sdk'
import type {
  ActiveSession,
  ClientConnection,
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse
} from '@agentclientprotocol/sdk'
import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REVIEWER_MCP_SERVER_NAME, REVIEWER_MCP_TOOLS } from '../../shared/reviewer'
import type { AgentFrameworkId } from '../../shared/settings'
import type { AgentFramework } from '../agent-framework'
import { createLogger, diagnosticErrorFields } from '../logger'
import { canonicalAppMcpServerName } from '../agent-framework/app-mcp-names'
import { extractProviderToolName } from './runtime-events'
import { REVIEWER_MCP_PROXY_ARG } from '../mcp-server-args'

const log = createLogger('acp')

const REVIEWER_SESSION_ROLE = 'reviewer' as const

// Every spelling the reviewer server answers to. The canonical name is separator-free, and the
// hyphenated spelling is what a config, a recorded permission or a replayed session written before the
// rename still carries. The naming module keeps the same pair as aliases; the reviewer server is
// deliberately absent from its catalog (its identities must stay out of the remembered-permission
// catalog), so the spellings are stated here instead of resolved there.
const REVIEWER_MCP_SERVER_NAME_SPELLINGS = [
  REVIEWER_MCP_SERVER_NAME,
  REVIEWER_MCP_SERVER_NAME.replace(/[^a-zA-Z0-9]/g, '_'),
  REVIEWER_MCP_SERVER_NAME.replace(/_/g, '-')
]
const REVIEWER_MCP_SERVER_NAME_SPELLING_SET = new Set(REVIEWER_MCP_SERVER_NAME_SPELLINGS)

const REVIEWER_MCP_OPENCODE_TOOL_NAMES = new Set(
  Object.values(REVIEWER_MCP_TOOLS).flatMap((toolName) =>
    REVIEWER_MCP_SERVER_NAME_SPELLINGS.map((serverName) => `${serverName}_${toolName}`)
  )
)
const REVIEWER_MCP_LEAF_TOOL_NAMES = new Set<string>(Object.values(REVIEWER_MCP_TOOLS))
const REVIEWER_MCP_CODEX_TOOL_NAMES = new Set(
  Object.values(REVIEWER_MCP_TOOLS).flatMap((toolName) =>
    REVIEWER_MCP_SERVER_NAME_SPELLINGS.map((serverName) => `mcp.${serverName}.${toolName}`)
  )
)
const REVIEWER_MCP_CLAUDE_TOOL_NAMES = new Set(
  Object.values(REVIEWER_MCP_TOOLS).flatMap((toolName) =>
    REVIEWER_MCP_SERVER_NAME_SPELLINGS.map((serverName) => `mcp__${serverName}__${toolName}`)
  )
)
const REVIEWER_MCP_PROVIDER_TOOL_NAMES = new Set([
  ...REVIEWER_MCP_OPENCODE_TOOL_NAMES,
  ...REVIEWER_MCP_CLAUDE_TOOL_NAMES
])

// ACP tool kinds that describe a reasoning step: `think` names the model's own deliberation, which
// carries no filesystem, network or process capability. Measured on the shipped logs
// (2026-10-22/23, `~/Library/Logs/PureScience (DEV)/main.log`): the gate rejected 16 native tool calls
// and **every one of them** was followed by `review protocol incomplete … Reviewer stopped without
// calling submit_findings` within 2.1 s (15/15 paired; the 16th is the last one in the window).
// 9 of the 16 were kind `think` ⇒ refusing a reasoning step protects nothing and costs the user the
// entire review. It is answered with the allow option; every other kind stays rejected, including
// `execute` (a shell), `read`/`fetch` (filesystem and network), which is where the isolation lives.
const REVIEWER_PURE_REASONING_TOOL_KINDS: ReadonlySet<string> = new Set(['think'])

type ReviewerToolCallShape = {
  title?: unknown
  kind?: unknown
  _meta?: unknown
}

type ReviewerPermissionOption = { readonly optionId: string; readonly kind: string }

export type ReviewerToolCallIdentity =
  | { readonly kind: 'reviewer-mcp' }
  | { readonly kind: 'pure-reasoning' }
  | { readonly kind: 'foreign' }

export type ReviewerPermissionDecision =
  | {
      readonly outcome: 'allow'
      readonly rule: 'reviewer-mcp' | 'pure-reasoning-step'
      readonly optionId: string
    }
  | { readonly outcome: 'reject'; readonly optionId?: string }
  | { readonly outcome: 'cancel' }

// Which one of the three the caller is holding. The reviewer's own MCP tools are recognised first (a
// reviewer tool that happened to be reported with a reasoning kind must still take the MCP branch), then
// a reasoning step, then everything else.
export const classifyReviewerToolCall = (input: {
  readonly toolCall: ReviewerToolCallShape | undefined
  readonly frameworkId: AgentFrameworkId
  readonly mcpServerNames: readonly string[]
}): ReviewerToolCallIdentity => {
  const toolName = extractProviderToolName(input.toolCall)
  const reportedTitle = input.toolCall?.title
  const opencodeToolName =
    toolName == null &&
    input.frameworkId === 'opencode' &&
    typeof reportedTitle === 'string' &&
    REVIEWER_MCP_OPENCODE_TOOL_NAMES.has(reportedTitle)
      ? reportedTitle
      : undefined
  const codexToolName =
    input.frameworkId === 'codex' &&
    toolName != null &&
    REVIEWER_MCP_LEAF_TOOL_NAMES.has(toolName) &&
    typeof reportedTitle === 'string' &&
    REVIEWER_MCP_CODEX_TOOL_NAMES.has(reportedTitle)
      ? toolName
      : undefined
  const claudeToolName =
    toolName == null &&
    input.frameworkId === 'claude-code' &&
    typeof reportedTitle === 'string' &&
    REVIEWER_MCP_CLAUDE_TOOL_NAMES.has(reportedTitle)
      ? reportedTitle
      : undefined
  const isReviewerMcp =
    input.mcpServerNames.length === 1 &&
    REVIEWER_MCP_SERVER_NAME_SPELLING_SET.has(input.mcpServerNames[0] ?? '') &&
    ((toolName != null && REVIEWER_MCP_PROVIDER_TOOL_NAMES.has(toolName)) ||
      opencodeToolName != null ||
      codexToolName != null ||
      claudeToolName != null)

  if (isReviewerMcp) return { kind: 'reviewer-mcp' }
  const reportedKind = input.toolCall?.kind
  if (typeof reportedKind === 'string' && REVIEWER_PURE_REASONING_TOOL_KINDS.has(reportedKind)) {
    return { kind: 'pure-reasoning' }
  }
  return { kind: 'foreign' }
}

// The whole policy as one pure function so it can be pinned without standing up a reviewer session.
export const decideReviewerPermission = (input: {
  readonly toolCall: ReviewerToolCallShape | undefined
  readonly options: readonly ReviewerPermissionOption[]
  readonly frameworkId: AgentFrameworkId
  readonly mcpServerNames: readonly string[]
}): ReviewerPermissionDecision => {
  const identity = classifyReviewerToolCall(input)
  if (identity.kind === 'foreign') {
    const rejectOption =
      input.options.find((option) => option.kind === 'reject_once') ??
      input.options.find((option) => option.kind === 'reject_always')
    return rejectOption
      ? { outcome: 'reject', optionId: rejectOption.optionId }
      : { outcome: 'reject' }
  }
  const allowOption =
    input.options.find((option) => option.kind === 'allow_once') ??
    input.options.find((option) => option.kind === 'allow_always')
  if (!allowOption) return { outcome: 'cancel' }
  return {
    outcome: 'allow',
    rule: identity.kind === 'reviewer-mcp' ? 'reviewer-mcp' : 'pure-reasoning-step',
    optionId: allowOption.optionId
  }
}

// The decision as the wire response the agent expects, so the adapter that logs it cannot bend the
// answer on its way out (a decision that is not `allow` is never a selection).
export const permissionDecisionResponse = (
  decision: ReviewerPermissionDecision
): RequestPermissionResponse => {
  const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
  if (decision.outcome === 'cancel') return cancelled
  if (decision.outcome === 'reject') {
    const rejectOptionId = decision.optionId
    return rejectOptionId
      ? { outcome: { outcome: 'selected', optionId: rejectOptionId } }
      : cancelled
  }
  return { outcome: { outcome: 'selected', optionId: decision.optionId } }
}

const errorMessage = (error: unknown): string => {
  try {
    const raw = error instanceof Error ? (error as { message?: unknown }).message : error
    return typeof raw === 'string' ? raw : String(raw)
  } catch {
    return 'unknown error'
  }
}

const safeLogError = (message: string, data?: unknown): void => {
  try {
    log.error(message, data)
  } catch {
    /* logging must never mask the real error */
  }
}

const safeLogWarn = (message: string, data?: unknown): void => {
  try {
    log.warn(message, data)
  } catch {
    /* logging must never interrupt lifecycle cleanup */
  }
}

export type ReviewerSessionRole = typeof REVIEWER_SESSION_ROLE

export type ReviewerSessionRequest = {
  cwd: string
  mcpServers: McpServer[]
  systemPromptAppend?: string
}

export type ReviewerSessionResult = {
  session: ActiveSession
  promptPrefix?: string
  role: ReviewerSessionRole
}

// What became of the agent-side half of a reviewer teardown.
//
// ACP's `ActiveSession.dispose()` only stops routing updates to the local helper — the SDK says so in
// its own doc comment ("This does not close the ACP session on the agent"). Nobody else closes a
// reviewer session: it is ephemeral, it never reaches the user-facing deletion workflow, and the
// provider process it lives on is the shared connection, which must NOT be killed. So without an
// explicit `session/close` the agent keeps the session — and the per-session MCP client the reviewer
// server was registered with — for the rest of the connection. That is what the field log shows: with
// the reviewer MCP server already gone, the provider keeps dialling its port 1–3 s later, 130
// `egress target failed` ECONNREFUSED lines in five days whose ports each match a
// `reviewer MCP server stopped` line.
export type ReviewerRemoteSessionClose = {
  sessionId: string
  outcome: 'closed' | 'cancelled' | 'no-connection' | 'timed-out' | 'failed'
  elapsedMs: number
}

export type ReviewerSessionDisposition = {
  rejectedToolCalls: number
  // Undefined for frameworks/providers that do not traverse the Responses bridge.
  reviewerBridgeScoped: boolean | undefined
  // Settles once the agent has been told this session is over (bounded by `sessionCloseTimeoutMs`).
  // Disposing already released the local half, so callers must await this before tearing down the
  // MCP server the session was created with — stopping the server first is what produced the
  // ECONNREFUSED retries described above.
  remoteClose?: Promise<ReviewerRemoteSessionClose>
}

export type ReviewerSessionSnapshot = {
  lifecycle: 'pending' | 'active'
  role: ReviewerSessionRole
  sessionId: string
}

export type ReviewerSessionContext = {
  frameworkId: AgentFrameworkId
  mcpServerNames: readonly string[]
  role: ReviewerSessionRole
}

type ReviewerSessionIdentityReservation = {
  generation: number
  sessionId: string
  token: symbol
}

type ReviewerSessionIdentityReservationResult =
  | { reservation: ReviewerSessionIdentityReservation; collision?: never }
  | { reservation?: never; collision: Error }

type ActiveReviewerSessionOwner = ReviewerSessionContext & {
  cwd: string
  session: ActiveSession
  sessionId: string
  token: symbol
}

export type ReviewerSessionOwnerDependencies = {
  addStartupBlocker: (token: symbol) => void
  assertCurrentConnection: (connection: ClientConnection) => void
  clearPermissionCorrelations: (sessionId: string) => void
  // The live connection, so a disposed reviewer session can be closed on the agent as well. Undefined
  // when the connection is already gone (nothing to tell, and nothing to wait for).
  currentConnection: () => ClientConnection | undefined
  currentSessionSetup: () => {
    framework: AgentFramework
    sessionOptions: Record<string, unknown> | undefined
  }
  currentStartupGeneration: () => number
  isPrimarySessionIdClaimed: (sessionId: string) => boolean
  onActiveSessionReleased: () => void
  registerBridgeSession: (sessionId: string) => void
  removeStartupBlocker: (token: symbol) => void
  // Bounded wait for the agent to confirm the session is over; a hung agent must not hold review
  // teardown (and the reviewer MCP server behind it) open indefinitely.
  sessionCloseTimeoutMs?: number
  supportsSessionClose: () => boolean
  unregisterBridgeSession: (sessionId: string) => boolean | undefined
}

export const DEFAULT_REVIEWER_SESSION_CLOSE_TIMEOUT_MS = 3_000

class ReviewerSessionCloseTimeoutError extends Error {
  constructor() {
    super('reviewer ACP session close timed out')
    this.name = 'ReviewerSessionCloseTimeoutError'
  }
}

export type ReviewerSessionCreateCapability = Readonly<{
  ensureConnected: (cwd: string) => Promise<ClientConnection>
}>

// Owns every ephemeral Reviewer startup, identity, and resource. Runtime supplies only current
// connection/setup facts plus narrow collision, bridge, cleanup, and startup-blocker ports.
export class ReviewerSessionOwner {
  private readonly activeById = new Map<string, ActiveReviewerSessionOwner>()
  private readonly activeBySession = new WeakMap<ActiveSession, ActiveReviewerSessionOwner>()
  private readonly pendingIds = new Map<string, symbol>()
  private readonly rejectedToolCalls = new Map<string, number>()

  constructor(private readonly dependencies: ReviewerSessionOwnerDependencies) {}

  async create(
    request: ReviewerSessionRequest,
    capability: ReviewerSessionCreateCapability
  ): Promise<ReviewerSessionResult> {
    const mcpServerNames = this.validateRequest(request)
    const connection = await capability.ensureConnected(request.cwd)
    this.dependencies.assertCurrentConnection(connection)
    const { framework, sessionOptions } = this.dependencies.currentSessionSetup()
    const startupGeneration = this.dependencies.currentStartupGeneration()
    const reviewerCwd = await mkdtemp(join(tmpdir(), 'purescience-reviewer-'))
    const setup = framework.buildSessionSetup({
      systemPromptAppends: request.systemPromptAppend ? [request.systemPromptAppend] : [],
      sessionOptions
    })
    const reviewerMeta: Record<string, unknown> = {
      ...(setup.meta ?? {}),
      // claude-agent-acp honors this legacy switch. Codex is independently restricted by the
      // Responses bridge and the strict permission decision below.
      disableBuiltInTools: true
    }
    if (framework.id === 'claude-code') {
      const claudeCode =
        typeof reviewerMeta.claudeCode === 'object' && reviewerMeta.claudeCode !== null
          ? (reviewerMeta.claudeCode as Record<string, unknown>)
          : {}
      const claudeOptions =
        typeof claudeCode.options === 'object' && claudeCode.options !== null
          ? (claudeCode.options as Record<string, unknown>)
          : {}
      reviewerMeta.claudeCode = {
        ...claudeCode,
        options: { ...claudeOptions, tools: [] }
      }
    }

    try {
      const session = await connection.agent
        .buildSession({
          cwd: reviewerCwd,
          mcpServers: request.mcpServers,
          _meta: reviewerMeta
        })
        .start()
      const reservationResult = this.reserveIdentity(session.sessionId, startupGeneration)
      if (reservationResult.collision) {
        this.disposeSessionAfterFailure(session, 'reviewer collision session disposal failed')
        throw reservationResult.collision
      }
      const reservation = reservationResult.reservation
      let identityActivated = false

      try {
        const permission = framework.mapPermissionProfile('ask', session.modes)
        if (permission.modeId && permission.modeId !== session.modes?.currentModeId) {
          await connection.agent.request(acp.methods.agent.session.setMode, {
            sessionId: session.sessionId,
            modeId: permission.modeId
          })
        }

        this.activateIdentity(reservation, session, reviewerCwd, framework.id, mcpServerNames)
        identityActivated = true
        this.dependencies.registerBridgeSession(session.sessionId)

        return { session, promptPrefix: setup.promptPrefix, role: REVIEWER_SESSION_ROLE }
      } catch (error) {
        let startupError = error
        if (!identityActivated) {
          try {
            this.assertIdentityReservation(reservation)
          } catch (supersededError) {
            startupError = supersededError
          }
        }
        this.releaseIdentityReservation(reservation)
        const activeOwner = this.activeById.get(session.sessionId)
        if (identityActivated && activeOwner?.session === session) {
          this.activeById.delete(session.sessionId)
          this.activeBySession.delete(session)
          this.rejectedToolCalls.delete(session.sessionId)
          try {
            this.dependencies.unregisterBridgeSession(session.sessionId)
          } catch (cleanupError) {
            safeLogError('reviewer bridge registration rollback failed', {
              ...diagnosticErrorFields(cleanupError),
              sessionId: session.sessionId
            })
          }
        }
        this.disposeSessionAfterFailure(session, 'reviewer startup session disposal failed')
        throw startupError
      }
    } catch (error) {
      this.removeDirectory(reviewerCwd)
      throw error
    }
  }

  contextFor(sessionId: string): ReviewerSessionContext | undefined {
    const owner = this.activeById.get(sessionId)
    if (!owner) return undefined
    return {
      frameworkId: owner.frameworkId,
      mcpServerNames: owner.mcpServerNames,
      role: owner.role
    }
  }

  snapshot(): ReviewerSessionSnapshot[] {
    const active = [...this.activeById.keys()].map((sessionId): ReviewerSessionSnapshot => ({
      lifecycle: 'active',
      role: REVIEWER_SESSION_ROLE,
      sessionId
    }))
    const pending = [...this.pendingIds.keys()]
      .filter((sessionId) => !this.activeById.has(sessionId))
      .map((sessionId): ReviewerSessionSnapshot => ({
        lifecycle: 'pending',
        role: REVIEWER_SESSION_ROLE,
        sessionId
      }))
    return [...active, ...pending]
  }

  hasActiveSessions(): boolean {
    return this.activeById.size > 0
  }

  hasActiveSessionId(sessionId: string): boolean {
    return this.activeById.has(sessionId)
  }

  hasPendingSessionId(sessionId: string): boolean {
    return this.pendingIds.has(sessionId)
  }

  resolvePermission(params: RequestPermissionRequest): RequestPermissionResponse | undefined {
    const context = this.contextFor(params.sessionId)
    if (!context) return undefined
    const decision = decideReviewerPermission({
      toolCall: params.toolCall,
      options: params.options,
      frameworkId: context.frameworkId,
      mcpServerNames: context.mcpServerNames
    })

    if (decision.outcome === 'reject') {
      this.rejectedToolCalls.set(
        params.sessionId,
        (this.rejectedToolCalls.get(params.sessionId) ?? 0) + 1
      )
      // `tool` is the provider's tool name when it has one and the ACP kind otherwise, so `toolKind` is
      // what tells the two apart in a reading: without it `tool: "think"` is ambiguous between a tool
      // named think and a call reported with kind think. No title or input is logged — a native tool
      // call's title is the model's own text.
      log.warn('rejecting non-reviewer tool requested by background reviewer', {
        sessionId: params.sessionId,
        tool: extractProviderToolName(params.toolCall) ?? params.toolCall.kind,
        toolKind: params.toolCall.kind,
        toolCallId: params.toolCall?.toolCallId
      })
      return permissionDecisionResponse(decision)
    }

    if (decision.outcome === 'cancel') {
      log.warn('reviewer MCP permission request had no allow option; cancelling', {
        sessionId: params.sessionId,
        toolCallId: params.toolCall?.toolCallId
      })
      return permissionDecisionResponse(decision)
    }

    // Logged at info, not debug (P0-9): the request line is `info` while this decision was `debug`, so a
    // normal log showed 2,128 "permission request received" lines and almost no decisions — which reads as
    // "the user was asked 2,128 times" when in fact the app approves each one itself within the same
    // millisecond. Measured on real logs: 906 requests ↔ 856 of these in one file, each at +0.00 s with the
    // same toolCallId. A decision made on the user's behalf belongs in the record at the same level as the
    // request it answers, so the pair can be joined and the user-facing density can be told apart.
    //
    // The reasoning-step rule logs its own sentence: it approves a call that is NOT one of the reviewer
    // MCP tools, and a reading that could not tell the two apart would report a scope-bounded approval
    // that never happened.
    if (decision.rule === 'pure-reasoning-step') {
      log.info('approving reviewer reasoning step', {
        sessionId: params.sessionId,
        toolCallId: params.toolCall?.toolCallId,
        toolKind: params.toolCall.kind,
        optionId: decision.optionId,
        rule: 'reviewer-pure-reasoning-step'
      })
    } else {
      log.info('approving scope-bounded reviewer MCP tool call', {
        sessionId: params.sessionId,
        toolCallId: params.toolCall?.toolCallId,
        optionId: decision.optionId,
        rule: 'scope-bounded-reviewer-mcp'
      })
    }
    return { outcome: { outcome: 'selected', optionId: decision.optionId } }
  }

  dispose(session: ActiveSession): ReviewerSessionDisposition {
    const cleanupFailures: unknown[] = []
    // Captured before the local cleanup runs: the agent-side close must address the connection this
    // session was created on, and must start immediately (the agent can then cancel its in-flight
    // work while the rest of the teardown happens here).
    const remoteClose = this.closeRemoteSession(
      session.sessionId,
      this.dependencies.currentConnection()
    )
    const runCleanup = <Result>(stage: string, cleanup: () => Result): Result | undefined => {
      try {
        return cleanup()
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError)
        safeLogError('reviewer session cleanup failed', {
          ...diagnosticErrorFields(cleanupError),
          sessionId: session.sessionId,
          stage
        })
        return undefined
      }
    }

    const owner = this.activeBySession.get(session)
    this.activeBySession.delete(session)
    const ownsActiveIdentity =
      owner !== undefined && this.activeById.get(owner.sessionId)?.token === owner.token
    const rejectedToolCalls = ownsActiveIdentity
      ? (this.rejectedToolCalls.get(owner.sessionId) ?? 0)
      : 0
    let reviewerBridgeScoped: boolean | undefined
    if (ownsActiveIdentity && owner) {
      this.activeById.delete(owner.sessionId)
      reviewerBridgeScoped = runCleanup('bridge', () =>
        this.unregisterBridgeSession(owner.sessionId)
      )
      runCleanup('permission-correlations', () =>
        this.dependencies.clearPermissionCorrelations(owner.sessionId)
      )
      this.rejectedToolCalls.delete(owner.sessionId)
    }

    let disposeFailed = false
    let disposeFailure: unknown
    try {
      session.dispose()
    } catch (error) {
      disposeFailed = true
      disposeFailure = error
    }

    if (owner) this.removeDirectory(owner.cwd)
    if (ownsActiveIdentity) {
      runCleanup('reconnect-retirement', () => this.dependencies.onActiveSessionReleased())
    }

    if (disposeFailed) throw disposeFailure
    if (cleanupFailures.length > 0) throw cleanupFailures[0]
    return { rejectedToolCalls, reviewerBridgeScoped, remoteClose }
  }

  // Tells the agent the reviewer session is over. Best-effort by design: every outcome is named and
  // logged, nothing here throws, and the returned promise never rejects — review teardown must not
  // turn a slow or unhappy agent into a failed review. `session/close` is the protocol's own answer
  // (the agent must cancel ongoing work and free the session's resources, which includes the MCP
  // client it holds for the reviewer server); agents that do not advertise it get `session/cancel`,
  // which at least stops the work even though it leaves the session registered.
  private async closeRemoteSession(
    sessionId: string,
    connection: ClientConnection | undefined
  ): Promise<ReviewerRemoteSessionClose> {
    const startedAt = Date.now()
    const elapsed = (): number => Date.now() - startedAt
    if (!connection) {
      safeLogWarn('reviewer ACP session left open on the agent', {
        sessionId,
        reason: 'no-connection'
      })
      return { sessionId, outcome: 'no-connection', elapsedMs: elapsed() }
    }

    const supportsClose = this.dependencies.supportsSessionClose()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const settle = supportsClose
        ? connection.agent.request(acp.methods.agent.session.close, { sessionId })
        : connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })
      await Promise.race([
        settle,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new ReviewerSessionCloseTimeoutError()),
            this.dependencies.sessionCloseTimeoutMs ?? DEFAULT_REVIEWER_SESSION_CLOSE_TIMEOUT_MS
          )
          // A pending bound must never keep the app's event loop alive on its own.
          timer.unref?.()
        })
      ])
      const outcome = supportsClose ? 'closed' : 'cancelled'
      log.info(
        supportsClose
          ? 'reviewer ACP session closed on the agent'
          : 'reviewer ACP session cancelled on the agent',
        {
          sessionId,
          elapsedMs: elapsed(),
          ...(supportsClose ? {} : { reason: 'no-session-close' })
        }
      )
      return { sessionId, outcome, elapsedMs: elapsed() }
    } catch (error) {
      const timedOut = error instanceof ReviewerSessionCloseTimeoutError
      safeLogWarn(
        timedOut ? 'reviewer ACP session close timed out' : 'reviewer ACP session close failed',
        {
          sessionId,
          elapsedMs: elapsed(),
          ...(timedOut
            ? {
                timeoutMs:
                  this.dependencies.sessionCloseTimeoutMs ??
                  DEFAULT_REVIEWER_SESSION_CLOSE_TIMEOUT_MS
              }
            : diagnosticErrorFields(error))
        }
      )
      return { sessionId, outcome: timedOut ? 'timed-out' : 'failed', elapsedMs: elapsed() }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  invalidatePending(): void {
    for (const token of this.pendingIds.values()) this.dependencies.removeStartupBlocker(token)
    this.pendingIds.clear()
  }

  clear(): void {
    this.invalidatePending()
    for (const [sessionId, owner] of this.activeById) {
      try {
        this.unregisterBridgeSession(sessionId)
      } catch (error) {
        safeLogError('reviewer bridge cleanup after connection close failed', {
          ...diagnosticErrorFields(error),
          sessionId
        })
      }
      this.removeDirectory(owner.cwd)
      try {
        this.dependencies.clearPermissionCorrelations(sessionId)
      } catch (error) {
        safeLogError('reviewer permission cleanup after connection close failed', {
          ...diagnosticErrorFields(error),
          sessionId
        })
      }
      this.activeBySession.delete(owner.session)
    }
    this.activeById.clear()
    this.rejectedToolCalls.clear()
  }

  private validateRequest(request: ReviewerSessionRequest): string[] {
    const mcpServerNames = request.mcpServers
      .map((server) => (server as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string')
      // A configured name may carry the pre-rename hyphen spelling (a config or a replayed session
      // written before the rename). The naming module's catalog cannot canonicalize the reviewer server
      // — it is deliberately undeclared there — so both spellings are folded onto the canonical name
      // here before the strict "exactly one" comparison below.
      .map((name) =>
        REVIEWER_MCP_SERVER_NAME_SPELLING_SET.has(name) ? REVIEWER_MCP_SERVER_NAME : name
      )
      .map(canonicalAppMcpServerName)
    const reviewerMcp = request.mcpServers[0]
    const reviewerMcpHttp =
      reviewerMcp && 'type' in reviewerMcp && reviewerMcp.type === 'http' ? reviewerMcp : undefined
    const reviewerMcpStdio = reviewerMcp && !('type' in reviewerMcp) ? reviewerMcp : undefined
    let reviewerMcpUrl: URL | undefined
    try {
      reviewerMcpUrl = reviewerMcpHttp ? new URL(reviewerMcpHttp.url) : undefined
    } catch {
      reviewerMcpUrl = undefined
    }
    if (
      request.mcpServers.length !== 1 ||
      mcpServerNames.length !== 1 ||
      mcpServerNames[0] !== REVIEWER_MCP_SERVER_NAME ||
      !(
        (reviewerMcpHttp &&
          reviewerMcpUrl?.protocol === 'http:' &&
          reviewerMcpUrl.hostname === '127.0.0.1') ||
        (reviewerMcpStdio &&
          reviewerMcpStdio.args?.at(-1) === REVIEWER_MCP_PROXY_ARG &&
          reviewerMcpStdio.env?.some(
            (entry) => entry.name === 'PURESCIENCE_REVIEWER_MCP_SOCKET_PATH' && entry.value
          ) &&
          reviewerMcpStdio.env.some(
            (entry) => entry.name === 'PURESCIENCE_REVIEWER_MCP_TOKEN' && entry.value
          ))
      )
    ) {
      throw new Error(
        `Reviewer sessions require exactly one app-owned ${REVIEWER_MCP_SERVER_NAME} MCP server.`
      )
    }
    return mcpServerNames
  }

  private reserveIdentity(
    sessionId: string,
    generation: number
  ): ReviewerSessionIdentityReservationResult {
    if (generation !== this.dependencies.currentStartupGeneration()) {
      return { collision: new Error('ACP session startup was superseded.') }
    }
    if (
      this.dependencies.isPrimarySessionIdClaimed(sessionId) ||
      this.activeById.has(sessionId) ||
      this.pendingIds.has(sessionId)
    ) {
      return { collision: new Error(`Reviewer session id collision: ${sessionId}`) }
    }
    const reservation = {
      generation,
      sessionId,
      token: Symbol('reviewer-session-identity')
    } satisfies ReviewerSessionIdentityReservation
    this.pendingIds.set(sessionId, reservation.token)
    this.dependencies.addStartupBlocker(reservation.token)
    return { reservation }
  }

  private activateIdentity(
    reservation: ReviewerSessionIdentityReservation,
    session: ActiveSession,
    cwd: string,
    frameworkId: AgentFrameworkId,
    mcpServerNames: readonly string[]
  ): void {
    this.assertIdentityReservation(reservation)
    this.pendingIds.delete(reservation.sessionId)
    this.dependencies.removeStartupBlocker(reservation.token)
    const owner = {
      cwd,
      frameworkId,
      mcpServerNames,
      role: REVIEWER_SESSION_ROLE,
      session,
      sessionId: reservation.sessionId,
      token: reservation.token
    } satisfies ActiveReviewerSessionOwner
    this.activeById.set(reservation.sessionId, owner)
    this.activeBySession.set(session, owner)
    this.rejectedToolCalls.delete(reservation.sessionId)
  }

  private assertIdentityReservation(reservation: ReviewerSessionIdentityReservation): void {
    if (
      reservation.generation !== this.dependencies.currentStartupGeneration() ||
      this.pendingIds.get(reservation.sessionId) !== reservation.token
    ) {
      throw new Error('ACP session startup was superseded.')
    }
  }

  private releaseIdentityReservation(reservation: ReviewerSessionIdentityReservation): void {
    this.dependencies.removeStartupBlocker(reservation.token)
    if (this.pendingIds.get(reservation.sessionId) === reservation.token) {
      this.pendingIds.delete(reservation.sessionId)
    }
  }

  private unregisterBridgeSession(sessionId: string): boolean | undefined {
    const scoped = this.dependencies.unregisterBridgeSession(sessionId)
    if (scoped === false) log.error('reviewer bridge request was never scoped', { sessionId })
    return scoped
  }

  private disposeSessionAfterFailure(session: ActiveSession, logMessage: string): void {
    try {
      session.dispose()
    } catch (cleanupError) {
      safeLogError(logMessage, {
        ...diagnosticErrorFields(cleanupError),
        sessionId: session.sessionId
      })
    }
  }

  private removeDirectory(reviewerCwd: string): void {
    try {
      rmSync(reviewerCwd, { recursive: true, force: true })
    } catch (error) {
      safeLogWarn('failed to remove temporary reviewer directory', {
        reviewerCwd,
        error: errorMessage(error)
      })
    }
  }
}
