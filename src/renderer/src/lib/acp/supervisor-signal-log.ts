// Per-session record of supervisor signals that exist only as runtime events.
//
// Tool failures are derivable from the session's persisted activities, but a context compaction and a
// rule warning happen as events and are gone by the time a review runs (compaction is reflected in
// transient UI state only). They are recorded here as they happen, bounded per session, and consumed
// when a review attaches them — so the same compaction cannot wake the supervisor on every later turn.

import type { SupervisorEvent } from '../../../../shared/supervisor-signals'

// A long session compacts repeatedly; only the recent ones are still relevant to the turn under review.
const MAX_RECORDED_EVENTS = 20

const recorded = new Map<string, SupervisorEvent[]>()

/**
 * Records one runtime-only signal. `position` is a free ordering coordinate (the caller passes where it
 * happened); the policy only needs the order to be stable.
 */
export const recordSupervisorEvent = (
  sessionId: string,
  event: Omit<SupervisorEvent, 'turn'>,
  position: number
): void => {
  const events = recorded.get(sessionId) ?? []
  events.push({ ...event, turn: position })
  recorded.set(sessionId, events.slice(-MAX_RECORDED_EVENTS))
}

/** The recorded signals for a session, oldest first. */
export const supervisorEventsFor = (sessionId: string): SupervisorEvent[] =>
  recorded.get(sessionId) ?? []

/** Called once the signals have been attached to a review, so they are acted on exactly once. */
export const clearSupervisorEvents = (sessionId: string): void => {
  recorded.delete(sessionId)
}

/** Test seam: drops every session's record. */
export const resetSupervisorSignalLog = (): void => {
  recorded.clear()
}
