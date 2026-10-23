// Orchestrator for the auto-review pipeline. `runReview` is called after each turn completes;
// it spawns a fresh-context reviewer ACP session, injects the rubric + scope-bounded reviewer MCP,
// drives the reviewer to completion, persists findings, and then disposes the session.
//
// Phase 3: after a review with warn/fail, `runFixLoop` drives the bounded re-review loop:
// inject → correction turn → re-review new blocks → resolve/reflag → repeat (max 3 rounds).
//
// Errors are isolated: reviewer failures set lifecycle='error' and do NOT crash the main session.

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

import type { ActiveSession } from '@agentclientprotocol/sdk'

import { withReviewerRuntimeActivity, type ReviewerAcpRuntime } from './acp-runtime'
import { createLogger, errorLogFields } from '../logger'
import { extractProviderToolName, extractTerminalMeta } from '../acp/runtime-events'
import type {
  NewCheck,
  ReviewCheck,
  ReviewerLogEntry,
  ReviewOutcome,
  ReviewWithChecks,
  TurnScope
} from '../../shared/reviewer'
import type { ReviewRepository } from './repository'
import { resolveTurnScopeWithArtifactDigests } from './artifact-digest'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { ReviewerMcpServer } from './mcp-server'
import { cleanupReviewerResources } from './session-cleanup'
import { ReviewerHostServer, type ArtifactVersionContentResolver } from './host-sdk'
import { createExternalSourceFetcher } from './external-source-fetch'
import { buildReviewScopeSnapshot } from './scope-snapshot'
import { REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND } from './rubric'
import { buildSupervisorNotice, type SupervisorPlan } from '../../shared/supervisor-signals'
import { injectAuditorMessage } from './correction'
import { buildHistoryPreamble } from '../../shared/history-preamble'
import { getActiveConversationContext } from '../../shared/conversation-graph'

const log = createLogger('reviewer:orchestrator')

type SessionProvider = (
  sessionId: string
) => PersistedChatSession | undefined | Promise<PersistedChatSession | undefined>

type ReviewMutationRunner = <Result>(mutation: () => Promise<Result>) => Promise<Result>

const runReviewMutation = <Result>(
  runner: ReviewMutationRunner | undefined,
  mutation: () => Promise<Result>
): Promise<Result> => (runner ? runner(mutation) : mutation())

export type RunReviewOptions = {
  sessionId: string
  // Supervisor wake-ups for this turn, carried from the renderer's request (shared/supervisor-signals).
  // Injected into the reviewer's instructions so the flags are verified rather than re-derived, and so a
  // degraded run is reported as degraded.
  supervisor?: SupervisorPlan
  // The turn to review: the agent message id (or user message id) for that turn. This is also the
  // grouping id stored on the Review row.
  turnMessageId: string
  // Turn whose content is audited when it differs from turnMessageId (e.g. re-running a fix-loop
  // review). The scope is resolved from this turn; the row is still grouped under turnMessageId.
  // Defaults to turnMessageId.
  scopeTurnMessageId?: string
  // Called once the running Review row has been created and pushed — i.e. the review is confirmed to
  // have started. A failure before this point (scope resolution, the DB insert) throws without calling
  // it, so the caller can report started:false and leave the turn retriable.
  onStarted?: () => void
  // The project this session belongs to.
  projectId: string
  // Used to resolve the session's persisted data for turn-scope resolution.
  // For the fix loop, this is called after each correction turn so it must return the LATEST session.
  getSession: SessionProvider
  // Repository for persisting review rows + checks.
  reviewRepository: ReviewRepository
  // Joins every durable Review write to the Session deletion/save ordering boundary without holding
  // the lock while the remote reviewer model is running.
  runSessionMutation?: ReviewMutationRunner
  // The ACP runtime that owns the agent connection (used to spawn the reviewer session).
  acpRuntime: ReviewerAcpRuntime
  // Storage root for artifact reads (used by the scope-bounded evidence reader).
  artifactStorageRoot: string
  // Native Version resolver for current provenance rows. Tests and legacy callers may omit it and
  // retain the old session-path lookup.
  artifactVersionContentResolver?: ArtifactVersionContentResolver
  // Main-process entry reused by the Windows-only Reviewer stdio proxy.
  reviewerMcpEntryPath?: string
  // The model/provider tag to record on the Review row.
  model?: string
  // Called when the review lifecycle changes, so the IPC layer can broadcast updates.
  onReviewUpdate?: (review: ReviewWithChecks) => void
  // The main session id to inject the [Auditor] correction message into (if warn/fail checks).
  // When omitted, correction injection is skipped.
  mainSessionId?: string
  // Optional hook called with the auditor message text before it is sent. Used in tests.
  onCorrectionPrompt?: (text: string) => void
  // Optional hook called if the correction sendPrompt fails, so the caller can clear the pre-emptive
  // auto-review suppression it set before the correction turn (the failed turn emits no stop).
  onCorrectionFailed?: () => void
  // Optional hook called when runReview is invoked externally; used in tests to assert no
  // recursive re-review is triggered by the correction path.
  onRunReviewCalled?: () => void
  // Wall-clock budget for the reviewer session drive loop before it is aborted as an error.
  reviewerTimeoutMs?: number
  // Hard cap on reviewer session updates before the drive loop aborts (guards a fast-looping agent).
  reviewerMaxUpdates?: number
  // Distinct tool calls one review run may make before it stops without a verdict (cost ceiling).
  reviewerMaxToolCalls?: number
  // Maximum number of fix-loop iterations (whole-loop counter cap). Defaults to 3.
  fixLoopMaxRounds?: number
  // Called just before the fix loop starts (after initial review finds warn/fail). Used to lock
  // the session composer in the renderer.
  onFixLoopStart?: () => void
  // Called when the fix loop ends (all pass, cap reached, or aborted). Used to unlock the session
  // composer in the renderer.
  onFixLoopEnd?: () => void
  // AbortSignal to stop the fix loop early (e.g. when the user presses cancel). When aborted,
  // the loop exits at the next round boundary without further [Auditor] injections.
  fixLoopAbortSignal?: AbortSignal
  // How long the fix loop waits for the correction turn to reach durable session storage. The main
  // agent can finish before the renderer's persistence queue flushes, so a single immediate read races.
  sessionRefreshTimeoutMs?: number
}

// Default drive-loop guards. The wall-clock timeout is the primary backstop against a reviewer that
// never stops (it is the only guard that catches a reviewer stuck streaming thoughts forever, since
// those do not count toward the update cap — see below). The update cap is a secondary backstop
// against a fast-looping reviewer that spins through discrete actions. Reviews do real multi-step
// evidence tracing, so the timeout is generous.
const DEFAULT_REVIEWER_TIMEOUT_MS = 900_000
const DEFAULT_REVIEWER_MAX_UPDATES = 1000

// Tool-call budget for ONE reviewer run.
//
// Measured on the installed app's own Review rows (field database: 151 reviews that recorded tool
// calls — median 25 calls, p90 90, p99 164, max 202; the heaviest spent 186 of its 202 on
// query_execution_log, one activity at a time). 300 is 1.48× the heaviest review ever observed, so an
// honestly deep review keeps its headroom and none of the observed runs would have been stopped.
//
// What this guard is NOT: the 900 s wall clock already bounds a slow review. Measured per-call cost is
// median 5.2 s (p90 10.4 s, max 21.4 s over 96 reviews with ≥20 calls and a plausible duration), i.e.
// at the median pace 900 s admits only ~170 calls — so on a slow review the clock fires first and this
// budget never binds. It exists for the other shape: a looping agent making *cheap* calls (the heaviest
// observed review ran 202 calls in 313 s ≈ 1.55 s per call) would otherwise spend the whole wall-clock
// window. At that pace 300 calls is ~7.5 min, half the window, and the run stops with a reason instead
// of grinding on until the timeout tells a less useful story.
const DEFAULT_REVIEWER_MAX_TOOL_CALLS = 300
// Warn once when the budget is this far spent, so the field log shows near-misses (which is the only
// way to tell "300 is too tight" from "300 is right") without adding a second counter anywhere.
const REVIEWER_TOOL_BUDGET_WARN_RATIO = 0.8

// The message a budget stop writes into Review.errorMessage. The renderer classifies it by the
// literal `exceeded tool-call budget` (lib/reviewer-error-copy), so that phrase must survive edits.
const reviewerToolBudgetMessage = (budget: number): string =>
  `reviewer session exceeded tool-call budget (${budget}) — review stopped without a verdict. ` +
  'No checks were recorded for this turn: re-run the review, or review a smaller turn.'

const DEFAULT_SESSION_REFRESH_TIMEOUT_MS = 10_000
const SESSION_REFRESH_POLL_MS = 50

// A review can end without submit_findings for two very different reasons: the reviewer genuinely
// stalled, or the permission gate rejected its tool calls. The rejection counter cannot tell these
// apart — it counts every rejected call, including tools the gate is *meant* to block (Bash/network) —
// so the message reports the count as context without asserting it blocked submit_findings.
const incompleteReviewMessage = (rejectedToolCalls: number, nudged = false): string =>
  nudged
    ? 'Reviewer stopped without calling submit_findings, and one follow-up turn produced none ' +
      'either; ' +
      `${rejectedToolCalls} tool call(s) were also rejected by the permission gate.`
    : rejectedToolCalls > 0
      ? 'Reviewer stopped without calling submit_findings; ' +
        `${rejectedToolCalls} tool call(s) were also rejected by the permission gate.`
      : 'Reviewer stopped without calling submit_findings.'

// One bounded follow-up when the reviewer ends its turn with nothing submitted. Field log
// (2026-10-21/23, 100 reviews): 15 reviews ended with zero checks and **every one of them** had at
// least one rejected tool call (16 rejections over those 15 sessions: 9 `think`, 7 `execute`) — the
// gate refused a call the reviewer had already committed to, and it closed the turn instead of
// continuing with the tools it does have. Discarding the whole review is the expensive half of that
// interaction: the findings that were already reasoned about never reach the reader.
//
// The follow-up is bounded (one turn, a fraction of the tool budget) and only fires when the model
// ended its own turn (`end_turn`): a timeout or budget stop already threw, and a cancellation must
// not be argued with. It names the refusal so a repeated attempt is not the model's only option.
const EMPTY_TURN_FOLLOW_UP_PROMPT =
  'Your previous turn ended without calling submit_findings, so no verdict was recorded for this ' +
  'review. Background reviewers get only the reviewer tools: shell, network and native editor calls ' +
  'are refused by the permission gate, and a refused call cannot be retried. Do not repeat it. ' +
  'Continue the review from where you stopped using the tools the gate allows (read the frozen ' +
  'turn, read artifacts, query the execution log, fetch an external source), then call ' +
  'submit_findings exactly once with a pass/warn/fail check for every item in scope. If an item ' +
  'cannot be verified with the tools you have, record that as a check with a named reason rather ' +
  'than ending the turn silently.'

// The follow-up may not re-open the full budget: it exists to finish a review, not to restart one.
const REVIEWER_FOLLOW_UP_BUDGET_DIVISOR = 4

const REVIEWER_BRIDGE_SCOPE_ERROR =
  'Reviewer request was not constrained to the reviewer-only tool scope.'

// Teardown order (session → agent → MCP server) is a contract with its own unit test, so the
// orchestrator only calls it; see reviewer/session-cleanup.ts for why the order matters.

// Streaming content deltas are emitted one-per-chunk as the reviewer writes its message/thinking, so
// their count tracks how much it *says*, not how much it *does*. Counting them toward the loop cap
// made a normally-verbose review trip the guard mid-stream before it could call submit_findings. Only
// discrete updates (tool calls, plans, tool-call status changes) count toward maxUpdates; a genuine
// runaway loop shows up there, while a hung/rambling reviewer is caught by the wall-clock timeout.
const STREAMING_CHUNK_UPDATES = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'user_message_chunk'
])

// The minimal reviewer-session surface the drive loop needs. `update.sessionUpdate` is the ACP
// SessionUpdate discriminator, present on session_update messages (absent on the stop message).
type DrivableSession = {
  nextUpdate: () => Promise<{
    kind: string
    stopReason?: string
    update?: { sessionUpdate?: string; [key: string]: unknown }
  }>
}

// Options for the driveReviewerToStop log-capture callback.
type DriveOptions = {
  timeoutMs: number
  maxUpdates: number
  // Distinct tool calls one reviewer run may make before it is stopped. Omitted ⇒ the module default.
  maxToolCalls?: number
}

type DriveCallbacks = {
  // Called for each update that should be captured into the reviewer log.
  // The caller assembles streaming chunks into whole entries and appends them.
  onUpdate?: (entry: ReviewerLogEntry) => void
}

// In-flight accumulator for streaming content (thought/message chunks are assembled into whole entries).
// Also tracks in-progress tool entries by toolCallId so tool_call_update can merge into the same entry.
type ChunkAccumulator = {
  thoughtText: string | null
  messageText: string | null
  // Map from toolCallId to the mutable tool log entry (shared reference allows update-in-place).
  pendingTools: Map<string, ReviewerLogEntry & { kind: 'tool' }>
}

// Extracts a text chunk from an ACP update's content field (may be a { type:'text', text:string } block).
const extractTextContent = (update: { content?: unknown }): string => {
  const c = update.content
  if (!c) return ''
  if (typeof c === 'string') return c
  if (
    typeof c === 'object' &&
    c !== null &&
    'text' in c &&
    typeof (c as { text: unknown }).text === 'string'
  ) {
    return (c as { text: string }).text
  }
  return ''
}

// Serializes an ACP raw tool input/output value to a display string. Strings pass through unchanged;
// objects are JSON-encoded (never String()'d, which would produce "[object Object]"). Falls back to
// String() only when the value cannot be serialized (e.g. a circular reference).
const stringifyRaw = (value: unknown): string => {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// Flushes any in-flight thought/message accumulator and returns the emitted entry (or null if nothing to flush).
const flushAccumulator = (
  acc: ChunkAccumulator,
  onUpdate: ((entry: ReviewerLogEntry) => void) | undefined
): void => {
  if (acc.thoughtText !== null && acc.thoughtText.length > 0) {
    onUpdate?.({ kind: 'thought', text: acc.thoughtText })
    acc.thoughtText = null
  }
  if (acc.messageText !== null && acc.messageText.length > 0) {
    onUpdate?.({ kind: 'message', text: acc.messageText })
    acc.messageText = null
  }
}

// Sentinel used to distinguish the timeout branch from a real reviewer update in Promise.race.
const TIMEOUT = Symbol('reviewer-drive-timeout')

// Consumes reviewer session updates until it stops, returning the stop reason. Throws if the
// reviewer does not stop within timeoutMs, or if it emits more than maxUpdates discrete updates —
// either way the caller sets lifecycle='error' and disposes the session + servers. Prevents a hung
// or runaway reviewer from pinning the host/MCP servers open and leaving the review row 'running'.
//
// The optional `onUpdate` callback in `callbacks` is called once per assembled log entry:
// streaming chunks (agent_thought_chunk, agent_message_chunk) are assembled into whole entries before
// the callback fires; tool_call and tool_result updates are emitted immediately. The loop-guard
// behavior is unchanged: streaming chunks still don't count toward maxUpdates.
export const driveReviewerToStop = async (
  session: DrivableSession,
  options: DriveOptions,
  callbacks?: DriveCallbacks
): Promise<string | undefined> => {
  const { timeoutMs, maxUpdates } = options
  const { onUpdate } = callbacks ?? {}
  const toolBudget = options.maxToolCalls ?? DEFAULT_REVIEWER_MAX_TOOL_CALLS
  const warnAt = Math.max(1, Math.ceil(toolBudget * REVIEWER_TOOL_BUDGET_WARN_RATIO))
  const deadline = Date.now() + timeoutMs
  let updates = 0
  // Distinct tool calls (by ACP toolCallId), which is what a review's cost actually tracks: one call =
  // one model round trip. A `tool_call_update` for a call already counted is that same call finishing,
  // and a call arriving with no id at all can only be counted as it arrives.
  const countedToolCalls = new Set<string>()
  let toolCalls = 0
  let budgetWarned = false

  // In-flight accumulator for streaming text chunks (assembled into whole entries on transition).
  const acc: ChunkAccumulator = { thoughtText: null, messageText: null, pendingTools: new Map() }

  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('reviewer session timed out before stopping')

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), remaining)
    })

    try {
      const result = await Promise.race([session.nextUpdate(), timeout])
      if (result === TIMEOUT) throw new Error('reviewer session timed out before stopping')

      if (result.kind === 'stop') {
        // Flush any in-flight streaming chunks before returning.
        flushAccumulator(acc, onUpdate)
        // One line per reviewer run: the tool-call count is what tunes the budget above, and it is
        // otherwise only recoverable by parsing the captured log of every review row.
        log.info('reviewer drive stopped', { stopReason: result.stopReason, toolCalls, toolBudget })
        return result.stopReason
      }

      const sessionUpdate = result.update?.sessionUpdate ?? ''

      // Only discrete updates count toward the loop cap; streaming content chunks do not (they scale
      // with output length, not work, and would trip the guard on a normal verbose review).
      if (!STREAMING_CHUNK_UPDATES.has(sessionUpdate)) {
        updates++
        if (updates >= maxUpdates) {
          throw new Error(`reviewer session exceeded max updates (${maxUpdates})`)
        }
      }

      // Tool-call budget. Counted here rather than from the captured log so it also holds when no
      // `onUpdate` callback is wired. A stop is honest, not silent: the caller records this message as
      // the review's error, and the panel shows the budget family instead of a verdict that never came.
      if (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
        const callId = result.update?.toolCallId
        if (typeof callId === 'string' && callId.length > 0) {
          if (!countedToolCalls.has(callId)) {
            countedToolCalls.add(callId)
            toolCalls++
          }
        } else {
          toolCalls++
        }
        if (toolCalls >= toolBudget) {
          log.warn('reviewer tool-call budget exhausted', { toolCalls, toolBudget })
          throw new Error(reviewerToolBudgetMessage(toolBudget))
        }
        if (!budgetWarned && toolCalls >= warnAt) {
          budgetWarned = true
          log.warn('reviewer tool-call budget nearly exhausted', { toolCalls, toolBudget })
        }
      }

      // --- Log capture: assemble chunks into entries and emit discrete events ---
      if (onUpdate && result.update) {
        const u = result.update

        if (sessionUpdate === 'agent_thought_chunk') {
          // Flush any in-progress message accumulator first (content type switched).
          if (acc.messageText !== null && acc.messageText.length > 0) {
            onUpdate({ kind: 'message', text: acc.messageText })
            acc.messageText = null
          }
          // Accumulate into thought buffer.
          acc.thoughtText = (acc.thoughtText ?? '') + extractTextContent(u as { content?: unknown })
        } else if (sessionUpdate === 'agent_message_chunk') {
          // Flush any in-progress thought accumulator first (content type switched).
          if (acc.thoughtText !== null && acc.thoughtText.length > 0) {
            onUpdate({ kind: 'thought', text: acc.thoughtText })
            acc.thoughtText = null
          }
          // Accumulate into message buffer.
          acc.messageText = (acc.messageText ?? '') + extractTextContent(u as { content?: unknown })
        } else if (sessionUpdate === 'tool_call') {
          // Flush any in-flight streaming content before a discrete tool call.
          flushAccumulator(acc, onUpdate)
          // Extract the real tool name from ACP provider metadata (_meta.claudeCode.toolName etc.).
          // The top-level `toolName` field is absent in ACP; only the _meta path carries the name.
          const realToolName =
            extractProviderToolName(u as { _meta?: unknown }) ??
            (u.toolName as string | undefined) ??
            ''
          const toolCallId = (u.toolCallId as string | undefined) ?? ''
          const entry: ReviewerLogEntry & { kind: 'tool' } = {
            kind: 'tool',
            toolName: realToolName,
            title: u.title as string | undefined,
            rawInput: u.rawInput !== undefined ? stringifyRaw(u.rawInput) : undefined
          }
          // Remember by toolCallId so tool_call_update can mutate the same object in-place.
          if (toolCallId) {
            acc.pendingTools.set(toolCallId, entry)
          }
          onUpdate(entry)
        } else if (sessionUpdate === 'tool_call_update') {
          // ACP never emits tool_result — updates arrive as tool_call_update carrying rawOutput,
          // terminal stdout, exit code, and the final status. Mutate the in-flight entry in-place
          // so the already-appended log entry (shared reference) is updated without re-emit.
          const toolCallId = (u.toolCallId as string | undefined) ?? ''
          let entry = toolCallId ? acc.pendingTools.get(toolCallId) : undefined
          if (!entry) {
            // Defensive: no prior tool_call seen — create a fresh tool entry now.
            const realToolName =
              extractProviderToolName(u as { _meta?: unknown }) ??
              (u.toolName as string | undefined) ??
              ''
            entry = {
              kind: 'tool',
              toolName: realToolName,
              title: u.title as string | undefined
            }
            if (toolCallId) acc.pendingTools.set(toolCallId, entry)
            onUpdate(entry)
          }
          // Merge input/output fields into the existing entry. Claude Code seeds the initial
          // tool_call with an empty {} input and supplies the real arguments here, so a defined
          // rawInput on the update overrides the seed (mirrors the main-agent `rawInput ?? old` merge).
          if (u.rawInput !== undefined) {
            entry.rawInput = stringifyRaw(u.rawInput)
          }
          if (u.rawOutput !== undefined) {
            entry.rawOutput = stringifyRaw(u.rawOutput)
          }
          const { terminalOutput, terminalExitCode } = extractTerminalMeta(
            u as Parameters<typeof extractTerminalMeta>[0]
          )
          if (terminalOutput !== undefined) {
            // Terminal stdout/stderr replaces rawOutput if it arrives via _meta.terminal_output.data
            entry.rawOutput = terminalOutput
          }
          if (terminalExitCode !== undefined) {
            entry.exitCode = terminalExitCode
          }
          // Normalize ACP status to 'ok' | 'error'.
          const statusRaw = u.status as string | undefined
          if (statusRaw === 'completed') {
            entry.status = 'ok'
          } else if (statusRaw === 'failed' || statusRaw === 'error') {
            entry.status = 'error'
          } else if (statusRaw === 'ok' || statusRaw === 'error') {
            entry.status = statusRaw
          }
        }
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

// The reviewer session as the follow-up needs it: the drive loop's `nextUpdate` plus the prompt entry
// point that is already used to start a review (both live on the ACP ActiveSession).
type DrivableReviewerSession = DrivableSession & {
  prompt: (blocks: Array<{ type: 'text'; text: string }>) => unknown
}

// Drives the reviewer to a stop, and — when it ended its own turn with nothing submitted — gives it
// exactly one follow-up turn to finish (`EMPTY_TURN_FOLLOW_UP_PROMPT`).
//
// `isSubmitted` is read between the two drives rather than after the loop because submit_findings
// arrives over the MCP server, not through the session updates: a reviewer can submit and still keep
// talking, and a reviewer that submitted needs no follow-up. The returned `nudged` flag is what the
// failure message reports, so "we asked once more and it still produced nothing" never reads like the
// single silent turn it used to be.
const driveReviewerWithFollowUp = async (
  session: DrivableReviewerSession,
  options: DriveOptions,
  callbacks: DriveCallbacks,
  isSubmitted: () => boolean,
  onFollowUp?: () => void
): Promise<{ stopReason: string | undefined; nudged: boolean }> => {
  const stopReason = await driveReviewerToStop(session, options, callbacks)
  if (isSubmitted() || stopReason !== 'end_turn') return { stopReason, nudged: false }

  const followUpBudget = Math.max(
    1,
    Math.floor(
      (options.maxToolCalls ?? DEFAULT_REVIEWER_MAX_TOOL_CALLS) / REVIEWER_FOLLOW_UP_BUDGET_DIVISOR
    )
  )
  log.info('reviewer ended its turn without submit_findings; one follow-up sent', {
    stopReason,
    followUpBudget
  })
  onFollowUp?.()
  session.prompt([{ type: 'text', text: EMPTY_TURN_FOLLOW_UP_PROMPT }])
  const followUpStopReason = await driveReviewerToStop(
    session,
    { ...options, maxToolCalls: followUpBudget },
    callbacks
  )
  log.info('reviewer follow-up finished', {
    stopReason: followUpStopReason,
    submitted: isSubmitted()
  })
  return { stopReason: followUpStopReason, nudged: true }
}

// Options for the Phase 3 fix loop.
type FixLoopOptions = {
  sessionId: string
  // The original turn's message id (shared across all Review rows in this closure).
  originalTurnMessageId: string
  // The currently-open warn/fail checks to carry forward into each re-review.
  openChecks: ReviewCheck[]
  projectId: string
  mainSessionId: string
  getSession: SessionProvider
  reviewRepository: ReviewRepository
  runSessionMutation?: ReviewMutationRunner
  acpRuntime: ReviewerAcpRuntime
  artifactStorageRoot: string
  artifactVersionContentResolver?: ArtifactVersionContentResolver
  reviewerMcpEntryPath?: string
  model: string
  onReviewUpdate?: (review: ReviewWithChecks) => void
  onCorrectionPrompt?: (text: string) => void
  onCorrectionFailed?: () => void
  reviewerTimeoutMs: number
  reviewerMaxUpdates: number
  reviewerMaxToolCalls: number
  maxRounds: number
  sessionRefreshTimeoutMs: number
  // Carried into each round's scoped re-review so a correction round is audited with the same
  // supervisor leads the original review saw (see shared/supervisor-signals).
  supervisor?: SupervisorPlan
  // Optional abort signal: when aborted, the loop exits at the next round boundary.
  abortSignal?: AbortSignal
}

// What the post-correction wait saw, named. Every failure used to reach the caller as `undefined`, so
// the field log could only say "the correction turn did not reach durable storage" — a sentence that is
// equally true of a Session that was never written, of one that grew without an agent message, and of
// one whose agent message is still marked `streaming`. Those want three different fixes, and 28/28
// refusals in nine days of logs could not be attributed to any of them. Reported, not acted on: the
// wait's budget and the refusal are unchanged.
export type CorrectionWaitResult =
  | {
      status: 'found'
      session: PersistedChatSession
      message: PersistedChatSession['messages'][number]
      elapsedMs: number
      polls: number
    }
  | { status: 'aborted'; elapsedMs: number; polls: number }
  | { status: 'session-missing'; elapsedMs: number; polls: number }
  | {
      status: 'no-new-agent-message'
      elapsedMs: number
      polls: number
      newMessages: number
      lastRole?: string
      lastStatus?: string
    }
  | {
      status: 'agent-message-incomplete'
      elapsedMs: number
      polls: number
      messageId: string
      messageStatus: string
    }

export const waitForCorrectionAgentMessage = async (options: {
  sessionId: string
  messageIdsBefore: ReadonlySet<string>
  getSession: SessionProvider
  timeoutMs: number
  abortSignal?: AbortSignal
}): Promise<CorrectionWaitResult> => {
  const startedAt = Date.now()
  const deadline = startedAt + options.timeoutMs
  let polls = 0
  let sawSession = false

  for (;;) {
    if (options.abortSignal?.aborted) {
      return { status: 'aborted', elapsedMs: Date.now() - startedAt, polls }
    }

    const latest = await options.getSession(options.sessionId)
    polls += 1
    // Messages that are newer than the pre-correction snapshot, whatever their role or status — the
    // failure shapes are described in terms of these, so they are collected before the match attempt.
    let fresh: PersistedChatSession['messages'] = []
    if (latest) {
      sawSession = true
      fresh = latest.messages.filter((message) => !options.messageIdsBefore.has(message.id))
      const correction = fresh.find(
        (message) => message.role === 'agent' && message.status === 'complete'
      )
      if (correction) {
        return {
          status: 'found',
          session: latest,
          message: correction,
          elapsedMs: Date.now() - startedAt,
          polls
        }
      }
    }

    if (Date.now() >= deadline) {
      const elapsedMs = Date.now() - startedAt
      if (!sawSession) return { status: 'session-missing', elapsedMs, polls }
      const freshAgent = fresh.find((message) => message.role === 'agent')
      if (freshAgent) {
        return {
          status: 'agent-message-incomplete',
          elapsedMs,
          polls,
          messageId: freshAgent.id,
          messageStatus: String(freshAgent.status)
        }
      }
      const last = fresh[fresh.length - 1]
      return {
        status: 'no-new-agent-message',
        elapsedMs,
        polls,
        newMessages: fresh.length,
        ...(last ? { lastRole: last.role, lastStatus: String(last.status) } : {})
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SESSION_REFRESH_POLL_MS))
  }
}

// Log fields for a wait that did not find the correction turn — the numbers that tell the three
// shapes apart. Nothing here names message text or provider material; ids and statuses only.
const waitDiagnostics = (
  result: Exclude<CorrectionWaitResult, { status: 'found' }>
): Record<string, string | number> => {
  switch (result.status) {
    case 'session-missing':
      return { polls: result.polls, elapsedMs: result.elapsedMs }
    case 'no-new-agent-message':
      return {
        polls: result.polls,
        elapsedMs: result.elapsedMs,
        newMessages: result.newMessages,
        ...(result.lastRole ? { lastRole: result.lastRole } : {}),
        ...(result.lastStatus ? { lastStatus: result.lastStatus } : {})
      }
    case 'agent-message-incomplete':
      return {
        polls: result.polls,
        elapsedMs: result.elapsedMs,
        messageId: result.messageId,
        messageStatus: result.messageStatus
      }
    case 'aborted':
      return { polls: result.polls, elapsedMs: result.elapsedMs }
  }
}

// Runs the Phase 3 bounded re-review loop. For each round (up to maxRounds):
// 1. Injects [Auditor] with the still-open warn/fail checks.
// 2. The main agent produces a correction turn.
// 3. Re-reviews the correction turn's new blocks.
// 4. Updates each original finding by its stable sourceFindingId:
//    - pass → resolved
//    - warn/fail → incrementReflagCount; stays open
//    - missing/unknown/duplicate id → submission rejected, original stays open
// 5. If all resolved or cap reached, stops.
// Cap termination marks remaining open warn/fail checks as 'unaddressed'.
const runFixLoop = async (options: FixLoopOptions): Promise<void> => {
  const {
    sessionId,
    originalTurnMessageId,
    projectId,
    mainSessionId,
    getSession,
    reviewRepository,
    runSessionMutation,
    acpRuntime,
    artifactStorageRoot,
    artifactVersionContentResolver,
    reviewerMcpEntryPath,
    model,
    onReviewUpdate,
    onCorrectionPrompt,
    onCorrectionFailed,
    reviewerTimeoutMs,
    reviewerMaxUpdates,
    reviewerMaxToolCalls,
    maxRounds,
    sessionRefreshTimeoutMs,
    abortSignal
  } = options

  let openChecks = [...options.openChecks]
  const commitDispositionBatch = async (
    inputs: Parameters<ReviewRepository['commitFindingDispositions']>[0]
  ): Promise<void> => {
    if (inputs.length === 0) return
    await runReviewMutation(runSessionMutation, () =>
      reviewRepository.commitFindingDispositions(inputs)
    )

    // Finding/disposition writes change the original Review card without creating a new Review row.
    // Push each mutated row after commit so open Reviewer and Provenance surfaces reload immediately.
    const mutatedReviewIds = new Set(inputs.map((input) => input.reviewId))
    const reviews = await reviewRepository.getReviewsForProjectSession(projectId, sessionId)
    for (const review of reviews) {
      if (mutatedReviewIds.has(review.id)) onReviewUpdate?.(review)
    }
  }
  const markOpenChecksUnaddressed = async (
    trigger: 'loop_terminated' | 'correction_failed' | 'aborted',
    note: string
  ): Promise<void> => {
    await commitDispositionBatch(
      openChecks.map((openCheck) => ({
        reviewId: openCheck.reviewId,
        sourceFindingId: openCheck.id,
        trigger,
        outcome: 'unaddressed',
        note,
        assessedArtifactVersionId: openCheck.artifactVersionId
      }))
    )
  }

  for (let round = 0; round < maxRounds; round++) {
    if (openChecks.length === 0) break

    // Abort check: if the user cancelled during the loop, exit without further [Auditor] injections.
    if (abortSignal?.aborted) {
      log.info('fix loop: aborted by user', { sessionId, round, openCount: openChecks.length })
      await markOpenChecksUnaddressed('aborted', 'The fix loop was aborted by the user.')
      return
    }

    // Step A: record every known message id before the correction prompt. The provider is awaited on
    // every use; production reloads durable storage rather than returning the initial review snapshot.
    let sessionBefore: PersistedChatSession | undefined
    try {
      sessionBefore = await getSession(sessionId)
    } catch (error) {
      log.warn('fix loop: failed to load durable session before correction', {
        sessionId,
        round,
        error: error instanceof Error ? error.message : String(error)
      })
      await markOpenChecksUnaddressed('correction_failed', 'Could not load the durable session.')
      return
    }
    if (!sessionBefore) {
      log.warn('fix loop: durable session disappeared before correction', { sessionId, round })
      await markOpenChecksUnaddressed('correction_failed', 'The durable session disappeared.')
      return
    }
    const messagesBefore = sessionBefore.messages
    const messageIdsBefore = new Set(messagesBefore.map((message) => message.id))

    // Step B: inject [Auditor] with the currently-open warn/fail checks.
    let correctionFailed = false
    try {
      const provenanceContext = getActiveConversationContext(
        materializeSessionConversationGraph(sessionBefore).conversationGraph!,
        `prompt-${randomUUID()}`
      )
      await injectAuditorMessage({
        sessionId,
        mainSessionId,
        findings: openChecks,
        acpRuntime,
        provenanceContext,
        onCorrectionPrompt,
        onCorrectionFailed: () => {
          correctionFailed = true
          onCorrectionFailed?.()
        }
      })
    } catch (error) {
      correctionFailed = true
      log.warn('fix loop: failed to derive correction provenance', {
        sessionId,
        round,
        error: error instanceof Error ? error.message : String(error)
      })
    }

    // Error handling: a failed correction counts as a round (prevents infinite loop) but we
    // cannot re-review (there's no correction turn). Mark remaining as unaddressed and stop.
    if (correctionFailed) {
      log.warn('correction failed in fix loop — marking remaining checks unaddressed', {
        sessionId,
        round,
        openCount: openChecks.length
      })
      await markOpenChecksUnaddressed('correction_failed', 'The correction prompt failed.')
      return
    }

    // Step C: wait for the new agent message to reach durable storage. sendPrompt completion and the
    // renderer persistence queue are independent, so an immediate one-shot reload is still racy.
    // The wait reports *why* it gave up: "never written", "written without an agent message", and
    // "written with the agent message still streaming" are three different defects, and the single
    // refusal sentence below used to cover all three (28/28 refusals over nine days were unattributable).
    let correctionWait: CorrectionWaitResult
    try {
      correctionWait = await waitForCorrectionAgentMessage({
        sessionId,
        messageIdsBefore,
        getSession,
        timeoutMs: sessionRefreshTimeoutMs,
        abortSignal
      })
    } catch (error) {
      log.warn('fix loop: failed while refreshing durable correction turn', {
        sessionId,
        round,
        error: error instanceof Error ? error.message : String(error)
      })
      await markOpenChecksUnaddressed(
        'correction_failed',
        'Could not reload the durable correction turn.'
      )
      return
    }
    if (correctionWait.status === 'aborted' || abortSignal?.aborted) {
      log.info('fix loop: aborted while waiting for durable correction turn', {
        sessionId,
        round
      })
      await markOpenChecksUnaddressed('aborted', 'The fix loop was aborted by the user.')
      return
    }
    if (correctionWait.status !== 'found') {
      log.warn('correction turn did not reach durable session storage; refusing stale re-review', {
        sessionId,
        round,
        timeoutMs: sessionRefreshTimeoutMs,
        reason: correctionWait.status,
        ...waitDiagnostics(correctionWait)
      })
      await markOpenChecksUnaddressed(
        'correction_failed',
        'The correction turn did not reach durable storage.'
      )
      return
    }

    const correctionState = correctionWait

    const correctionTurnMessageId = correctionState.message.id

    // Step D: run a re-review scoped to the correction turn's new blocks.
    // This creates a new Review row sharing the original turnMessageId.
    log.info('fix loop: running re-review', { sessionId, round, correctionTurnMessageId })

    const scopedResult = await runScopedReview({
      sessionId,
      turnMessageId: correctionTurnMessageId,
      originalTurnMessageId,
      projectId,
      getSession,
      reviewRepository,
      runSessionMutation,
      acpRuntime,
      artifactStorageRoot,
      artifactVersionContentResolver,
      reviewerMcpEntryPath,
      model,
      onReviewUpdate,
      reviewerTimeoutMs,
      reviewerMaxUpdates,
      reviewerMaxToolCalls,
      trackedChecks: openChecks,
      sessionSnapshot: correctionState.session,
      supervisor: options.supervisor
    })
    const reReviewResult = scopedResult.review

    // Step E: compute resolution transitions for the original review's open checks.
    // - If the re-review errored: count as a round but mark remaining unaddressed and stop.
    // - Each original finding is matched only by sourceFindingId, never by model-generated prose.
    // - A pass disposition resolves it; warn/fail increments reflagCount and keeps it open.
    // - Missing dispositions are rejected by MCP and stay open defensively if one slips through.

    if (reReviewResult.lifecycle === 'error') {
      log.warn('fix loop: re-review errored — marking remaining checks unaddressed', {
        sessionId,
        round,
        openCount: openChecks.length
      })
      await markOpenChecksUnaddressed('correction_failed', 'The scoped re-review failed.')
      return
    }

    const dispositionsByFindingId = new Map(
      scopedResult.submittedChecks.flatMap((check) =>
        check.sourceFindingId ? [[check.sourceFindingId, check] as const] : []
      )
    )

    const stillOpenChecks: ReviewCheck[] = []

    for (const openCheck of openChecks) {
      const disposition = dispositionsByFindingId.get(openCheck.id)
      if (!disposition) {
        // The MCP server rejects incomplete submissions, so this is defensive fail-closed behavior.
        log.error('fix loop: scoped re-review omitted a tracked finding disposition', {
          sessionId,
          round,
          findingId: openCheck.id
        })
        stillOpenChecks.push(openCheck)
      } else if (disposition.status === 'warn' || disposition.status === 'fail') {
        log.info('fix loop: finding re-flagged', {
          sessionId,
          round,
          findingId: openCheck.id
        })
        stillOpenChecks.push(openCheck)
      } else {
        log.info('fix loop: finding resolved', { sessionId, round, findingId: openCheck.id })
      }
    }

    const newIssueSortIndexes = new Set(
      scopedResult.submittedChecks
        .filter(
          (check) => !check.sourceFindingId && (check.status === 'warn' || check.status === 'fail')
        )
        .map((check) => check.sortIndex)
    )
    const newlyOpenChecks = reReviewResult.checks.filter(
      (check) =>
        newIssueSortIndexes.has(check.sortIndex) &&
        (check.status === 'warn' || check.status === 'fail')
    )
    if (newlyOpenChecks.length > 0) {
      log.info('fix loop: carrying newly discovered findings into the next round', {
        sessionId,
        round,
        count: newlyOpenChecks.length
      })
    }

    openChecks = [...stillOpenChecks, ...newlyOpenChecks]

    if (openChecks.length === 0) {
      log.info('fix loop: all checks resolved', { sessionId, rounds: round + 1 })
      return
    }

    log.info('fix loop: still-open checks remain', {
      sessionId,
      round,
      stillOpen: openChecks.length
    })
  }

  // Cap reached: mark remaining open warn/fail checks as unaddressed.
  if (openChecks.length > 0) {
    log.info('fix loop: cap reached — marking remaining checks unaddressed', {
      sessionId,
      maxRounds,
      remaining: openChecks.length
    })
    await markOpenChecksUnaddressed(
      'loop_terminated',
      `Fix loop reached its ${maxRounds}-round cap.`
    )
  }
}

// Runs one scoped re-review for a correction turn. Creates a new Review row under the same
// original turnMessageId so all iterations are grouped. Returns the completed review.
// Never throws — errors are captured as lifecycle='error'.
const runScopedReview = async (options: {
  sessionId: string
  turnMessageId: string // the correction turn's agent message id
  originalTurnMessageId: string // shared across all Review rows in this fix-loop closure
  projectId: string
  getSession: SessionProvider
  reviewRepository: ReviewRepository
  runSessionMutation?: ReviewMutationRunner
  acpRuntime: ReviewerAcpRuntime
  artifactStorageRoot: string
  artifactVersionContentResolver?: ArtifactVersionContentResolver
  reviewerMcpEntryPath?: string
  model: string
  onReviewUpdate?: (review: ReviewWithChecks) => void
  reviewerTimeoutMs: number
  reviewerMaxUpdates: number
  reviewerMaxToolCalls: number
  trackedChecks: ReviewCheck[]
  sessionSnapshot?: PersistedChatSession
  supervisor?: SupervisorPlan
}): Promise<{ review: ReviewWithChecks; submittedChecks: NewCheck[] }> => {
  const {
    sessionId,
    turnMessageId,
    originalTurnMessageId,
    projectId,
    getSession,
    reviewRepository,
    runSessionMutation,
    acpRuntime,
    artifactStorageRoot,
    artifactVersionContentResolver,
    reviewerMcpEntryPath,
    model,
    onReviewUpdate,
    reviewerTimeoutMs,
    reviewerMaxUpdates,
    reviewerMaxToolCalls,
    trackedChecks,
    sessionSnapshot
  } = options

  // Use the exact durable snapshot that proved the correction message exists. A second independent
  // read could regress to an older file during concurrent persistence and reintroduce stale auditing.
  const session = sessionSnapshot ?? (await getSession(sessionId))

  if (!session) {
    log.warn('session not found for scoped re-review', { sessionId })
    const errorReview = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.createReview({
        projectId,
        sessionId,
        turnMessageId: originalTurnMessageId,
        scope: { turnMessageId: originalTurnMessageId, blocks: [], artifactVersionIds: [] },
        lifecycle: 'error',
        errorMessage: `Session ${sessionId} not found during re-review`,
        model
      })
    )
    return { review: { ...errorReview, checks: [] }, submittedChecks: [] }
  }

  // Resolve the correction turn's scope, pinning each artifact to a digest of its current bytes.
  const scope = await resolveTurnScopeWithArtifactDigests(
    session,
    turnMessageId,
    artifactStorageRoot,
    artifactVersionContentResolver
  )

  // Create a new Review row sharing the originalTurnMessageId (not the correction turn's id),
  // so all iterations are grouped under the same original turn.
  const scopeSnapshot = buildReviewScopeSnapshot(session, scope)
  let review = await runReviewMutation(runSessionMutation, () =>
    reviewRepository.createReview({
      projectId,
      sessionId,
      turnMessageId: originalTurnMessageId,
      scope,
      lifecycle: 'running',
      model,
      scopeSnapshot
    })
  )

  const initialWithChecks: ReviewWithChecks = { ...review, checks: [] }
  onReviewUpdate?.(initialWithChecks)

  log.info('scoped re-review created', { reviewId: review.id, blocks: scope.blocks.length })

  // Run the reviewer session (same flow as the initial review).
  let reviewerSession: ActiveSession | undefined
  let mcpServer: ReviewerMcpServer | undefined
  let checksReceived: NewCheck[] = []
  let checksSubmitted = false
  let rejectedToolCalls = 0
  // Same meaning as in `runReview`: the scoped re-review also gets one follow-up turn when it ends
  // with nothing submitted, and the failure message says so.
  let nudged = false
  let reviewerBridgeScoped: boolean | undefined
  let reviewerSessionFailed = false
  let reviewerSessionError: unknown
  const capturedLog: ReviewerLogEntry[] = []

  try {
    const evidence = new ReviewerHostServer(
      session,
      scope,
      artifactStorageRoot,
      artifactVersionContentResolver,
      scopeSnapshot,
      createExternalSourceFetcher()
    )

    mcpServer = new ReviewerMcpServer(
      scope,
      async (checks: NewCheck[]) => {
        checksReceived = checks
        checksSubmitted = true
      },
      evidence,
      trackedChecks.map((check) => check.id),
      { command: process.execPath, entryPath: reviewerMcpEntryPath }
    )
    await mcpServer.start()

    const reviewerPrompt = buildReviewerPrompt(scope, trackedChecks)
    logSupervisorLedger(sessionId, options.supervisor)
    const systemPromptAppend = appendSupervisorNotice(
      REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND,
      options.supervisor
    )
    const cwd = session.cwd || homedir()

    const built = await acpRuntime.buildReviewerSession({
      cwd,
      mcpServers: [mcpServer.toAcpMcpServerConfig()],
      systemPromptAppend
    })
    reviewerSession = built.session

    // opencode has no system-prompt preset, so the rubric rides back as a prompt prefix; Claude gets
    // it via _meta and returns no prefix. Prepend it so the reviewer rubric reaches either framework.
    const reviewerPromptText = built.promptPrefix
      ? `${built.promptPrefix}\n\n${reviewerPrompt}`
      : reviewerPrompt
    reviewerSession.prompt([{ type: 'text', text: reviewerPromptText }])

    const scopedDrive = await driveReviewerWithFollowUp(
      reviewerSession,
      {
        timeoutMs: reviewerTimeoutMs,
        maxUpdates: reviewerMaxUpdates,
        maxToolCalls: reviewerMaxToolCalls
      },
      { onUpdate: (entry) => capturedLog.push(entry) },
      () => checksSubmitted,
      () => {
        nudged = true
      }
    )
    log.info('scoped re-review session stopped', {
      reviewId: review.id,
      stopReason: scopedDrive.stopReason,
      nudged
    })
  } catch (error) {
    reviewerSessionFailed = true
    reviewerSessionError = error
  } finally {
    const cleanup = await cleanupReviewerResources(acpRuntime, reviewerSession, mcpServer)
    rejectedToolCalls = cleanup.rejectedToolCalls
    reviewerBridgeScoped = cleanup.reviewerBridgeScoped
    if (cleanup.runtimeCleanupFailed) {
      if (reviewerSessionFailed) {
        log.error('scoped re-review session cleanup also failed', {
          reviewId: review.id,
          error:
            cleanup.runtimeCleanupError instanceof Error
              ? cleanup.runtimeCleanupError.message
              : String(cleanup.runtimeCleanupError)
        })
      } else {
        reviewerSessionFailed = true
        reviewerSessionError = cleanup.runtimeCleanupError
      }
    }
  }

  if (reviewerSessionFailed) {
    const errorMsg =
      reviewerSessionError instanceof Error
        ? reviewerSessionError.message
        : String(reviewerSessionError)
    log.error('scoped re-review session failed', {
      reviewId: review.id,
      ...errorLogFields(reviewerSessionError)
    })

    review = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.updateReview(review.id, {
        lifecycle: 'error',
        errorMessage: errorMsg,
        reviewerLog: capturedLog
      })
    )
    const errorWithChecks: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithChecks)
    return { review: errorWithChecks, submittedChecks: [] }
  }

  if (reviewerBridgeScoped === false) {
    log.error('scoped re-review bridge isolation failed', { reviewId: review.id })
    review = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.updateReview(review.id, {
        lifecycle: 'error',
        errorMessage: REVIEWER_BRIDGE_SCOPE_ERROR,
        reviewerLog: capturedLog
      })
    )
    const errorWithChecks: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithChecks)
    return { review: errorWithChecks, submittedChecks: [] }
  }

  if (!checksSubmitted) {
    const errorMessage = incompleteReviewMessage(rejectedToolCalls, nudged)
    log.error('scoped re-review protocol incomplete', {
      reviewId: review.id,
      error: errorMessage,
      nudged
    })
    review = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.updateReview(review.id, {
        lifecycle: 'error',
        errorMessage,
        reviewerLog: capturedLog
      })
    )
    const errorWithChecks: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithChecks)
    return { review: errorWithChecks, submittedChecks: [] }
  }

  // Persist new Findings, tracked dispositions, and Review completion in one transaction.
  let finalReview: ReviewWithChecks
  try {
    const hasWarnOrFailCheck = checksReceived.some(
      (c) => c.status === 'warn' || c.status === 'fail'
    )
    const outcome: ReviewOutcome = hasWarnOrFailCheck ? 'flagged' : 'pass'
    finalReview = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.commitScopedSubmission({
        reviewId: review.id,
        checks: checksReceived,
        expectedSourceFindingIds: trackedChecks.map((check) => check.id),
        outcome,
        reviewerLog: capturedLog
      })
    )
    review = finalReview
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('scoped re-review persistence failed', { reviewId: review.id, error: errorMsg })
    review = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.updateReview(review.id, {
        lifecycle: 'error',
        errorMessage: errorMsg,
        reviewerLog: capturedLog
      })
    )
    const errorWithChecks: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithChecks)
    return { review: errorWithChecks, submittedChecks: [] }
  }

  // Tracked dispositions mutate their source Review cards. Push those rows only after the atomic
  // scoped submission commits, then push the completed assessment Review.
  const trackedById = new Map(trackedChecks.map((check) => [check.id, check]))
  const mutatedSourceReviewIds = new Set(
    checksReceived.flatMap((check) => {
      const source = check.sourceFindingId ? trackedById.get(check.sourceFindingId) : undefined
      return source ? [source.reviewId] : []
    })
  )
  if (mutatedSourceReviewIds.size > 0) {
    const allReviews = await reviewRepository.getReviewsForProjectSession(projectId, sessionId)
    for (const sourceReview of allReviews) {
      if (mutatedSourceReviewIds.has(sourceReview.id)) onReviewUpdate?.(sourceReview)
    }
  }

  onReviewUpdate?.(finalReview)
  return { review: finalReview, submittedChecks: checksReceived }
}

// Drives one complete auto-review cycle: scope resolution → DB record → reviewer session →
// submit_findings → lifecycle update. Returns the final review (with checks) for the caller
// to broadcast. Never throws — errors are captured as lifecycle='error'.
const runReviewWithSession = async (
  options: RunReviewOptions,
  session: PersistedChatSession
): Promise<ReviewWithChecks> => {
  const {
    sessionId,
    turnMessageId,
    scopeTurnMessageId,
    projectId,
    getSession,
    reviewRepository,
    runSessionMutation,
    acpRuntime,
    artifactStorageRoot,
    artifactVersionContentResolver,
    reviewerMcpEntryPath,
    model = '',
    onReviewUpdate,
    onStarted,
    mainSessionId,
    onCorrectionPrompt,
    onCorrectionFailed,
    reviewerTimeoutMs = DEFAULT_REVIEWER_TIMEOUT_MS,
    reviewerMaxUpdates = DEFAULT_REVIEWER_MAX_UPDATES,
    reviewerMaxToolCalls = DEFAULT_REVIEWER_MAX_TOOL_CALLS,
    fixLoopMaxRounds = 3,
    onFixLoopStart,
    onFixLoopEnd,
    fixLoopAbortSignal,
    sessionRefreshTimeoutMs = DEFAULT_SESSION_REFRESH_TIMEOUT_MS
  } = options

  // Audit the scope turn (defaults to the grouping turn) but keep the row grouped under turnMessageId.
  const scope = await resolveTurnScopeWithArtifactDigests(
    session,
    scopeTurnMessageId ?? turnMessageId,
    artifactStorageRoot,
    artifactVersionContentResolver
  )

  // Step 2: create the Review row (lifecycle='running') immediately so the renderer shows a spinner.
  const scopeSnapshot = buildReviewScopeSnapshot(session, scope)
  let review = await runReviewMutation(runSessionMutation, () =>
    reviewRepository.createReview({
      projectId,
      sessionId,
      turnMessageId,
      scope,
      lifecycle: 'running',
      model,
      scopeSnapshot
    })
  )

  const initialWithFindings: ReviewWithChecks = { ...review, checks: [] }
  onReviewUpdate?.(initialWithFindings)
  // The running row now exists and has been pushed to the renderer — this is the point a caller can
  // treat the review as genuinely "started". Anything that failed before here (scope resolution, the
  // createReview insert) threw instead, so `started` is never reported for a run that never appeared.
  onStarted?.()

  log.info('review created', { reviewId: review.id, blocks: scope.blocks.length })

  // Step 3: run the reviewer session. All failures inside are caught and set lifecycle='error'.
  let reviewerSession: ActiveSession | undefined
  let mcpServer: ReviewerMcpServer | undefined
  let checksReceived: NewCheck[] = []
  let checksSubmitted = false
  let rejectedToolCalls = 0
  // Set when the reviewer ended its own turn with nothing submitted and got one follow-up turn. The
  // failure message reports it, so a review that was asked twice never reads like one silent turn.
  let nudged = false
  let reviewerBridgeScoped: boolean | undefined
  let reviewerSessionFailed = false
  let reviewerSessionError: unknown
  const capturedLog: ReviewerLogEntry[] = []

  try {
    // Evidence reads and submission share one authenticated MCP server. The evidence object enforces
    // turn/artifact scope server-side; no host token or Bash bootstrap is exposed to the model.
    const evidence = new ReviewerHostServer(
      session,
      scope,
      artifactStorageRoot,
      artifactVersionContentResolver,
      scopeSnapshot,
      createExternalSourceFetcher()
    )

    mcpServer = new ReviewerMcpServer(
      scope,
      async (checks: NewCheck[]) => {
        checksReceived = checks
        checksSubmitted = true
        log.info('submit_findings received by MCP handler', { count: checks.length })
      },
      evidence,
      [],
      { command: process.execPath, entryPath: reviewerMcpEntryPath }
    )
    await mcpServer.start()

    const reviewerPrompt = buildReviewerPrompt(scope)

    // Audit trail for the FIRST review of a turn, which is the common case. The same call exists on the
    // scoped re-review path; without this one the ledger reached the reviewer's instructions but left no
    // trace anywhere, so a run's supervision could not be checked after the fact - and an acceptance probe
    // waiting for a line like this waits forever (measured: zero lines across 12 started reviews).
    logSupervisorLedger(sessionId, options.supervisor)

    const systemPromptAppend = appendSupervisorNotice(
      REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND,
      options.supervisor
    )

    // Spawn the reviewer ACP session (clean context, reviewer-only tools).
    const cwd = session.cwd || homedir()

    const built = await acpRuntime.buildReviewerSession({
      cwd,
      mcpServers: [mcpServer.toAcpMcpServerConfig()],
      systemPromptAppend
    })
    reviewerSession = built.session

    log.info('reviewer session started', { sessionId: reviewerSession.sessionId })

    // Send the prompt and drive the session to completion. A timeout / update cap guards against a
    // hung or fast-looping reviewer that never stops: on expiry this throws, the catch below sets
    // lifecycle='error', and the finally disposes the session + MCP server.
    // opencode gets the rubric via a prompt prefix (Claude via _meta, prefix empty).
    const reviewerPromptText = built.promptPrefix
      ? `${built.promptPrefix}\n\n${reviewerPrompt}`
      : reviewerPrompt
    reviewerSession.prompt([{ type: 'text', text: reviewerPromptText }])

    const drive = await driveReviewerWithFollowUp(
      reviewerSession,
      {
        timeoutMs: reviewerTimeoutMs,
        maxUpdates: reviewerMaxUpdates,
        maxToolCalls: reviewerMaxToolCalls
      },
      {
        onUpdate: (entry) => capturedLog.push(entry)
      },
      () => checksSubmitted,
      () => {
        nudged = true
      }
    )
    log.info('reviewer session stopped', {
      reviewId: review.id,
      stopReason: drive.stopReason,
      nudged
    })
  } catch (error) {
    reviewerSessionFailed = true
    reviewerSessionError = error
  } finally {
    const cleanup = await cleanupReviewerResources(acpRuntime, reviewerSession, mcpServer)
    rejectedToolCalls = cleanup.rejectedToolCalls
    reviewerBridgeScoped = cleanup.reviewerBridgeScoped
    if (cleanup.runtimeCleanupFailed) {
      if (reviewerSessionFailed) {
        log.error('reviewer session cleanup also failed', {
          reviewId: review.id,
          error:
            cleanup.runtimeCleanupError instanceof Error
              ? cleanup.runtimeCleanupError.message
              : String(cleanup.runtimeCleanupError)
        })
      } else {
        reviewerSessionFailed = true
        reviewerSessionError = cleanup.runtimeCleanupError
      }
    }
  }

  if (reviewerSessionFailed) {
    const errorMsg =
      reviewerSessionError instanceof Error
        ? reviewerSessionError.message
        : String(reviewerSessionError)
    log.error('reviewer session failed', {
      reviewId: review.id,
      ...errorLogFields(reviewerSessionError)
    })

    review = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.updateReview(review.id, {
        lifecycle: 'error',
        errorMessage: errorMsg,
        reviewerLog: capturedLog
      })
    )
    const errorWithFindings: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithFindings)

    return errorWithFindings
  }

  if (reviewerBridgeScoped === false) {
    log.error('reviewer bridge isolation failed', { reviewId: review.id })
    review = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.updateReview(review.id, {
        lifecycle: 'error',
        errorMessage: REVIEWER_BRIDGE_SCOPE_ERROR,
        reviewerLog: capturedLog
      })
    )
    const errorWithFindings: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithFindings)
    return errorWithFindings
  }

  if (!checksSubmitted) {
    const errorMessage = incompleteReviewMessage(rejectedToolCalls, nudged)
    log.error('review protocol incomplete', { reviewId: review.id, error: errorMessage, nudged })
    review = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.updateReview(review.id, {
        lifecycle: 'error',
        errorMessage,
        reviewerLog: capturedLog
      })
    )
    const errorWithFindings: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithFindings)
    return errorWithFindings
  }

  // Step 4: persist checks and set lifecycle='complete'.
  // outcome = flagged iff at least one check is warn or fail; otherwise pass.
  let finalReview: ReviewWithChecks
  try {
    const hasWarnOrFailCheck = checksReceived.some(
      (c) => c.status === 'warn' || c.status === 'fail'
    )
    const outcome: ReviewOutcome = hasWarnOrFailCheck ? 'flagged' : 'pass'
    finalReview = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.commitScopedSubmission({
        reviewId: review.id,
        checks: checksReceived,
        expectedSourceFindingIds: [],
        outcome,
        reviewerLog: capturedLog
      })
    )
    review = finalReview

    log.info('review complete', {
      reviewId: review.id,
      outcome,
      checkCount: checksReceived.length
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('review persistence failed', { reviewId: review.id, error: errorMsg })

    review = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.updateReview(review.id, {
        lifecycle: 'error',
        errorMessage: errorMsg
      })
    )
    const errorWithFindings: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithFindings)
    return errorWithFindings
  }

  // Step 5: Phase 3 fix loop. If there are warn/fail checks and a main session is provided,
  // drive the bounded re-review loop: inject → correction → re-review → resolution → repeat.
  const hasWarnOrFail = finalReview.checks.some((c) => c.status === 'warn' || c.status === 'fail')

  if (mainSessionId && hasWarnOrFail) {
    onFixLoopStart?.()
    try {
      await runFixLoop({
        sessionId,
        originalTurnMessageId: turnMessageId,
        supervisor: options.supervisor,
        openChecks: finalReview.checks.filter((c) => c.status === 'warn' || c.status === 'fail'),
        projectId,
        mainSessionId,
        getSession,
        reviewRepository,
        runSessionMutation,
        acpRuntime,
        artifactStorageRoot,
        artifactVersionContentResolver,
        reviewerMcpEntryPath,
        model,
        onReviewUpdate,
        onCorrectionPrompt,
        onCorrectionFailed,
        reviewerTimeoutMs,
        reviewerMaxUpdates,
        reviewerMaxToolCalls,
        maxRounds: fixLoopMaxRounds,
        sessionRefreshTimeoutMs,
        abortSignal: fixLoopAbortSignal
      })
    } finally {
      onFixLoopEnd?.()
    }

    // Reload checks after the fix loop so the returned object reflects final resolutions.
    const reloadedReviews = await reviewRepository.getReviewsForProjectSession(projectId, sessionId)
    const reloadedReview = reloadedReviews.find((r) => r.id === review.id)
    if (reloadedReview) {
      onReviewUpdate?.(reloadedReview)
      return reloadedReview
    }
  }

  onReviewUpdate?.(finalReview)
  return finalReview
}

export const runReview = async (options: RunReviewOptions): Promise<ReviewWithChecks> => {
  const {
    sessionId,
    turnMessageId,
    projectId,
    getSession,
    reviewRepository,
    runSessionMutation,
    acpRuntime,
    onReviewUpdate,
    mainSessionId,
    model = ''
  } = options

  log.info('runReview started', { sessionId, turnMessageId })

  const session = await getSession(sessionId)
  if (!session) {
    log.warn('session not found for review', { sessionId })
    const errorReview = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.createReview({
        projectId,
        sessionId,
        turnMessageId,
        scope: { turnMessageId, blocks: [], artifactVersionIds: [] },
        lifecycle: 'error',
        errorMessage: `Session ${sessionId} not found`,
        model
      })
    )
    const withFindings: ReviewWithChecks = { ...errorReview, checks: [] }
    onReviewUpdate?.(withFindings)
    return withFindings
  }

  return withReviewerRuntimeActivity(
    acpRuntime,
    {
      ...(mainSessionId
        ? {
            session: {
              sessionId: mainSessionId,
              cwd: session.cwd,
              projectName: session.projectId,
              permissionProfile: session.permissionProfile,
              previousFrameworkId: session.agentFrameworkId,
              previousBackendId: session.agentBackendId,
              historyPreamble: buildHistoryPreamble(session.messages)
            }
          }
        : {})
    },
    (scopedRuntime) => runReviewWithSession({ ...options, acpRuntime: scopedRuntime }, session)
  )
}

// Keeps the base rubric first and appends the supervisor section only when there is one, so an ordinary
// turn's instructions stay byte-identical to before.
export const appendSupervisorNotice = (base: string, supervisor?: SupervisorPlan): string => {
  const notice = buildSupervisorNotice(supervisor)
  return notice ? `${base}\n\n${notice}` : base
}

// The ledger reaches the reviewer's instructions, but an instruction leaves no trace of its own: log
// it so a run's supervision is auditable after the fact (and so an acceptance check has something to
// read). No wake-ups and no degradation is the common case and stays silent.
const logSupervisorLedger = (sessionId: string, supervisor?: SupervisorPlan): void => {
  if (!supervisor || (supervisor.wakes.length === 0 && !supervisor.degraded)) return
  log.info('reviewer: supervisor ledger attached', {
    sessionId,
    wakes: supervisor.wakes.map((wake) => `${wake.kind}@turn:${wake.atTurn}`),
    handles: supervisor.wakes.map((wake) => wake.evidenceHandle),
    degraded: supervisor.degraded?.reason
  })
}

// Builds the prompt sent to the isolated reviewer session. All evidence is available only through the
// scope-bounded reviewer MCP; no executable bootstrap, filesystem path, or bearer token enters the prompt.
export const buildReviewerPrompt = (
  scope: TurnScope,
  trackedChecks: readonly ReviewCheck[] = []
): string => {
  const blockSummary =
    scope.blocks.length === 0
      ? 'This turn has no blocks (it may be empty).'
      : `This turn has ${scope.blocks.length} block(s): ` +
        scope.blocks
          .map((b) => `[${b.blockIndex}] ${b.kind}:${b.sourceId}`)
          .slice(0, 10)
          .join(', ') +
        (scope.blocks.length > 10 ? ', ...' : '')

  const artifactSummary =
    scope.artifactVersionIds.length === 0
      ? 'No artifacts in this turn.'
      : `Artifact version ids: ${scope.artifactVersionIds.join(', ')}`

  const trackedSummary =
    trackedChecks.length === 0
      ? []
      : [
          '',
          'This is a fix-loop re-review. Disposition every tracked finding exactly once by copying',
          '`sourceFindingId` unchanged into its check. Use pass if fixed, warn/fail if it remains:',
          JSON.stringify(
            trackedChecks.map((check) => ({
              sourceFindingId: check.id,
              previousStatus: check.status,
              claim: check.claim,
              evidence: check.evidence
            }))
          ),
          'You may report a newly discovered issue without sourceFindingId, but omission of any tracked',
          'finding or reuse of an unknown/duplicate id is rejected.'
        ]

  return [
    `You are reviewing turn: ${scope.turnMessageId}`,
    '',
    blockSummary,
    artifactSummary,
    ...trackedSummary,
    '',
    'Use only the reviewer MCP tools: read_turn, query_execution_log, and read_artifact.',
    'They expose only this audited scope. Do not use Bash, filesystem, network, or other tools.',
    '',
    'After reading the turn data, apply the rubric, then call submit_findings once with your findings.',
    'Call submit_findings with at least one explicit pass check if you find no issues; an empty array is invalid.'
  ].join('\n')
}
