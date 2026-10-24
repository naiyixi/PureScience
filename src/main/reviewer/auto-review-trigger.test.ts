// The main-process auto-review trigger races session persistence: the `stop`/`end_turn` event lands
// BEFORE the finished session is written (measured on a real CLI run: stop 01:06:24.248, session file
// 01:06:26). The single-read version shipped in 2.15.2 therefore found no session, returned silently,
// and left the turn unaudited — the review table recorded nothing and no log line said so. These cases
// pin the settle schedule and the three honest outcomes.

import { describe, expect, it, vi } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  AUTO_REVIEW_SETTLE_DELAYS_MS,
  createAutoReviewTrigger,
  type AutoReviewRequest
} from './auto-review-trigger'

const message = (
  id: string,
  role: 'user' | 'agent',
  status: string
): { id: string; role: 'user' | 'agent'; status: string } => ({ id, role, status })

const session = (overrides: Record<string, unknown> = {}): PersistedChatSession =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    status: 'idle',
    conversationGraph: {
      messages: [message('user-1', 'user', 'complete'), message('agent-1', 'agent', 'complete')],
      edges: []
    },
    ...overrides
  }) as unknown as PersistedChatSession

const deps = (
  reads: Array<PersistedChatSession | undefined>,
  overrides: Record<string, unknown> = {}
): {
  runReview: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  readSession: ReturnType<typeof vi.fn>
  trigger: ReturnType<typeof createAutoReviewTrigger>
} => {
  let index = 0
  const runReview = vi
    .fn<(request: AutoReviewRequest) => Promise<unknown>>()
    .mockResolvedValue({ started: true })
  const warn = vi.fn()
  // One document per attempt, `undefined` while the save that produces it has not landed yet.
  const readSession = vi.fn(async () => reads[Math.min(index++, reads.length - 1)])
  return {
    runReview,
    warn,
    readSession,
    trigger: createAutoReviewTrigger({
      readSession,
      runReview,
      warn,
      delaysMs: [0, 0, 0],
      ...overrides
    })
  }
}

describe('main-process auto-review trigger', () => {
  it('waits out the persistence race instead of dropping the turn', async () => {
    // The exact shape observed on a real run: nothing readable at t+0, session present a moment later.
    const { trigger, runReview, readSession, warn } = deps([undefined, undefined, session()])

    await expect(trigger('session-1')).resolves.toBe('reviewed')

    expect(readSession).toHaveBeenCalledTimes(3)
    expect(readSession).toHaveBeenCalledWith('session-1')
    expect(runReview).toHaveBeenCalledTimes(1)
    expect(runReview.mock.calls[0]![0]).toMatchObject({
      sessionId: 'session-1',
      projectId: 'project-1',
      turnMessageId: 'agent-1',
      mainSessionId: 'session-1'
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('reviews the latest complete agent message, not the first one', async () => {
    const sessionWithTwoTurns = session({
      conversationGraph: {
        messages: [
          message('agent-1', 'agent', 'complete'),
          message('user-2', 'user', 'complete'),
          message('agent-2', 'agent', 'complete')
        ],
        edges: []
      }
    })
    const { trigger, runReview } = deps([sessionWithTwoTurns])

    await trigger('session-1')

    expect(runReview.mock.calls[0]![0]).toMatchObject({ turnMessageId: 'agent-2' })
  })

  it('does not review when the session switched auto-review off', async () => {
    const { trigger, runReview, readSession } = deps([session({ autoReviewEnabled: false })])

    await expect(trigger('session-1')).resolves.toBe('disabled')

    expect(runReview).not.toHaveBeenCalled()
    expect(readSession).toHaveBeenCalledTimes(1)
  })

  it('reports a turn that never becomes readable instead of swallowing it', async () => {
    const { trigger, runReview, readSession, warn } = deps([
      undefined,
      undefined,
      undefined,
      undefined
    ])

    await expect(trigger('session-1')).resolves.toBe('unreadable')

    expect(runReview).not.toHaveBeenCalled()
    expect(readSession).toHaveBeenCalledTimes(4)
    expect(warn).toHaveBeenCalledWith(
      'auto-review skipped: the finished turn never became readable',
      {
        sessionId: 'session-1',
        attempts: 4
      }
    )
  })

  it('keeps waiting while the turn itself is still incomplete', async () => {
    const inFlight = session({
      conversationGraph: {
        messages: [
          message('user-1', 'user', 'complete'),
          message('agent-1', 'agent', 'in-progress')
        ],
        edges: []
      }
    })
    const { trigger, runReview } = deps([inFlight, session()])

    await expect(trigger('session-1')).resolves.toBe('reviewed')
    expect(runReview).toHaveBeenCalledTimes(1)
  })

  it('surfaces a reviewer failure rather than pretending it reviewed', async () => {
    const { trigger, runReview } = deps([session()])
    runReview.mockRejectedValueOnce(new Error('reviewer unavailable'))

    await expect(trigger('session-1')).rejects.toThrow('reviewer unavailable')
  })

  it('spends the documented settle budget', () => {
    // The measured write lag on a real CLI turn is ~1.8 s; the default schedule must cover it and stay
    // bounded (a review that never starts must not turn into an unbounded retry loop).
    const total = AUTO_REVIEW_SETTLE_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)
    expect(total).toBeGreaterThan(2000)
    expect(total).toBeLessThan(10000)
  })
})
