// The fix loop's post-correction wait used to answer one question with a single word: `undefined`,
// which the caller reported as "the correction turn did not reach durable storage". Nine days of field
// logs hold 28 of those refusals and zero re-reviews, and none of them could be attributed: a Session
// that was never written, a Session that grew without an agent message, and a Session whose agent
// message is still `streaming` all produced the same word. These cases pin the three apart, and pin
// where the wait sits relative to the caller's message snapshot.
//
// They also pin the boundary that matters for the fix: a *new user* message does not satisfy the wait
// (the re-review needs the agent turn), and a *streaming* agent message does not either.

import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import { waitForCorrectionAgentMessage } from './orchestrator'

const agentMessage = (
  id: string,
  status: 'complete' | 'streaming' | 'error' = 'complete'
): PersistedChatSession['messages'][number] => ({
  id,
  role: 'agent',
  content: 'I applied the fix.',
  status,
  eventIds: [],
  createdAt: 3000,
  updatedAt: 3000
})

const userMessage = (id: string): PersistedChatSession['messages'][number] => ({
  id,
  role: 'user',
  content: '[Auditor] please correct',
  status: 'complete',
  eventIds: [],
  createdAt: 2500,
  updatedAt: 2500
})

const sessionWith = (messages: PersistedChatSession['messages']): PersistedChatSession =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Test session',
    cwd: '/workspace',
    status: 'idle',
    messages,
    createdAt: 1000,
    updatedAt: 3000
  }) as PersistedChatSession

const before = new Set(['msg-1', 'msg-2'])

describe('waitForCorrectionAgentMessage', () => {
  it('finds the correction turn and reports how long it took', async () => {
    const getSession = vi.fn(async () =>
      sessionWith([userMessage('msg-1'), agentMessage('msg-2'), agentMessage('msg-3')])
    )

    const result = await waitForCorrectionAgentMessage({
      sessionId: 'session-1',
      messageIdsBefore: before,
      getSession,
      timeoutMs: 1_000
    })

    expect(result.status).toBe('found')
    if (result.status !== 'found') throw new Error('unreachable')
    expect(result.message.id).toBe('msg-3')
    expect(result.polls).toBe(1)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('reports session-missing when the durable Session never loads', async () => {
    const result = await waitForCorrectionAgentMessage({
      sessionId: 'session-1',
      messageIdsBefore: before,
      getSession: async () => undefined,
      timeoutMs: 0
    })

    expect(result.status).toBe('session-missing')
    if (result.status !== 'session-missing') throw new Error('unreachable')
    expect(result.polls).toBe(1)
  })

  it('reports no-new-agent-message when only a user message landed, and names it', async () => {
    const result = await waitForCorrectionAgentMessage({
      sessionId: 'session-1',
      messageIdsBefore: before,
      getSession: async () =>
        sessionWith([userMessage('msg-1'), agentMessage('msg-2'), userMessage('msg-3')]),
      timeoutMs: 0
    })

    expect(result.status).toBe('no-new-agent-message')
    if (result.status !== 'no-new-agent-message') throw new Error('unreachable')
    expect(result.newMessages).toBe(1)
    expect(result.lastRole).toBe('user')
    expect(result.lastStatus).toBe('complete')
  })

  it('reports no-new-agent-message with zero messages when the Session did not grow at all', async () => {
    const result = await waitForCorrectionAgentMessage({
      sessionId: 'session-1',
      messageIdsBefore: before,
      getSession: async () => sessionWith([userMessage('msg-1'), agentMessage('msg-2')]),
      timeoutMs: 0
    })

    expect(result.status).toBe('no-new-agent-message')
    if (result.status !== 'no-new-agent-message') throw new Error('unreachable')
    expect(result.newMessages).toBe(0)
    expect(result.lastRole).toBeUndefined()
  })

  it('does not accept a streaming agent message, and reports the status it saw', async () => {
    const result = await waitForCorrectionAgentMessage({
      sessionId: 'session-1',
      messageIdsBefore: before,
      getSession: async () =>
        sessionWith([
          userMessage('msg-1'),
          agentMessage('msg-2'),
          agentMessage('msg-3', 'streaming')
        ]),
      timeoutMs: 0
    })

    expect(result.status).toBe('agent-message-incomplete')
    if (result.status !== 'agent-message-incomplete') throw new Error('unreachable')
    expect(result.messageId).toBe('msg-3')
    expect(result.messageStatus).toBe('streaming')
  })

  it('reports aborted without asking the provider when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const getSession = vi.fn(async () => sessionWith([]))

    const result = await waitForCorrectionAgentMessage({
      sessionId: 'session-1',
      messageIdsBefore: before,
      getSession,
      timeoutMs: 1_000,
      abortSignal: controller.signal
    })

    expect(result.status).toBe('aborted')
    expect(getSession).not.toHaveBeenCalled()
  })
})
