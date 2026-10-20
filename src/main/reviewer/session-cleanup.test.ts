import type { ActiveSession } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { ReviewerAcpRuntime } from './acp-runtime'
import type { ReviewerMcpServer } from './mcp-server'
import { cleanupReviewerResources } from './session-cleanup'

const reviewerSession = { sessionId: 'reviewer-session' } as unknown as ActiveSession

const runtimeWith = (
  disposeReviewerSession: ReviewerAcpRuntime['disposeReviewerSession']
): ReviewerAcpRuntime => ({ disposeReviewerSession }) as unknown as ReviewerAcpRuntime

const mcpServerWith = (stop: () => Promise<void>): ReviewerMcpServer =>
  ({ stop }) as unknown as ReviewerMcpServer

describe('cleanupReviewerResources teardown order', () => {
  // The field-log defect behind this contract: the provider keeps a per-session MCP client until the
  // agent confirms the session is over, so a server stopped first is dialled for another 1–3 s (130
  // ECONNREFUSED lines whose ports matched `reviewer MCP server stopped`).
  it('waits for the agent-side close before stopping the MCP server', async () => {
    const order: string[] = []
    const runtime = runtimeWith(() => {
      order.push('dispose')
      return {
        rejectedToolCalls: 0,
        reviewerBridgeScoped: undefined,
        remoteClose: (async () => {
          await Promise.resolve()
          order.push('agent-close')
          return { sessionId: 'reviewer-session', outcome: 'closed' as const, elapsedMs: 1 }
        })()
      }
    })
    const mcpServer = mcpServerWith(async () => {
      order.push('stop')
    })

    const result = await cleanupReviewerResources(runtime, reviewerSession, mcpServer)

    expect(order).toEqual(['dispose', 'agent-close', 'stop'])
    expect(result.runtimeCleanupFailed).toBe(false)
  })

  it('still stops the MCP server when the agent-side close rejects', async () => {
    const stop = vi.fn(async () => undefined)
    const runtime = runtimeWith(() => ({
      rejectedToolCalls: 0,
      reviewerBridgeScoped: undefined,
      remoteClose: Promise.reject(new Error('agent went away'))
    }))

    const result = await cleanupReviewerResources(runtime, reviewerSession, mcpServerWith(stop))

    expect(stop).toHaveBeenCalledOnce()
    // A failing agent-side close is not the disposal error: the review must not be reclassified.
    expect(result.runtimeCleanupFailed).toBe(false)
  })

  it('stops the MCP server and reports the failure when disposal throws', async () => {
    const stop = vi.fn(async () => undefined)
    const failure = new Error('dispose failed')
    const runtime = runtimeWith(() => {
      throw failure
    })

    const result = await cleanupReviewerResources(runtime, reviewerSession, mcpServerWith(stop))

    expect(stop).toHaveBeenCalledOnce()
    expect(result.runtimeCleanupFailed).toBe(true)
    expect(result.runtimeCleanupError).toBe(failure)
  })

  it('keeps a failing MCP stop out of the review outcome', async () => {
    const runtime = runtimeWith(() => ({
      rejectedToolCalls: 3,
      reviewerBridgeScoped: true,
      remoteClose: Promise.resolve({
        sessionId: 'reviewer-session',
        outcome: 'closed' as const,
        elapsedMs: 2
      })
    }))

    const result = await cleanupReviewerResources(
      runtime,
      reviewerSession,
      mcpServerWith(async () => {
        throw new Error('stop failed')
      })
    )

    expect(result).toMatchObject({
      rejectedToolCalls: 3,
      reviewerBridgeScoped: true,
      runtimeCleanupFailed: false
    })
  })

  it('cleans up when the review never got a session or a server', async () => {
    const result = await cleanupReviewerResources(runtimeWith(vi.fn()), undefined, undefined)

    expect(result).toEqual({
      rejectedToolCalls: 0,
      reviewerBridgeScoped: undefined,
      runtimeCleanupFailed: false
    })
  })
})
