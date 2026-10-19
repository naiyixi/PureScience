// The reviewer's cost ceiling: one review run may make a bounded number of tool calls, and when it
// reaches that ceiling it stops *honestly* — an error carrying `exceeded tool-call budget`, which the
// panel classifies as its own family — instead of running until the 15-minute wall clock (the only
// cost guard before this existed). Field basis for the default lives next to the constant in
// orchestrator.ts (n = 151 reviews: median 25 calls, p90 90, max 202).
//
// What must not regress silently:
//   * a tool_call_update for a call already counted is the same call finishing, not a second call;
//   * a tool call that arrives without an id still counts (no free pass);
//   * the ceiling fires at N, not at N-1 — an honest review at the limit still returns its stop reason.

import { describe, it, expect } from 'vitest'

import { driveReviewerToStop } from './orchestrator'

type FakeUpdate = {
  kind: string
  stopReason?: string
  update?: { sessionUpdate?: string; toolCallId?: string }
}

const toolCall = (id?: string): FakeUpdate => ({
  kind: 'session_update',
  update: { sessionUpdate: 'tool_call', ...(id ? { toolCallId: id } : {}) }
})

const toolUpdate = (id?: string): FakeUpdate => ({
  kind: 'session_update',
  update: { sessionUpdate: 'tool_call_update', ...(id ? { toolCallId: id } : {}) }
})

const scripted = (updates: FakeUpdate[]): { nextUpdate: () => Promise<FakeUpdate> } => {
  let i = 0
  return {
    nextUpdate: async (): Promise<FakeUpdate> => {
      const next = updates[i]
      i += 1
      // Past the end of the script the session simply never speaks again, so a guard that should have
      // fired shows up as a timeout instead of a hang.
      return next ?? new Promise<FakeUpdate>(() => {})
    }
  }
}

describe('driveReviewerToStop — tool-call budget', () => {
  it('stops with the budget message once the calls reach the ceiling', async () => {
    // Budget 3, the fourth call would be past it, but the guard must fire ON the third.
    const session = scripted([toolCall('a'), toolCall('b'), toolCall('c'), toolCall('d')])

    await expect(
      driveReviewerToStop(session, { timeoutMs: 5000, maxUpdates: 100, maxToolCalls: 3 })
    ).rejects.toThrow(/exceeded tool-call budget \(3\)/)
  })

  it('carries the phrase the review panel classifies on', async () => {
    // lib/reviewer-error-copy matches 'exceeded tool-call budget'. Both sides quote it; this pin is
    // what makes a rewording here show up as a red test instead of an unclassified error card.
    const session = scripted([toolCall('a'), toolCall('b')])

    await expect(
      driveReviewerToStop(session, { timeoutMs: 5000, maxUpdates: 100, maxToolCalls: 2 })
    ).rejects.toThrow(/exceeded tool-call budget/)
  })

  it('returns the stop reason for a review that stays under the ceiling', async () => {
    // Five calls with a budget of six: the reviewer is allowed to finish.
    const session = scripted([
      toolCall('a'),
      toolCall('b'),
      toolCall('c'),
      toolCall('d'),
      toolCall('e'),
      { kind: 'stop', stopReason: 'end_turn' }
    ])

    await expect(
      driveReviewerToStop(session, { timeoutMs: 5000, maxUpdates: 100, maxToolCalls: 6 })
    ).resolves.toBe('end_turn')
  })

  it('does not count a tool_call_update for a call it already counted', async () => {
    // One call that keeps reporting status must not be able to spend the budget on its own: 5 updates
    // for a single call, then a stop, with a budget of 3.
    const session = scripted([
      toolCall('call-1'),
      toolUpdate('call-1'),
      toolUpdate('call-1'),
      toolUpdate('call-1'),
      toolUpdate('call-1'),
      { kind: 'stop', stopReason: 'end_turn' }
    ])

    await expect(
      driveReviewerToStop(session, { timeoutMs: 5000, maxUpdates: 100, maxToolCalls: 3 })
    ).resolves.toBe('end_turn')
  })

  it('counts a tool call that arrives without an id', async () => {
    // ACP updates without a toolCallId cannot be de-duplicated, so each one is a real round trip and
    // must count — otherwise a reviewer that omits ids would be unmetered.
    const session = scripted([toolCall(), toolCall(), toolCall()])

    await expect(
      driveReviewerToStop(session, { timeoutMs: 5000, maxUpdates: 100, maxToolCalls: 3 })
    ).rejects.toThrow(/exceeded tool-call budget \(3\)/)
  })

  it('does not count streaming chunks toward the budget', async () => {
    const chunks: FakeUpdate[] = Array.from({ length: 40 }, () => ({
      kind: 'session_update',
      update: { sessionUpdate: 'agent_message_chunk' }
    }))
    const session = scripted([...chunks, { kind: 'stop', stopReason: 'end_turn' }])

    await expect(
      driveReviewerToStop(session, { timeoutMs: 5000, maxUpdates: 100, maxToolCalls: 2 })
    ).resolves.toBe('end_turn')
  })

  it('uses the module default when no budget is supplied', async () => {
    // The default is 300, so 250 calls are still inside it and a stop resolves. This also proves the
    // wiring: an accidental `maxToolCalls: 0`-style default would fail here.
    const calls: FakeUpdate[] = Array.from({ length: 250 }, (_, i) => toolCall(`call-${i}`))
    const session = scripted([...calls, { kind: 'stop', stopReason: 'end_turn' }])

    await expect(driveReviewerToStop(session, { timeoutMs: 5000, maxUpdates: 1000 })).resolves.toBe(
      'end_turn'
    )
  })
})
