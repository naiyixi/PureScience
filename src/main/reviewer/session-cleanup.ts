// Reviewer teardown, in one place so the order it depends on is a contract, not a coincidence.
//
// A review creates two paired resources: an ephemeral ACP session on the (shared, long-lived)
// provider process, and an MCP server handed to that session. They must be dismantled in the order
// `session → agent → MCP server`, because the provider keeps a per-session MCP client alive until the
// agent agrees the session is over. Stopping the server first leaves that client retrying a dead
// port: 130 `egress target failed` ECONNREFUSED lines in five days of field logs, each destination
// port matching a `reviewer MCP server stopped` line 1–3 s earlier.
//
// Extracted from the orchestrator so this ordering has a unit test of its own rather than being an
// untested call sequence buried in two 60-line `finally` blocks.

import type { ActiveSession } from '@agentclientprotocol/sdk'

import { createLogger } from '../logger'
import type { ReviewerAcpRuntime } from './acp-runtime'
import type { ReviewerMcpServer } from './mcp-server'

const log = createLogger('reviewer:orchestrator')

export type ReviewerCleanupResult = {
  rejectedToolCalls: number
  reviewerBridgeScoped: boolean | undefined
  runtimeCleanupFailed: boolean
  runtimeCleanupError?: unknown
}

// Reviewer ACP disposal, the agent-side session close, and MCP shutdown are independent cleanup
// operations. A throwing ACP adapter must not strand the authenticated MCP server; callers decide
// whether the disposal error is primary or secondary to an earlier reviewer failure after every
// cleanup attempt has completed.
export const cleanupReviewerResources = async (
  acpRuntime: ReviewerAcpRuntime,
  reviewerSession: ActiveSession | undefined,
  mcpServer: ReviewerMcpServer | undefined
): Promise<ReviewerCleanupResult> => {
  let rejectedToolCalls = 0
  let reviewerBridgeScoped: boolean | undefined
  let runtimeCleanupFailed = false
  let runtimeCleanupError: unknown
  let remoteClose: ReturnType<ReviewerAcpRuntime['disposeReviewerSession']>['remoteClose']

  if (reviewerSession) {
    try {
      const disposition = acpRuntime.disposeReviewerSession(reviewerSession)
      rejectedToolCalls = disposition.rejectedToolCalls
      reviewerBridgeScoped = disposition.reviewerBridgeScoped
      remoteClose = disposition.remoteClose
    } catch (error) {
      runtimeCleanupFailed = true
      runtimeCleanupError = error
    }
  }

  // Wait for the agent to confirm the session is over BEFORE the MCP server it dials goes away. The
  // promise is bounded and never rejects (the owner logs its own named outcome), but a caller stub
  // may hand back anything, so a rejection here is contained rather than allowed to skip the stop.
  if (remoteClose) {
    try {
      await remoteClose
    } catch (error) {
      log.warn('reviewer session remote close did not settle cleanly', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  try {
    await mcpServer?.stop()
  } catch (error) {
    // MCP stop was historically best-effort. Keep that contract while reporting the failure; a
    // runtime cleanup error, when present, remains the cleanup error returned to orchestration.
    log.error('reviewer MCP server cleanup failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }

  return {
    rejectedToolCalls,
    reviewerBridgeScoped,
    runtimeCleanupFailed,
    ...(runtimeCleanupError === undefined ? {} : { runtimeCleanupError })
  }
}
