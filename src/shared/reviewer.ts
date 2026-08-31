// Shared reviewer domain types. The reviewer audits one completed turn of the main agent and records
// structured checks. These types are the contract between the main-process repository/scope resolver
// and the renderer + IPC layer, so they live in shared with no main/renderer imports.
//
// v2 model (issue 12): the old Finding (warn/fail only) + ReviewCheck (pass/inconclusive, JSON blob
// on Review) are unified into a single ReviewCheck type stored in the Finding table. Every check —
// pass, warn, or fail — is now a first-class row. The Review row no longer carries a checks JSON
// column or a summary column; both are removed via migration.
//
// v3 model (issue 13): Review.reasoning is replaced by reviewerLog: ReviewerLogEntry[]. The reviewer
// session's actual action stream (thinking / tool calls / tool results / messages) is captured and
// stored, replacing the self-authored reasoning prose. submit_findings no longer accepts `reasoning`.

// One entry in the captured reviewer session action log.
// Streaming chunks (agent_thought_chunk, agent_message_chunk) are assembled into whole entries.
// tool entries carry the real tool name + input/output from the ACP session update stream.
// The old split tool_call / tool_result pair is collapsed into ONE unified tool entry per call:
// tool_call seeds the entry, tool_call_update(s) mutate it in place via shared object reference.
export type ReviewerLogEntry =
  | { kind: 'thought'; text: string }
  | { kind: 'message'; text: string }
  | {
      kind: 'tool'
      toolName: string
      title?: string
      rawInput?: string
      rawOutput?: string
      status?: 'ok' | 'error'
      exitCode?: number | null
    }

// A single flattened block of a turn: one persisted message or one tool activity. blockIndex is the
// block's position within the turn's ordered window; contentHash pins the block content so downstream
// out-of-scope/staleness checks can detect edits after the review ran.
export type ScopeBlock = {
  id: string
  kind: 'message' | 'activity'
  sourceId: string
  blockIndex: number
  contentHash: string
}

// The audited window: the ordered blocks of exactly one turn plus the artifact version ids it produced.
export type TurnScope = {
  turnMessageId: string
  // Present for graph-native Sessions. These anchors pin the review to one Agent Frame and its
  // active Message Branch; legacy persisted reviews omit them and remain readable.
  agentFrameId?: string
  messageBranchId?: string
  blocks: ScopeBlock[]
  artifactVersionIds: string[]
}

// Task state of the review itself (did it run/finish/fail), orthogonal to its outcome.
export type ReviewLifecycle = 'running' | 'complete' | 'error'
// Result of a completed review: no warn/fail checks = pass, at least one warn/fail = flagged.
export type ReviewOutcome = 'pass' | 'flagged'

// The only MCP server an unattended reviewer session may use. Keeping the name in shared code lets
// the orchestrator and ACP permission gate enforce the same allowlist without importing each other.
// Tool set: scope-bounded evidence reads (read_turn / query_execution_log / read_artifact), a
// bounded earlier-window record (read_turn_history), verified external-source reads (fetch_source),
// and the single submit_findings call.
export const REVIEWER_MCP_SERVER_NAME = 'purescience-reviewer'
export const REVIEWER_MCP_TOOLS = {
  readTurn: 'read_turn',
  readTurnHistory: 'read_turn_history',
  queryExecutionLog: 'query_execution_log',
  readArtifact: 'read_artifact',
  fetchSource: 'fetch_source',
  submitFindings: 'submit_findings'
} as const

// The check status: pass = verified and ok; warn = minor issue; fail = serious issue.
// No 'inconclusive' — use 'warn' with appropriate evidence when verification is uncertain.
export type CheckStatus = 'pass' | 'warn' | 'fail'

// How far a warn/fail check has been addressed (meaningful only for warn/fail checks).
export type FindingResolution = 'open' | 'resolved' | 'unaddressed'

// Whether an Artifact Version reference was verified against the immutable Review scope when the
// finding was accepted. Rows predating provenance support remain distinguishable from validated
// references instead of being silently upgraded during reads.
export type ArtifactBindingState = 'scope_validated' | 'legacy_unverified'

export type ReviewFindingDispositionTrigger =
  'review_submission' | 'loop_terminated' | 'correction_failed' | 'aborted'
export type ReviewFindingDispositionOutcome = 'still_open' | 'resolved' | 'unaddressed'

export type ReviewFindingDisposition = {
  id: string
  sourceFindingId: string
  causeReviewId?: string
  sequence: number
  trigger: ReviewFindingDispositionTrigger
  outcome: ReviewFindingDispositionOutcome
  note?: string
  assessedArtifactVersionId?: string
  createdAt: number
}

// Pins a check's claim to one block of the audited turn.
export type FindingBlockRef = {
  messageId?: string
  activityId?: string
  blockIndex: number
}

export type FindingLocator = {
  blockRef: FindingBlockRef
  contentHash: string
}

// The unified check type. All checks (pass/warn/fail) are stored as rows in the Finding table.
// - pass checks have no locator (they confirm something is correct; no specific block to flag).
// - warn/fail checks have a locator pinning the claim to a specific turn block.
// resolution is meaningful only for warn/fail checks.
// reflagCount (issue 15): number of times this claim was re-flagged in a Phase 3 fix loop; 0 in Phase 1.
export type ReviewCheck = {
  id: string
  reviewId: string
  status: CheckStatus
  claim: string
  evidence: string
  locator?: FindingLocator // required in practice for warn/fail; optional for pass
  artifactVersionId?: string
  // Optional only for in-memory compatibility with pre-provenance callers; persisted rows always
  // materialize one of the two states.
  artifactBindingState?: ArtifactBindingState
  resolution: FindingResolution
  sortIndex: number
  reflagCount: number
}

// Legacy alias kept for internal use only; external callers should use ReviewCheck.
/** @deprecated Use ReviewCheck */
export type Finding = ReviewCheck

export type Review = {
  id: string
  projectId: string
  sessionId: string
  turnMessageId: string
  scope: TurnScope
  lifecycle: ReviewLifecycle
  outcome: ReviewOutcome | null
  errorMessage?: string
  model: string
  // Captured reviewer session log: thinking, tool calls, tool results, and messages.
  // Replaces the old self-authored `reasoning` string (issue 13).
  reviewerLog: ReviewerLogEntry[]
  createdAt: number
  updatedAt: number
  // Transient (never persisted): set at load time when the turn's current scope no longer matches the
  // scope this review was run against — e.g. an artifact was edited after the review completed. The UI
  // uses it to stop presenting a stale "No issues found" as current. Computed by re-resolving the scope.
  stale?: boolean
}

// A Review with its checks eagerly loaded, as returned by getReviewsForSession.
// Note: `checks` is the unified list (replaces both old `findings` and `checks` JSON blob).
export type ReviewWithChecks = Review & { checks: ReviewCheck[] }

// The exact, sanitized blocks exposed to one reviewer run. This is copied into SQLite and an
// immutable sidecar so a later transcript edit or session deletion cannot rewrite audit evidence.
export type ReviewScopeSnapshotBlock = {
  blockIndex: number
  id: string
  kind: 'message' | 'activity'
  sourceId: string
  contentHash: string
  payload: Record<string, unknown>
}

export type ReviewScopeSnapshotAvailability =
  | { state: 'available'; blocks: ReviewScopeSnapshotBlock[] }
  | { state: 'unavailable'; reason: 'legacy' | 'pending' | 'corrupt' }

export type ReviewWithProvenanceEvidence = ReviewWithChecks & {
  scopeSnapshot: ReviewScopeSnapshotAvailability
}

export type ArtifactReviewHistoryEvent =
  | {
      kind: 'review'
      review: ReviewWithProvenanceEvidence
      directlyAssessesSelectedVersion: boolean
    }
  | { kind: 'disposition'; disposition: ReviewFindingDisposition }

export type ArtifactVersionReviewProjection = {
  binding: 'version' | 'legacy-turn'
  selectedVersionId: string
  currentDirectAssessment?: ReviewWithProvenanceEvidence
  latestChainReview: ReviewWithProvenanceEvidence
  selectedVersionChecks: ReviewCheck[]
  turnLevelChecks: ReviewCheck[]
  selectedVersionDispositions: ReviewFindingDisposition[]
  history: ArtifactReviewHistoryEvent[]
}

/**
 * @deprecated Use ReviewWithChecks
 */
export type ReviewWithFindings = ReviewWithChecks & { findings: ReviewCheck[] }

// Input to createReview. Only identity + scope are required; lifecycle defaults to 'running'.
export type CreateReviewInput = {
  projectId: string
  sessionId: string
  turnMessageId: string
  scope: TurnScope
  model?: string
  lifecycle?: ReviewLifecycle
  outcome?: ReviewOutcome | null
  reviewerLog?: ReviewerLogEntry[]
  errorMessage?: string
  scopeSnapshot?: ReviewScopeSnapshotBlock[]
}

// Patch applied by updateReview; every field is optional so callers touch only what changed.
export type UpdateReviewPatch = {
  scope?: TurnScope
  lifecycle?: ReviewLifecycle
  outcome?: ReviewOutcome | null
  errorMessage?: string | null
  model?: string
  reviewerLog?: ReviewerLogEntry[]
}

// A check to persist under a review; id/reviewId are assigned by the repository.
export type NewCheck = {
  status: CheckStatus
  claim: string
  evidence: string
  // Stable identity of an original warn/fail finding being re-evaluated in the fix loop. Re-review
  // submissions must disposition every tracked finding exactly once; prose is never used as identity.
  sourceFindingId?: string
  locator?: FindingLocator // optional — pass checks may omit it
  artifactVersionId?: string
  resolution?: FindingResolution
  sortIndex?: number
}

/**
 * @deprecated Use NewCheck
 */
export type NewFinding = NewCheck

// IPC: triggers a review run from the renderer (finishRun hook) or manually.
export type ReviewRunRequest = {
  sessionId: string
  turnMessageId: string
  projectId: string
  // Main session to inject the [Auditor] correction message into (if warn/fail checks exist).
  // In production auto-review this is the same as sessionId. Omitting it skips correction injection.
  mainSessionId?: string
  // Provider/model tag recorded on the Review row (e.g. 'claude-opus-4-5'). Falls back to ''.
  model?: string
  // Turn whose content is actually audited, when it differs from turnMessageId (the grouping id).
  // Defaults to turnMessageId. Used when re-running a fix-loop review: the review row is grouped under
  // the original turn (turnMessageId), but its scope belongs to the correction turn (scopeTurnMessageId)
  // — re-running must re-audit that correction turn, not the original.
  scopeTurnMessageId?: string
  // Who requested the run. 'auto' (post-turn auto-review) is idempotent per turn: main refuses to start
  // a second review for a turn that already has one, which is the atomic guarantee against duplicate
  // runs from concurrent entry points. 'manual' (Request review / stale/error Re-run) intentionally
  // bypasses that check so the user can force a fresh review. Defaults to 'manual' when omitted.
  origin?: ReviewRunOrigin
}

// Distinguishes an automatic post-turn review from a user-initiated one — see ReviewRunRequest.origin.
export type ReviewRunOrigin = 'auto' | 'manual'

// IPC: pushed to renderer when a review's lifecycle/outcome/checks change.
export type ReviewUpdateEvent = {
  review: ReviewWithChecks
}

export type ReviewSessionRequest = {
  projectId: string
  appSessionId: string
}

export type ReviewSuppressionEvent = ReviewSessionRequest & { clear?: boolean }

// Why a review did not start (set on ReviewRunResult when started is false). The auto-review caller
// uses this to decide whether a retry could help:
//   - 'already-in-flight': a run for this turn is already active → the turn IS being handled; retrying
//     would launch a DUPLICATE review/fix-loop once the in-flight lock releases. Never retry.
//   - 'not-found': the session wasn't on disk. A brand-new session persists via an async queue, so
//     this can be a transient race the retry catches once the write lands. Retryable.
//   - 'load-failed': the session store read threw (transient DB/FS). Retryable; creates no Review row.
//   - 'run-failed': runReview threw before the running row was pushed (scope resolution / DB insert).
//     A genuine failure, not a race — leave it to the user's manual Re-run rather than auto-retrying.
//   - 'already-reviewed': an auto-origin request for a turn that already has a review. This is main's
//     atomic per-turn idempotency verdict (checked after the in-flight key is reserved), so the turn is
//     definitively handled — never retry. Manual re-runs bypass this and never receive it.
//   - 'idempotency-check-failed': the auto per-turn idempotency lookup itself threw, so main cannot
//     confirm the turn is un-reviewed. Fail-closed — start nothing — but retryable: a retry re-runs the
//     lookup, which may succeed (and then either proceed or return already-reviewed). Never risk a
//     duplicate by proceeding on an unverified check.
export type ReviewRunNotStartedReason =
  | 'already-in-flight'
  | 'not-found'
  | 'load-failed'
  | 'run-failed'
  | 'already-reviewed'
  | 'idempotency-check-failed'

// IPC: result of reviewer:run. `started` is false when the run could not begin — no Review row is
// created in that case, so the caller (e.g. a stale-review Re-run) can release its pending state and
// leave the turn retriable. `reason` (present only when started is false) says WHY, so the auto path
// can retry a persistence-race cause without retrying an already-in-flight turn into a duplicate run.
export type ReviewRunResult = {
  started: boolean
  reason?: ReviewRunNotStartedReason
}

// Navigation intent emitted when the user clicks "Go to transcript" on a warn/fail check.
// checkId and locator are optional: omitting them opens the Session reviewer page without
// highlighting a specific check (used when navigating from a pass review).
export type GoToTranscriptIntent = {
  reviewId: string
  findingId?: string // kept for backward compat; same as checkId
  checkId?: string
  locator?: ReviewCheck['locator']
}

// A session-level verification checklist item: one stable claim (a warn/fail check) aggregated
// across all reviews of the session. The same underlying issue re-flagged across fix-loop rounds
// (or surfaced by a re-run) is ONE item whose latest status/resolution/reflagCount come from the
// newest review that touched it, while history stays visible per review. Modeled on the reference
// product's session_claims + verification_checks loop, projected onto the existing Finding rows so
// no duplicated store is needed.
export type VerificationChecklistItem = {
  // Stable identity of the claim across reviews: the ORIGINAL finding id (first review that
  // raised it). Re-reviews track back to it via sourceFindingId chains.
  rootFindingId: string
  claim: string
  // Latest verdict seen for this claim (from the newest review that assessed it).
  latestStatus: CheckStatus
  // Latest evidence text (from the newest review that assessed it).
  latestEvidence: string
  // Current user-facing resolution — derived from the newest warn/fail check on this claim.
  resolution: FindingResolution
  // Total re-flags across all reviews that touched this claim.
  reflagCount: number
  // The review + turn that first raised the claim (navigation anchor).
  firstReviewId: string
  firstTurnMessageId: string
  firstReviewedAt: number
  // The review + turn of the newest assessment.
  latestReviewId: string
  latestTurnMessageId: string
  lastReviewedAt: number
  // How many reviews have assessed this claim (incl. fix-loop re-reviews).
  assessmentCount: number
  // Optional locator of the LATEST warn/fail check, for "Go to transcript".
  latestLocator?: FindingLocator
}

// A claim on the session checklist, as returned by reviewer:get-checklist.
export type VerificationChecklist = {
  projectId: string
  sessionId: string
  items: VerificationChecklistItem[]
}

// Request to mark a checklist claim addressed (or back to open). Targets the claim's ROOT finding;
// the repository resolves the newest warn/fail check on that claim and flips its resolution.
export type VerificationChecklistMutationRequest = ReviewSessionRequest & {
  rootFindingId: string
  resolution: FindingResolution
}


// A chunk list view model for the UI fold timeline: the immutable persisted chunks of a session.
export type ContextSummaryChunkView = {
  id: string
  level: 1 | 2
  foldedAt: number
  reason: string
  boundaryLabel?: string
  foldedTokens?: number
  summaryText: string
  // Preview of the folded transcript (first N chars) for the expandable summary.
  transcriptPreview: string
}

export type ContextSummaryChunkListRequest = ReviewSessionRequest

export const REVIEWER_IPC = {
  // Renderer → main: trigger a review run.
  RUN: 'reviewer:run',
  // Main → renderer: review updated (lifecycle/outcome/checks changed).
  UPDATED: 'reviewer:updated',
  // Renderer → main: load existing reviews for a session.
  GET_FOR_SESSION: 'reviewer:get-for-session',
  // Main → renderer: suppress the next triggerAutoReview call for a session (loop guard).
  // Broadcast just before an [Auditor] correction prompt is sent so the correction turn's
  // stop event does not spawn a second review run.
  SUPPRESS_NEXT_AUTO_REVIEW: 'reviewer:suppress-next-auto-review',
  // Main → renderer: fix loop started for a session (lock composer send button).
  FIX_LOOP_START: 'reviewer:fix-loop-start',
  // Main → renderer: fix loop ended or aborted for a session (unlock composer send button).
  FIX_LOOP_END: 'reviewer:fix-loop-end',
  // Renderer → main: abort the running fix loop for a session.
  ABORT_FIX_LOOP: 'reviewer:abort-fix-loop',
  // Renderer → main: load the session's aggregated verification checklist.
  GET_CHECKLIST: 'reviewer:get-checklist',
  // Renderer → main: mark a checklist claim addressed (or back to open).
  MUTATE_CHECKLIST: 'reviewer:mutate-checklist',
  // Renderer → main: load the session's folded-context chunks (fold timeline).
  GET_CHUNKS: 'reviewer:get-chunks'
} as const
