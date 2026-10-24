// Main-process auto-review trigger, extracted so its timing is testable.
//
// Why this exists at all: `reviewer:run` was reachable only from the renderer, so a turn that finished
// without a window open was never audited — the same CLI run reviewed or did not depending on whether a
// desktop window happened to be looking at it.
//
// Why it needs a settle schedule rather than one read: the `stop`/`end_turn` runtime event is published
// BEFORE the finished session lands on disk (measured on a real CLI run, 2026-10-21: stop at 01:06:24.248,
// session file written at 01:06:26). A trigger that reads once at t+0 therefore always misses — it sees no
// session, returns silently, and the turn stays unaudited while every reading says it was clean. The
// reviewer's own retryable `not-found` reason exists for exactly this race; this schedule is the main-side
// half of it. The schedule is bounded: after the last delay the trigger reports `unreadable` and logs,
// rather than swallowing the miss.
import type { PersistedChatSession } from '../../shared/session-persistence'

// Cumulative budget is ~5.75 s, comfortably over the ~1.8 s measured on a real run while still bounded.
export const AUTO_REVIEW_SETTLE_DELAYS_MS = [150, 350, 750, 1500, 3000] as const

export type AutoReviewRequest = {
  sessionId: string
  projectId: string
  turnMessageId: string
  mainSessionId: string
}

export type AutoReviewTriggerDeps = {
  // ONE session, read by id.
  //
  // This was a full hydration pass (`loadAll`) until 2.17.3: the trigger looked for its finished turn by
  // re-scanning and re-migrating every session in the corpus, up to six times per finished turn. Measured
  // on the real machine (2026-10-24 log): 81 such passes, 2,336.8 s of session-queue occupancy, and every
  // save that waited more than a second was waiting behind one of them. The trigger never needed the
  // corpus — it needs the one document whose turn just ended.
  readSession: (sessionId: string) => Promise<PersistedChatSession | undefined>
  runReview: (request: AutoReviewRequest) => Promise<unknown>
  // Overridable so tests do not spend real seconds waiting.
  delaysMs?: readonly number[]
  // Named reporting for the case that used to be silent.
  warn?: (message: string, data?: Record<string, unknown>) => void
}

// `reviewed` — a review was started; `disabled` — the session switched auto-review off; `unreadable` —
// the finished turn never became readable inside the budget (reported, never silent).
export type AutoReviewTriggerOutcome = 'reviewed' | 'disabled' | 'unreadable'

const latestCompletedAgentMessage = (session: PersistedChatSession): { id: string } | undefined =>
  [...(session.conversationGraph?.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'agent' && message.status === 'complete')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const createAutoReviewTrigger =
  (deps: AutoReviewTriggerDeps) =>
  async (sessionId: string): Promise<AutoReviewTriggerOutcome> => {
    const delays = deps.delaysMs ?? AUTO_REVIEW_SETTLE_DELAYS_MS
    for (let attempt = 0; ; attempt += 1) {
      const session = await deps.readSession(sessionId)
      // Absent means enabled, mirroring the per-session switch the window renders — but only once the
      // session itself is readable. A missing session is the persistence race, not "disabled".
      if (session?.autoReviewEnabled === false) return 'disabled'
      const turnMessage = session ? latestCompletedAgentMessage(session) : undefined
      if (session && turnMessage) {
        await deps.runReview({
          sessionId,
          projectId: session.projectId,
          turnMessageId: turnMessage.id,
          mainSessionId: sessionId
        })
        return 'reviewed'
      }
      const delay = delays[attempt]
      if (delay === undefined) {
        deps.warn?.('auto-review skipped: the finished turn never became readable', {
          sessionId,
          attempts: attempt + 1
        })
        return 'unreadable'
      }
      await sleep(delay)
    }
  }
