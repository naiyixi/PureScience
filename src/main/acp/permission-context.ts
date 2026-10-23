import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'

import type {
  AcpPermissionGrant,
  AcpPermissionRequest,
  AcpPermissionResponse
} from '../../shared/acp'
import { DEFAULT_PERMISSION_PROFILE } from '../../shared/permission-profiles'
import type { SessionPermissionProfileState } from '../../shared/permission-profiles'
import type { AgentFrameworkId } from '../../shared/settings'
import { getAgentFramework, type AgentFramework } from '../agent-framework'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import { resolveCanonicalMcpToolIdentity } from '../agent-framework/app-mcp-names'
import { createLogger } from '../logger'
import {
  AcpPermissionBroker,
  ConversationPermissionGrantStore,
  resolveNotebookPermissionContext
} from './permission-broker'
import type { PermissionPolicyContext } from './permission-policy'
import {
  isMcpToolName,
  withTrustedMcpToolIdentity,
  withTrustedNativeToolIdentity
} from './permission-policy'
import { extractProviderToolName, toAcpRuntimeEvent } from './runtime-events'
import type { NotebookRunRiskReceipt } from '../../shared/notebook'

const log = createLogger('acp')

type PermissionFramework = 'codex' | 'opencode' | 'claude-code' | string | undefined

type PermissionToolContext = {
  sessionId: string
  framework: PermissionFramework
  mcpServerNames: readonly string[]
}

type PermissionRestoreContext = PermissionToolContext & {
  isCancelled: () => boolean
  /**
   * Whether the caller's decision actually reads the tool's raw input.
   *
   * The OpenCode raw-input wait below exists to fill the permission card a human (or a policy that
   * inspects arguments) is about to read. A decision taken from the tool's identity alone -- the
   * background reviewer classifies on title/kind -- has nothing to do with that input, so it sets this
   * to `false` and the wait is skipped instead of paid.
   *
   * Omitted means `true`: primary sessions keep the existing behaviour, because their card renders the
   * arguments and their auto-review strategy inspects them.
   */
  awaitsProviderInput?: boolean
}

type CodexMcpToolIdentity = {
  title: string
  providerToolName: string
  mcpIdentity: string
  rawInput: unknown
}

type OpenCodeMcpToolInput = {
  title: string
  providerToolName: string
  mcpIdentity: string
  rawInput?: unknown
}

/**
 * An input-bearing update that was thrown away because it could not be tied to a configured server.
 *
 * Held until a permission request for the same tool call decides whether the loss mattered: if that
 * request waits for input, these were the bytes it was waiting for.
 */
type DroppedOpenCodeInput = {
  reason: 'not-an-mcp-title' | 'unresolved-identity'
  title?: string
}

type ClaudeCodeMcpToolInput = {
  title: string
  providerToolName: string
  mcpIdentity: string
  rawInput?: Record<string, unknown>
}

type OpenCodePermissionContextWaitOutcome = 'ready' | 'timeout' | 'cancelled'
type OpenCodePermissionContextWaiter = (outcome: OpenCodePermissionContextWaitOutcome) => void

type AuthorizedPermissionActionOrigin = Readonly<{
  kind: 'human' | 'agent' | 'system'
}>

type AcpPermissionContextOptions = {
  emitPermissionRequest: (request: AcpPermissionRequest) => void
  routing: {
    resolveAppSessionId: (providerSessionId: string) => string
    sessionSnapshot: (sessionId: string) =>
      | {
          cwd?: string
          frameworkId?: AgentFrameworkId
          permissionProfile?: Readonly<
            Pick<SessionPermissionProfileState, 'selectedProfile' | 'autoReviewStrategy'>
          >
        }
      | undefined
    hasActivePrimarySession: (sessionId: string) => boolean
    capturePrompt: (sessionId: string) =>
      | {
          sequence: number
          isCancellationAccepted: () => boolean
        }
      | undefined
    currentInteractionSequence: (sessionId: string) => number | undefined
    mcpServerNamesFor: (sessionId: string) => readonly string[]
    reviewerContextFor: (providerSessionId: string) =>
      | {
          frameworkId: AgentFrameworkId
          mcpServerNames: readonly string[]
        }
      | undefined
    resolveReviewerPermission: (
      request: RequestPermissionRequest
    ) => RequestPermissionResponse | undefined
    currentFramework: () => AgentFramework
    resolveProjectId: (sessionId: string) => string
  }
  conversationGrants?: ConversationPermissionGrantStore
  permissionGrantRegistry?: PermissionGrantRegistry
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  onOpenCodeWaitTimeout?: (details: {
    sessionId: string
    toolCallId: string
    waitMs: number
  }) => void
  /**
   * Fired when the raw-input wait is skipped because the decision is identity-only. Named so a reading
   * can tell "skipped on purpose" from "the wait never happened".
   */
  onOpenCodeInputWaitSkipped?: (details: {
    sessionId: string
    toolCallId: string
    reason: 'identity-only-decision'
  }) => void
  /**
   * Fired when an MCP request names its server only in `_meta` while the title carries a bare leaf name.
   *
   * That is the one shape the title-only judgement cannot classify, and it used to leave the request
   * outside the MCP path with no reading at all (18 of 125 MCP requests in the 2026-10-23 field log).
   * `hasOwnInput` splits the two cases, because they call for different fixes: with the arguments already
   * in hand such a request can be treated as MCP at no cost, while an empty one would have to wait for an
   * input the update path -- itself keyed on the title -- cannot store for this shape.
   */
  onOpenCodeMcpIdentityInProviderNameOnly?: (details: {
    sessionId: string
    toolCallId: string
    hasOwnInput: boolean
    awaitsProviderInput: boolean
  }) => void
  /**
   * Fired once per request that could have waited, with what the wait actually produced.
   *
   * Only a timeout was observable before this: a wait that resolved is silent, so "every wait timed out"
   * was an inference rather than a measurement. `waitedMs` is how long the caller actually blocked
   * (`0` when the input was already in hand and nothing was awaited).
   */
  onOpenCodeInputWaitOutcome?: (details: {
    sessionId: string
    toolCallId: string
    outcome: 'input-present' | 'resolved' | 'timeout' | 'cancelled'
    waitedMs: number
  }) => void
  /**
   * Fired when a provider tool-call update that carried raw input could not be used as permission input.
   *
   * This is the other half of "the wait timed out": either the update never came, or it came and this
   * module dropped it (title shape, unresolvable identity). Without this line the two are identical in
   * the logs. The title is reported (it is a tool name, bounded) and never the input itself.
   */
  onOpenCodeToolCallUpdateUnusable?: (details: {
    sessionId: string
    toolCallId: string
    reason: 'not-an-mcp-title' | 'unresolved-identity'
    title?: string
  }) => void
  /**
   * Fired when raw input for a call arrives after its wait already gave up. That means the provider does
   * send the input, and the wait was simply too short -- a different fix from "it never sends one".
   */
  onOpenCodeInputArrivedLate?: (details: {
    sessionId: string
    toolCallId: string
    lateMs: number
  }) => void
}

type PermissionContextSessionSnapshot = {
  codexMcpIdentities: number
  claudeCodeMcpInputs: number
  opencodeMcpInputs: number
  opencodeNativeSkills: number
  opencodeClosedToolCalls: number
  pendingWaiters: number
}

type AcpPermissionContextSnapshot = {
  pendingRequests: Array<{
    requestId: string
    sessionId: string
    toolCallId: string
    requiredOrigin: 'human'
  }>
  sessions: Record<string, PermissionContextSessionSnapshot>
}

const AGENT_PERMISSION_ACTION_ORIGIN: AuthorizedPermissionActionOrigin = { kind: 'agent' }
const HUMAN_PERMISSION_ACTION_ORIGIN: AuthorizedPermissionActionOrigin = { kind: 'human' }
const SYSTEM_PERMISSION_ACTION_ORIGIN: AuthorizedPermissionActionOrigin = { kind: 'system' }

const MAX_CODEX_MCP_TOOL_IDENTITIES_PER_SESSION = 32
const MAX_CLAUDE_CODE_MCP_TOOL_INPUTS_PER_SESSION = 32
const MAX_OPENCODE_MCP_TOOL_INPUTS_PER_SESSION = 32
const MAX_PERMISSION_CODE_PREVIEW_CHARS = 7_500
const OPENCODE_PERMISSION_CONTEXT_WAIT_MS = 1_000

const errorMessage = (error: unknown): string => {
  try {
    const raw = error instanceof Error ? (error as { message?: unknown }).message : error
    return typeof raw === 'string' ? raw : String(raw)
  } catch {
    return 'unknown error'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isOpenCodeNativeSkillToolCall = (update: SessionNotification['update']): boolean => {
  if (update.sessionUpdate !== 'tool_call' || update.kind !== 'other') return false
  const providerToolName = extractProviderToolName(update)?.trim().toLowerCase()
  if (providerToolName !== undefined) return providerToolName === 'skill'

  const rawInput = isRecord(update.rawInput) ? update.rawInput : undefined
  return (
    update.title?.trim().toLowerCase() === 'skill' &&
    typeof rawInput?.name === 'string' &&
    rawInput.name.trim().length > 0
  )
}

const boundedNotebookPermissionInput = (
  title: string,
  rawInput: unknown,
  mcpServerNames: readonly string[]
): Record<string, unknown> | undefined => {
  const context = resolveNotebookPermissionContext(title, rawInput, mcpServerNames)
  if (!context) return undefined

  const outer = isRecord(rawInput) ? rawInput : {}
  const input = isRecord(outer.arguments) ? outer.arguments : outer
  const bounded: Record<string, unknown> = {}
  const hasExecutionInput = ['code', 'command', 'script'].some(
    (field) => typeof input[field] === 'string'
  )

  for (const field of ['kernelKind', 'kernel', 'language']) {
    if (typeof input[field] === 'string') bounded[field] = input[field]
  }
  if (
    context.runtime &&
    hasExecutionInput &&
    !bounded.kernelKind &&
    !bounded.kernel &&
    !bounded.language
  ) {
    bounded.language = context.runtime
  }

  for (const field of ['code', 'command', 'script']) {
    const value = input[field]
    if (typeof value !== 'string') continue

    bounded[field] = value.slice(0, MAX_PERMISSION_CODE_PREVIEW_CHARS)
    if (value.length > MAX_PERMISSION_CODE_PREVIEW_CHARS) bounded.inputTruncated = true
    break
  }

  return bounded
}

const isCodexMcpApproval = (params: RequestPermissionRequest): boolean => {
  const meta = (params as RequestPermissionRequest & { _meta?: unknown })._meta
  return isRecord(meta) && meta.is_mcp_tool_approval === true
}

const isCodexMcpToolCall = (update: SessionNotification['update']): boolean => {
  const meta = (update as SessionNotification['update'] & { _meta?: unknown })._meta
  return isRecord(meta) && meta.is_mcp_tool_call === true
}

const codexMcpToolIdentity = (
  event: ReturnType<typeof toAcpRuntimeEvent>,
  mcpServerNames: readonly string[]
): CodexMcpToolIdentity | undefined => {
  if (event.kind !== 'tool' || !isRecord(event.rawInput)) return undefined

  const server = event.rawInput.server
  const tool = event.rawInput.tool
  if (typeof server !== 'string' || typeof tool !== 'string' || !tool.trim()) return undefined

  const title = `mcp.${server}.${tool}`
  if (event.title !== title) return undefined
  const mcpIdentity = resolveCanonicalMcpToolIdentity(title, mcpServerNames)
  if (!mcpIdentity) return undefined

  return {
    title,
    providerToolName: tool,
    mcpIdentity,
    rawInput: event.rawInput.arguments
  }
}

const countNested = <T>(contexts: Map<string, Map<string, T>>, sessionId: string): number =>
  contexts.get(sessionId)?.size ?? 0

// Owns provider permission routing, correlation, and pending decisions. Protocol messages never infer
// human authority; only the explicit response origin can release a human-owned decision.
class AcpPermissionContext {
  private readonly broker: AcpPermissionBroker
  private readonly humanOnlyRequestIds = new Set<string>()
  private readonly codexMcpToolIdentities = new Map<string, Map<string, CodexMcpToolIdentity>>()
  private readonly claudeCodeMcpToolInputs = new Map<string, Map<string, ClaudeCodeMcpToolInput>>()
  private readonly opencodeMcpToolInputs = new Map<string, Map<string, OpenCodeMcpToolInput>>()
  private readonly opencodeNativeSkillToolCalls = new Map<string, Map<string, true>>()
  private readonly opencodeMcpToolInputWaiters = new Map<
    string,
    Map<string, Set<OpenCodePermissionContextWaiter>>
  >()
  /**
   * Calls whose raw-input wait already gave up, per session, with the time it gave up.
   *
   * Kept only so a later arrival can be reported as late (`lateMs`) instead of looking like a call that
   * simply arrived with its input. Bounded like every other per-session correlation store.
   */
  private readonly timedOutInputWaits = new Map<string, Map<string, number>>()
  private readonly closedOpenCodeToolCalls = new Map<string, Set<string>>()
  /**
   * Inputs thrown away on a call that had no wait yet, per session, kept until a request for that call
   * says whether the loss mattered. Bounded like every other per-session correlation store.
   */
  private readonly droppedOpenCodeInputs = new Map<string, Map<string, DroppedOpenCodeInput>>()
  /**
   * Tool calls whose dropped input was already reported, per session.
   *
   * Only used for the shape that actually loses something, so the number counts calls rather than
   * provider chunks: one call produced up to five rows before this existed.
   */
  private readonly openCodeDroppedInputReports = new Map<string, Set<string>>()
  /**
   * Requests whose server-qualified name lived only in `_meta`, per session.
   *
   * Bounded and once-per-call for the same reason as the report set above: the point of the reading is
   * how many distinct requests have this shape, not how many chunks the provider sent.
   */
  private readonly providerNameOnlyMcpReports = new Map<string, Set<string>>()
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void

  constructor(private readonly options: AcpPermissionContextOptions) {
    this.broker = new AcpPermissionBroker(
      (request) => {
        this.humanOnlyRequestIds.add(request.requestId)
        const sessionId = options.routing.resolveAppSessionId(request.sessionId)
        options.emitPermissionRequest(
          sessionId && sessionId !== request.sessionId ? { ...request, sessionId } : request
        )
      },
      options.conversationGrants,
      options.permissionGrantRegistry
    )
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
  }

  async handleProviderRequest(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const routing = this.options.routing

    const appSessionId = routing.resolveAppSessionId(params.sessionId)
    const reviewerContext = routing.reviewerContextFor(params.sessionId)
    const mcpServerNames =
      reviewerContext?.mcpServerNames ?? routing.mcpServerNamesFor(appSessionId)
    const promptInteraction = routing.capturePrompt(appSessionId)
    const promptTurn = promptInteraction?.sequence
    const aggregateSnapshot = routing.sessionSnapshot(appSessionId)
    const framework = reviewerContext?.frameworkId ?? aggregateSnapshot?.frameworkId
    const isCancelled = (): boolean =>
      framework === 'opencode' &&
      (promptTurn === undefined
        ? routing.hasActivePrimarySession(appSessionId)
        : routing.currentInteractionSequence(appSessionId) !== promptTurn ||
          promptInteraction?.isCancellationAccepted() === true)
    const restoreContext = {
      sessionId: appSessionId,
      framework,
      mcpServerNames,
      isCancelled,
      // Reviewer-owned sessions decide through `resolveReviewerPermission`, which classifies on the
      // tool's title and kind only -- no policy on that path reads the arguments. Waiting there buys a
      // card nobody reads, and the provider's late update never arrives: on the 2026-10-21/23 field log
      // 184 of 289 waits were reviewer calls, every one of them burning the full window and being
      // approved 1 ms later (median).
      awaitsProviderInput: reviewerContext === undefined
    }
    const normalizedParams = await this.restoreToolCall(params, restoreContext)
    if (
      !normalizedParams ||
      this.isPermissionRequestCancelled(params.toolCall.toolCallId, restoreContext)
    ) {
      return { outcome: { outcome: 'cancelled' } }
    }

    // Keep the audit record useful without logging titles, URLs, raw input, or provider payloads.
    const toolName = extractProviderToolName(normalizedParams.toolCall)
    const isMcp =
      isMcpToolName(normalizedParams.toolCall.title, mcpServerNames) ||
      isMcpToolName(toolName, mcpServerNames)
    log.info('permission request received', {
      tool:
        this.toolIdentityForDiagnostics(toolName, appSessionId) ?? normalizedParams.toolCall.kind,
      isMcp,
      toolCallId: normalizedParams.toolCall.toolCallId,
      sessionId: params.sessionId,
      optionCount: params.options.length
    })

    try {
      if (reviewerContext) {
        const response = routing.resolveReviewerPermission(normalizedParams)
        if (response) return response
        throw new Error(`Unknown ACP reviewer session: ${params.sessionId}`)
      }

      if (!routing.hasActivePrimarySession(appSessionId)) {
        throw new Error(`Unknown ACP session: ${appSessionId}`)
      }

      const profileState = aggregateSnapshot?.permissionProfile
      const currentFramework = routing.currentFramework()
      const frameworkId = aggregateSnapshot?.frameworkId ?? currentFramework.id
      const permissionFramework =
        frameworkId === currentFramework.id ? currentFramework : getAgentFramework(frameworkId)

      return await this.requestPermission(
        appSessionId === normalizedParams.sessionId
          ? normalizedParams
          : { ...normalizedParams, sessionId: appSessionId },
        {
          profile: profileState?.selectedProfile ?? DEFAULT_PERMISSION_PROFILE,
          frameworkId,
          shellDialect: permissionFramework.commandShellDialect,
          autoReviewStrategy: profileState?.autoReviewStrategy,
          cwd: aggregateSnapshot?.cwd,
          mcpServerNames,
          projectId: routing.resolveProjectId(appSessionId)
        }
      )
    } catch (error) {
      log.error('permission request failed', {
        message: errorMessage(error),
        tool:
          this.toolIdentityForDiagnostics(
            extractProviderToolName(normalizedParams.toolCall),
            appSessionId
          ) ?? normalizedParams.toolCall.kind,
        toolCallId: params.toolCall.toolCallId,
        sessionId: params.sessionId
      })
      throw error
    }
  }

  observeProviderUpdate(notification: SessionNotification): void {
    const routing = this.options.routing

    const sessionId = routing.resolveAppSessionId(notification.sessionId)
    const reviewerContext = routing.reviewerContextFor(notification.sessionId)
    const routed = structuredClone(notification)
    routed.sessionId = sessionId
    this.observeToolCall(routed, {
      sessionId,
      framework: reviewerContext?.frameworkId ?? routing.sessionSnapshot(sessionId)?.frameworkId,
      mcpServerNames: reviewerContext?.mcpServerNames ?? routing.mcpServerNamesFor(sessionId)
    })
  }

  getPendingRequests(): AcpPermissionRequest[] {
    return this.broker.getPendingRequests()
  }

  async applyPermissionProfile(
    sessionId: string,
    profile: Readonly<SessionPermissionProfileState>,
    isCurrent: () => boolean
  ): Promise<void> {
    const resolvedRequestIds = await this.broker.applyPermissionProfile(
      sessionId,
      profile,
      isCurrent
    )
    for (const requestId of resolvedRequestIds) this.humanOnlyRequestIds.delete(requestId)
  }

  setLivePermissionProfile(
    sessionId: string,
    profile: Readonly<SessionPermissionProfileState>,
    isCurrent: () => boolean = () => true
  ): void {
    this.broker.setLivePermissionProfile(sessionId, profile, isCurrent)
  }

  beginPermissionProfileTransition(
    sessionId: string,
    profile: Readonly<SessionPermissionProfileState>,
    isCurrent: () => boolean
  ): void {
    this.broker.beginPermissionProfileTransition(sessionId, profile, isCurrent)
  }

  setProviderPermissionProfile(
    sessionId: string,
    profile: Readonly<SessionPermissionProfileState>
  ): boolean {
    return this.broker.setProviderPermissionProfile(sessionId, profile)
  }

  clearLivePermissionProfile(sessionId: string): void {
    this.broker.clearLivePermissionProfile(sessionId)
  }

  listGrants(sessionId: string): AcpPermissionGrant[] {
    return this.broker.listGrants(sessionId)
  }

  revokeGrant(sessionId: string, categoryKey: string): Promise<void> {
    return this.broker.revokeGrant(sessionId, categoryKey)
  }

  requestPermission(
    params: RequestPermissionRequest,
    policyContext?: PermissionPolicyContext
  ): Promise<RequestPermissionResponse> {
    return this.broker.requestPermission(params, policyContext)
  }

  requestAppApproval(input: {
    sessionId: string
    title: string
    rawInput: unknown
    riskReview?: NotebookRunRiskReceipt
  }): Promise<boolean> {
    return this.broker.requestAppApproval(input)
  }

  respondToPermission(
    response: AcpPermissionResponse,
    origin: AuthorizedPermissionActionOrigin
  ): Promise<boolean> {
    if (this.humanOnlyRequestIds.has(response.requestId) && origin.kind === 'agent') {
      return Promise.resolve(false)
    }

    return this.broker.respond(response).finally(() => {
      if (!this.getPendingRequests().some((request) => request.requestId === response.requestId)) {
        this.humanOnlyRequestIds.delete(response.requestId)
      }
    })
  }

  observeToolCall(notification: SessionNotification, context: PermissionToolContext): void {
    const { sessionId, framework, mcpServerNames } = context
    if (framework !== 'codex' && framework !== 'opencode' && framework !== 'claude-code') return

    const routed =
      sessionId === notification.sessionId ? notification : { ...notification, sessionId }
    const event = toAcpRuntimeEvent(routed, 'permission-tool-context')
    if (event.kind !== 'tool' || !event.toolCallId) return

    if (event.status === 'completed' || event.status === 'failed') {
      this.deleteToolCall(sessionId, event.toolCallId, framework)
      return
    }

    if (framework === 'codex') {
      if (!isCodexMcpToolCall(notification.update)) return
      const identity = codexMcpToolIdentity(event, mcpServerNames)
      if (!identity) return

      const identities = this.codexMcpToolIdentities.get(sessionId) ?? new Map()
      this.setBounded(
        identities,
        event.toolCallId,
        identity,
        MAX_CODEX_MCP_TOOL_IDENTITIES_PER_SESSION
      )
      this.codexMcpToolIdentities.set(sessionId, identities)
      return
    }

    if (framework === 'claude-code') {
      const title = event.title
      if (!title || !isMcpToolName(title, mcpServerNames)) return
      const providerToolName = event.providerToolName ?? title
      const mcpIdentity =
        resolveCanonicalMcpToolIdentity(providerToolName, mcpServerNames) ??
        resolveCanonicalMcpToolIdentity(title, mcpServerNames)
      if (!mcpIdentity) return

      const inputs = this.claudeCodeMcpToolInputs.get(sessionId) ?? new Map()
      this.setBounded(
        inputs,
        event.toolCallId,
        {
          title,
          providerToolName,
          mcpIdentity,
          ...(isRecord(event.rawInput) ? { rawInput: event.rawInput } : {})
        },
        MAX_CLAUDE_CODE_MCP_TOOL_INPUTS_PER_SESSION
      )
      this.claudeCodeMcpToolInputs.set(sessionId, inputs)
      return
    }

    const update = notification.update
    if (update.sessionUpdate === 'tool_call') {
      const closedToolCalls = this.closedOpenCodeToolCalls.get(sessionId)
      closedToolCalls?.delete(event.toolCallId)
      if (closedToolCalls?.size === 0) this.closedOpenCodeToolCalls.delete(sessionId)
    }
    if (isOpenCodeNativeSkillToolCall(update)) {
      const calls = this.opencodeNativeSkillToolCalls.get(sessionId) ?? new Map<string, true>()
      this.setBounded(calls, event.toolCallId, true, MAX_OPENCODE_MCP_TOOL_INPUTS_PER_SESSION)
      this.opencodeNativeSkillToolCalls.set(sessionId, calls)
      this.resolveOpenCodeWaiters(sessionId, event.toolCallId)
      return
    }

    const originalRawInput =
      update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
        ? update.rawInput
        : undefined
    const hasIncomingRawInput =
      isRecord(originalRawInput) && Object.keys(originalRawInput).length > 0
    const inputs = this.opencodeMcpToolInputs.get(sessionId) ?? new Map()
    const previous = inputs.get(event.toolCallId)
    const title = event.title ?? previous?.title
    if (!title || !isMcpToolName(title, mcpServerNames)) {
      // An input that arrives and is dropped here is indistinguishable from one that never arrived once
      // the wait times out, so it reports itself before returning -- but only when something was
      // actually waiting for it: every ordinary local tool call reports its own arguments here too.
      if (hasIncomingRawInput) {
        this.handleUnusableOpenCodeInput(sessionId, event.toolCallId, 'not-an-mcp-title', title)
      }
      return
    }
    const canReusePreviousIdentity = event.title == null || event.title === previous?.title
    const providerToolName =
      event.providerToolName ??
      (canReusePreviousIdentity ? previous?.providerToolName : undefined) ??
      title
    const mcpIdentity =
      resolveCanonicalMcpToolIdentity(providerToolName, mcpServerNames) ??
      resolveCanonicalMcpToolIdentity(title, mcpServerNames) ??
      (canReusePreviousIdentity ? previous?.mcpIdentity : undefined)
    if (!mcpIdentity) {
      if (hasIncomingRawInput) {
        this.handleUnusableOpenCodeInput(sessionId, event.toolCallId, 'unresolved-identity', title)
      }
      return
    }

    const rawInput =
      boundedNotebookPermissionInput(title, originalRawInput, mcpServerNames) ?? event.rawInput
    const hasRawInput = isRecord(rawInput) && Object.keys(rawInput).length > 0
    const next: OpenCodeMcpToolInput = {
      title,
      providerToolName,
      mcpIdentity,
      ...(hasRawInput
        ? { rawInput }
        : canReusePreviousIdentity && previous?.rawInput !== undefined
          ? { rawInput: previous.rawInput }
          : {})
    }

    this.setBounded(inputs, event.toolCallId, next, MAX_OPENCODE_MCP_TOOL_INPUTS_PER_SESSION)
    this.opencodeMcpToolInputs.set(sessionId, inputs)
    if (hasRawInput) {
      this.reportLateInput(sessionId, event.toolCallId)
      this.resolveOpenCodeWaiters(sessionId, event.toolCallId)
    }
  }

  async restoreToolCall(
    params: RequestPermissionRequest,
    context: PermissionRestoreContext
  ): Promise<RequestPermissionRequest | undefined> {
    const { sessionId, framework, mcpServerNames } = context
    if (framework === 'claude-code') {
      return this.restoreClaudeCodeMcpToolInput(params, sessionId, mcpServerNames)
    }
    if (framework === 'opencode') {
      if (this.isOpenCodeRequestCancelled(sessionId, params.toolCall.toolCallId, context)) {
        return undefined
      }
      const trustedNativeSkill = this.restoreOpenCodeNativeSkillPermission(params, sessionId)
      if (trustedNativeSkill !== params) return trustedNativeSkill

      const restored = this.restoreOpenCodeMcpToolInput(params, sessionId, mcpServerNames)
      const titleSaysMcp = isMcpToolName(params.toolCall.title, mcpServerNames)
      const providerNameSaysMcp = isMcpToolName(
        extractProviderToolName(params.toolCall),
        mcpServerNames
      )
      const hasOwnInput =
        isRecord(restored.toolCall.rawInput) && Object.keys(restored.toolCall.rawInput).length > 0
      if (providerNameSaysMcp && !titleSaysMcp) {
        this.reportProviderNameOnlyMcpRequest(sessionId, params.toolCall.toolCallId, {
          hasOwnInput,
          awaitsProviderInput: context.awaitsProviderInput !== false
        })
      }
      // The provider can name its server only in `_meta` while the title carries the bare tool name, so a
      // title-only judgement leaves such a request outside the MCP path with no reading at all. It is
      // taken as MCP here only when the request already carries its own arguments: the wait below exists
      // for requests with an empty input, so this cannot make any request wait longer than before.
      const isMcpRequest = titleSaysMcp || (providerNameSaysMcp && hasOwnInput)
      const isNativeSkillCandidate =
        params.toolCall.kind === 'other' && params.toolCall.title?.trim().toLowerCase() === 'skill'
      if (!isMcpRequest && !isNativeSkillCandidate) return restored
      if (isMcpRequest && hasOwnInput) {
        this.options.onOpenCodeInputWaitOutcome?.({
          sessionId,
          toolCallId: params.toolCall.toolCallId,
          outcome: 'input-present',
          waitedMs: 0
        })
        return restored
      }

      const waitStartedAt = Date.now()
      // This is the moment the question "did we throw away the input this request needs?" can be
      // answered: the request exists, it is one that waits, and its own input is empty. A skip decides
      // from identity alone and never reads the input, so a dropped input is not a loss there.
      if (context.awaitsProviderInput !== false) {
        this.reportRememberedOpenCodeInputDrop(sessionId, params.toolCall.toolCallId)
      }
      const outcome =
        context.awaitsProviderInput === false
          ? this.skipOpenCodeInputWait(sessionId, params.toolCall.toolCallId)
          : await this.waitForOpenCodeMcpToolInput(sessionId, params.toolCall.toolCallId, context)
      if (context.awaitsProviderInput !== false) {
        this.options.onOpenCodeInputWaitOutcome?.({
          sessionId,
          toolCallId: params.toolCall.toolCallId,
          outcome: outcome === 'ready' ? 'resolved' : outcome,
          waitedMs: Math.max(0, Date.now() - waitStartedAt)
        })
      }
      if (outcome === 'cancelled') return undefined
      if (outcome === 'timeout') {
        // Remember when it gave up, so an input that turns up afterwards is reported as late rather than
        // looking like one that was always there.
        const timedOut = this.timedOutInputWaits.get(sessionId) ?? new Map<string, number>()
        this.setBounded(
          timedOut,
          params.toolCall.toolCallId,
          Date.now(),
          MAX_OPENCODE_MCP_TOOL_INPUTS_PER_SESSION
        )
        this.timedOutInputWaits.set(sessionId, timedOut)
        this.options.onOpenCodeWaitTimeout?.({
          sessionId,
          toolCallId: params.toolCall.toolCallId,
          waitMs: OPENCODE_PERMISSION_CONTEXT_WAIT_MS
        })
      }
      const restoredNativeSkill = this.restoreOpenCodeNativeSkillPermission(params, sessionId)
      if (restoredNativeSkill !== params) return restoredNativeSkill
      const finalRequest = this.restoreOpenCodeMcpToolInput(params, sessionId, mcpServerNames)
      if (outcome === 'timeout') this.forgetToolCall(sessionId, params.toolCall.toolCallId)
      return finalRequest
    }
    if (framework !== 'codex' || !isCodexMcpApproval(params)) return params

    const identities = this.codexMcpToolIdentities.get(sessionId)
    const identity = identities?.get(params.toolCall.toolCallId)
    if (!identity || !isMcpToolName(identity.title, mcpServerNames)) return params

    identities?.delete(params.toolCall.toolCallId)
    if (identities?.size === 0) this.codexMcpToolIdentities.delete(sessionId)
    const toolMeta = isRecord(params.toolCall._meta) ? params.toolCall._meta : {}

    return withTrustedMcpToolIdentity(
      {
        ...params,
        toolCall: {
          ...params.toolCall,
          title: params.toolCall.title ?? identity.title,
          rawInput: params.toolCall.rawInput ?? identity.rawInput,
          _meta: { ...toolMeta, toolName: identity.providerToolName }
        }
      },
      identity.mcpIdentity
    )
  }

  isPermissionRequestCancelled(toolCallId: string, context: PermissionRestoreContext): boolean {
    return (
      context.framework === 'opencode' &&
      this.isOpenCodeRequestCancelled(context.sessionId, toolCallId, context)
    )
  }

  cancelAllPending(): void {
    this.broker.cancelAllPending()
    this.humanOnlyRequestIds.clear()
  }

  cancelForSession(sessionId: string): void {
    for (const request of this.getPendingRequests()) {
      if (request.sessionId === sessionId) this.humanOnlyRequestIds.delete(request.requestId)
    }
    this.broker.cancelForSession(sessionId)
    this.clearCorrelationsForSession(sessionId)
  }

  clearSession(sessionId: string): void {
    for (const request of this.getPendingRequests()) {
      if (request.sessionId === sessionId) this.humanOnlyRequestIds.delete(request.requestId)
    }
    this.broker.clearSession(sessionId)
    this.clearCorrelationsForSession(sessionId)
  }

  clearCorrelationsForSession(sessionId: string): void {
    this.codexMcpToolIdentities.delete(sessionId)
    this.claudeCodeMcpToolInputs.delete(sessionId)
    this.opencodeMcpToolInputs.delete(sessionId)
    this.opencodeNativeSkillToolCalls.delete(sessionId)
    this.closedOpenCodeToolCalls.delete(sessionId)
    this.timedOutInputWaits.delete(sessionId)
    this.providerNameOnlyMcpReports.delete(sessionId)
    const sessionWaiters = this.opencodeMcpToolInputWaiters.get(sessionId)
    if (!sessionWaiters) return

    for (const waiters of Array.from(sessionWaiters.values())) {
      for (const finish of Array.from(waiters)) finish('cancelled')
    }
  }

  dispose(): void {
    this.cancelAllPending()
    const sessionIds = new Set([
      ...this.codexMcpToolIdentities.keys(),
      ...this.claudeCodeMcpToolInputs.keys(),
      ...this.opencodeMcpToolInputs.keys(),
      ...this.opencodeNativeSkillToolCalls.keys(),
      ...this.closedOpenCodeToolCalls.keys(),
      ...this.opencodeMcpToolInputWaiters.keys(),
      ...this.timedOutInputWaits.keys(),
      ...this.providerNameOnlyMcpReports.keys()
    ])
    for (const sessionId of sessionIds) this.clearCorrelationsForSession(sessionId)
  }

  snapshot(): AcpPermissionContextSnapshot {
    const pendingRequests = this.getPendingRequests().map((request) => ({
      requestId: request.requestId,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      requiredOrigin: 'human' as const
    }))
    const sessionIds = new Set([
      ...this.codexMcpToolIdentities.keys(),
      ...this.claudeCodeMcpToolInputs.keys(),
      ...this.opencodeMcpToolInputs.keys(),
      ...this.opencodeNativeSkillToolCalls.keys(),
      ...this.closedOpenCodeToolCalls.keys(),
      ...this.opencodeMcpToolInputWaiters.keys()
    ])
    const sessions: Record<string, PermissionContextSessionSnapshot> = {}
    for (const sessionId of sessionIds) {
      sessions[sessionId] = {
        codexMcpIdentities: countNested(this.codexMcpToolIdentities, sessionId),
        claudeCodeMcpInputs: countNested(this.claudeCodeMcpToolInputs, sessionId),
        opencodeMcpInputs: countNested(this.opencodeMcpToolInputs, sessionId),
        opencodeNativeSkills: countNested(this.opencodeNativeSkillToolCalls, sessionId),
        opencodeClosedToolCalls: this.closedOpenCodeToolCalls.get(sessionId)?.size ?? 0,
        pendingWaiters: Array.from(
          this.opencodeMcpToolInputWaiters.get(sessionId)?.values() ?? []
        ).reduce((total, waiters) => total + waiters.size, 0)
      }
    }
    return { pendingRequests, sessions }
  }

  private restoreClaudeCodeMcpToolInput(
    params: RequestPermissionRequest,
    sessionId: string,
    mcpServerNames: readonly string[]
  ): RequestPermissionRequest {
    const title = params.toolCall.title
    if (!isMcpToolName(title, mcpServerNames)) return params

    const inputs = this.claudeCodeMcpToolInputs.get(sessionId)
    const input = inputs?.get(params.toolCall.toolCallId)
    if (!input || input.title !== title) return params

    inputs?.delete(params.toolCall.toolCallId)
    if (inputs?.size === 0) this.claudeCodeMcpToolInputs.delete(sessionId)

    return withTrustedMcpToolIdentity(
      {
        ...params,
        toolCall: {
          ...params.toolCall,
          rawInput: params.toolCall.rawInput ?? input.rawInput,
          _meta: {
            ...(isRecord(params.toolCall._meta) ? params.toolCall._meta : {}),
            toolName: input.providerToolName
          }
        }
      },
      input.mcpIdentity
    )
  }

  private restoreOpenCodeMcpToolInput(
    params: RequestPermissionRequest,
    sessionId: string,
    mcpServerNames: readonly string[]
  ): RequestPermissionRequest {
    const title = params.toolCall.title
    if (!isMcpToolName(title, mcpServerNames)) return params

    const inputs = this.opencodeMcpToolInputs.get(sessionId)
    const input = inputs?.get(params.toolCall.toolCallId)
    if (!input || input.title !== title) return params

    const requestHasInput =
      isRecord(params.toolCall.rawInput) && Object.keys(params.toolCall.rawInput).length > 0
    const cachedHasInput = isRecord(input.rawInput) && Object.keys(input.rawInput).length > 0
    if (requestHasInput || cachedHasInput) {
      inputs?.delete(params.toolCall.toolCallId)
      if (inputs?.size === 0) this.opencodeMcpToolInputs.delete(sessionId)
    }

    return withTrustedMcpToolIdentity(
      {
        ...params,
        toolCall: {
          ...params.toolCall,
          rawInput: requestHasInput ? params.toolCall.rawInput : input.rawInput,
          _meta: {
            ...(isRecord(params.toolCall._meta) ? params.toolCall._meta : {}),
            toolName: input.providerToolName
          }
        }
      },
      input.mcpIdentity
    )
  }

  private restoreOpenCodeNativeSkillPermission(
    params: RequestPermissionRequest,
    sessionId: string
  ): RequestPermissionRequest {
    const calls = this.opencodeNativeSkillToolCalls.get(sessionId)
    if (!calls?.delete(params.toolCall.toolCallId)) return params
    if (calls.size === 0) this.opencodeNativeSkillToolCalls.delete(sessionId)

    const providerToolName = extractProviderToolName(params.toolCall)?.trim().toLowerCase()
    if (
      params.toolCall.kind !== 'other' ||
      params.toolCall.title?.trim().toLowerCase() !== 'skill' ||
      (providerToolName != null && providerToolName !== 'skill')
    ) {
      return params
    }
    return withTrustedNativeToolIdentity(params, 'opencode/skill')
  }

  /**
   * Stands in for the raw-input wait when the caller's decision cannot read that input at all.
   *
   * Returns `'ready'` on purpose: the wait's only product is the provider's late `tool_call` update, and
   * a decision taken from the tool's identity has nothing to do with it. It reports itself so a reading
   * can tell a deliberate skip from a request that never had to wait.
   */
  private skipOpenCodeInputWait(
    sessionId: string,
    toolCallId: string
  ): OpenCodePermissionContextWaitOutcome {
    this.options.onOpenCodeInputWaitSkipped?.({
      sessionId,
      toolCallId,
      reason: 'identity-only-decision'
    })
    return 'ready'
  }

  private waitForOpenCodeMcpToolInput(
    sessionId: string,
    toolCallId: string,
    context: PermissionRestoreContext
  ): Promise<OpenCodePermissionContextWaitOutcome> {
    if (this.isOpenCodeRequestCancelled(sessionId, toolCallId, context)) {
      return Promise.resolve('cancelled')
    }
    if (this.opencodeNativeSkillToolCalls.get(sessionId)?.has(toolCallId)) {
      return Promise.resolve('ready')
    }
    const rawInput = this.opencodeMcpToolInputs.get(sessionId)?.get(toolCallId)?.rawInput
    if (isRecord(rawInput) && Object.keys(rawInput).length > 0) return Promise.resolve('ready')

    return new Promise((resolve) => {
      const sessionWaiters = this.opencodeMcpToolInputWaiters.get(sessionId) ?? new Map()
      const callWaiters =
        sessionWaiters.get(toolCallId) ?? new Set<OpenCodePermissionContextWaiter>()
      const timer: { handle?: ReturnType<typeof setTimeout> } = {}
      let finished = false
      const finish = (outcome: OpenCodePermissionContextWaitOutcome): void => {
        if (finished) return
        finished = true
        if (timer.handle) this.clearTimer(timer.handle)
        callWaiters.delete(finish)
        if (callWaiters.size === 0) sessionWaiters.delete(toolCallId)
        if (sessionWaiters.size === 0) this.opencodeMcpToolInputWaiters.delete(sessionId)
        resolve(outcome)
      }

      callWaiters.add(finish)
      sessionWaiters.set(toolCallId, callWaiters)
      this.opencodeMcpToolInputWaiters.set(sessionId, sessionWaiters)
      timer.handle = this.setTimer(() => finish('timeout'), OPENCODE_PERMISSION_CONTEXT_WAIT_MS)

      if (this.isOpenCodeRequestCancelled(sessionId, toolCallId, context)) {
        finish('cancelled')
        return
      }
      if (this.opencodeNativeSkillToolCalls.get(sessionId)?.has(toolCallId)) {
        finish('ready')
        return
      }
      const latestRawInput = this.opencodeMcpToolInputs.get(sessionId)?.get(toolCallId)?.rawInput
      if (isRecord(latestRawInput) && Object.keys(latestRawInput).length > 0) finish('ready')
    })
  }

  private isOpenCodeRequestCancelled(
    sessionId: string,
    toolCallId: string,
    context: PermissionRestoreContext
  ): boolean {
    return (
      this.closedOpenCodeToolCalls.get(sessionId)?.has(toolCallId) === true || context.isCancelled()
    )
  }

  private resolveOpenCodeWaiters(
    sessionId: string,
    toolCallId: string,
    outcome: OpenCodePermissionContextWaitOutcome = 'ready'
  ): void {
    const waiters = this.opencodeMcpToolInputWaiters.get(sessionId)?.get(toolCallId)
    if (!waiters) return
    for (const finish of Array.from(waiters)) finish(outcome)
  }

  /**
   * Reports an input that turned up after its wait had already given up, then forgets the call.
   *
   * The two are different defects: "the provider sends nothing" argues for skipping the wait, while "the
   * provider is late" argues for relaxing it. Only this line tells them apart in a field log. Returns
   * whether this call was one of them, so the caller does not count the same update twice.
   */
  private reportLateInput(sessionId: string, toolCallId: string): boolean {
    const timedOut = this.timedOutInputWaits.get(sessionId)
    const gaveUpAt = timedOut?.get(toolCallId)
    if (gaveUpAt === undefined) return false
    timedOut?.delete(toolCallId)
    if (timedOut?.size === 0) this.timedOutInputWaits.delete(sessionId)
    this.options.onOpenCodeInputArrivedLate?.({
      sessionId,
      toolCallId,
      lateMs: Math.max(0, Date.now() - gaveUpAt)
    })
    return true
  }

  /**
   * Handles an input that cannot be used, in the three ways it can differ.
   *
   * The provider sends a tool call's input before the permission request for it (measured: update at
   * `15:56:54.836Z`, request at `15:56:55.210Z`), so at this point nothing is waiting yet and "was this
   * loss?" cannot be answered from the call id alone. Three shapes follow, and only one is a defect:
   *
   * - a wait is already pending for this call (the request came first) — the input it is waiting for was
   *   thrown away: report it;
   * - the wait already gave up (this call is in `timedOutInputWaits`) — the input was merely late:
   *   report it through the late channel, which carries `lateMs`;
   * - neither — remember it, and let the request decide. If a request for this call later waits for its
   *   input, that is exactly "we dropped the input this request needed" and it is reported then; if no
   *   such request ever comes (every ordinary `bash`/`read` call, which reports its own arguments here)
   *   nothing was lost and nothing is logged.
   *
   * The old behaviour logged the third shape as a defect: 77 rows over 49 calls and 14 sessions in two
   * days, every one of them non-MCP, none sharing a tool call with any of the 290 waits that timed out.
   */
  private handleUnusableOpenCodeInput(
    sessionId: string,
    toolCallId: string,
    reason: 'not-an-mcp-title' | 'unresolved-identity',
    title: string | null | undefined
  ): void {
    const waiters = this.opencodeMcpToolInputWaiters.get(sessionId)?.get(toolCallId)
    if ((waiters?.size ?? 0) > 0) {
      this.reportDroppedOpenCodeInput(sessionId, toolCallId, { reason, title: title ?? undefined })
      return
    }
    if (this.reportLateInput(sessionId, toolCallId)) return

    const records =
      this.droppedOpenCodeInputs.get(sessionId) ?? new Map<string, DroppedOpenCodeInput>()
    if (records.has(toolCallId)) return
    this.setBounded(
      records,
      toolCallId,
      { reason, ...(title ? { title: title.slice(0, 120) } : {}) },
      MAX_OPENCODE_MCP_TOOL_INPUTS_PER_SESSION
    )
    this.droppedOpenCodeInputs.set(sessionId, records)
  }

  /**
   * Reports a remembered drop once the request it belonged to turns out to wait for the input.
   *
   * Called at the only moment the question can be answered: the request exists, it is an MCP request,
   * and its own input is empty, so the wait that starts here is waiting for the bytes we threw away.
   */
  private reportRememberedOpenCodeInputDrop(sessionId: string, toolCallId: string): void {
    const records = this.droppedOpenCodeInputs.get(sessionId)
    const record = records?.get(toolCallId)
    if (!records || !record) return
    records.delete(toolCallId)
    if (records.size === 0) this.droppedOpenCodeInputs.delete(sessionId)
    this.reportDroppedOpenCodeInput(sessionId, toolCallId, record)
  }

  /** Drops the per-call state of a dropped input (the record itself and the once-per-call report marker). */
  private forgetDroppedInputState(sessionId: string, toolCallId: string): void {
    const dropped = this.droppedOpenCodeInputs.get(sessionId)
    dropped?.delete(toolCallId)
    if (dropped?.size === 0) this.droppedOpenCodeInputs.delete(sessionId)
    const reported = this.openCodeDroppedInputReports.get(sessionId)
    reported?.delete(toolCallId)
    if (reported?.size === 0) this.openCodeDroppedInputReports.delete(sessionId)
  }

  /**
   * Reports a request whose MCP identity lives only in the provider tool name, once per tool call.
   *
   * Without this line the two judgements can disagree silently: the audit line for a request has always
   * checked both names, while the input-restore path only checked the title, so a request could be
   * logged as MCP and still leave that path with no outcome at all. Nothing is reported for the ordinary
   * case (title names the server), so the line counts the disagreement rather than all MCP traffic.
   */
  private reportProviderNameOnlyMcpRequest(
    sessionId: string,
    toolCallId: string,
    shape: { hasOwnInput: boolean; awaitsProviderInput: boolean }
  ): void {
    const reported = this.providerNameOnlyMcpReports.get(sessionId) ?? new Set<string>()
    if (reported.has(toolCallId)) return
    this.addBounded(reported, toolCallId, MAX_OPENCODE_MCP_TOOL_INPUTS_PER_SESSION)
    this.providerNameOnlyMcpReports.set(sessionId, reported)

    this.options.onOpenCodeMcpIdentityInProviderNameOnly?.({
      sessionId,
      toolCallId,
      hasOwnInput: shape.hasOwnInput,
      awaitsProviderInput: shape.awaitsProviderInput
    })
  }

  /** Reports one dropped input per call: a provider that chunks its updates used to produce up to five. */
  private reportDroppedOpenCodeInput(
    sessionId: string,
    toolCallId: string,
    record: DroppedOpenCodeInput
  ): void {
    const reported = this.openCodeDroppedInputReports.get(sessionId) ?? new Set<string>()
    if (reported.has(toolCallId)) return
    this.addBounded(reported, toolCallId, MAX_OPENCODE_MCP_TOOL_INPUTS_PER_SESSION)
    this.openCodeDroppedInputReports.set(sessionId, reported)

    const remembered = this.droppedOpenCodeInputs.get(sessionId)
    remembered?.delete(toolCallId)
    if (remembered?.size === 0) this.droppedOpenCodeInputs.delete(sessionId)
    this.options.onOpenCodeToolCallUpdateUnusable?.({
      sessionId,
      toolCallId,
      reason: record.reason,
      ...(record.title ? { title: record.title } : {})
    })
  }

  private setBounded<T>(
    contexts: Map<string, T>,
    toolCallId: string,
    context: T,
    limit: number
  ): void {
    if (!contexts.has(toolCallId) && contexts.size >= limit) {
      const oldestToolCallId = contexts.keys().next().value
      if (oldestToolCallId) contexts.delete(oldestToolCallId)
    }
    contexts.set(toolCallId, context)
  }

  private addBounded(contexts: Set<string>, toolCallId: string, limit: number): void {
    if (!contexts.has(toolCallId) && contexts.size >= limit) {
      const oldestToolCallId = contexts.values().next().value
      if (oldestToolCallId) contexts.delete(oldestToolCallId)
    }
    contexts.add(toolCallId)
  }

  private deleteToolCall(
    sessionId: string,
    toolCallId: string,
    framework: PermissionFramework
  ): void {
    const codexIdentities = this.codexMcpToolIdentities.get(sessionId)
    codexIdentities?.delete(toolCallId)
    if (codexIdentities?.size === 0) this.codexMcpToolIdentities.delete(sessionId)

    const claudeCodeInputs = this.claudeCodeMcpToolInputs.get(sessionId)
    claudeCodeInputs?.delete(toolCallId)
    if (claudeCodeInputs?.size === 0) this.claudeCodeMcpToolInputs.delete(sessionId)

    const opencodeInputs = this.opencodeMcpToolInputs.get(sessionId)
    opencodeInputs?.delete(toolCallId)
    if (opencodeInputs?.size === 0) this.opencodeMcpToolInputs.delete(sessionId)
    const opencodeNativeSkills = this.opencodeNativeSkillToolCalls.get(sessionId)
    opencodeNativeSkills?.delete(toolCallId)
    if (opencodeNativeSkills?.size === 0) this.opencodeNativeSkillToolCalls.delete(sessionId)
    this.forgetDroppedInputState(sessionId, toolCallId)
    if (framework === 'opencode') {
      const closedToolCalls = this.closedOpenCodeToolCalls.get(sessionId) ?? new Set<string>()
      this.addBounded(closedToolCalls, toolCallId, MAX_OPENCODE_MCP_TOOL_INPUTS_PER_SESSION)
      this.closedOpenCodeToolCalls.set(sessionId, closedToolCalls)
    }
    this.resolveOpenCodeWaiters(sessionId, toolCallId, 'cancelled')
  }

  private forgetToolCall(sessionId: string, toolCallId: string): void {
    const contexts = [
      this.codexMcpToolIdentities,
      this.claudeCodeMcpToolInputs,
      this.opencodeMcpToolInputs,
      this.opencodeNativeSkillToolCalls
    ] as const
    for (const sessions of contexts) {
      const calls = sessions.get(sessionId)
      calls?.delete(toolCallId)
      if (calls?.size === 0) sessions.delete(sessionId)
    }
    this.forgetDroppedInputState(sessionId, toolCallId)
    this.resolveOpenCodeWaiters(sessionId, toolCallId, 'cancelled')
  }

  private toolIdentityForDiagnostics(
    providerToolName: string | undefined,
    sessionId: string
  ): string | undefined {
    if (!providerToolName) return undefined
    const mcpServerNames = this.options.routing.mcpServerNamesFor(sessionId)
    return resolveCanonicalMcpToolIdentity(providerToolName, mcpServerNames) ?? providerToolName
  }
}

export {
  AcpPermissionContext,
  AGENT_PERMISSION_ACTION_ORIGIN,
  HUMAN_PERMISSION_ACTION_ORIGIN,
  SYSTEM_PERMISSION_ACTION_ORIGIN
}
export type {
  AcpPermissionContextOptions,
  AcpPermissionContextSnapshot,
  AuthorizedPermissionActionOrigin,
  PermissionRestoreContext,
  PermissionToolContext
}
