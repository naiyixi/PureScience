import type { AcpStateSnapshot } from '../../shared/acp'

// Trims the event log a *broadcast* snapshot carries.
//
// `AcpStateSnapshot.events` is the whole recent log (capped at `MAX_EVENTS`), and the coordinator emits a
// snapshot on every state change — so in a long session each broadcast re-shipped up to ~209KB of events the
// renderer had already applied (measured: 26–40 sends per streamed turn before the broadcast window, 2–5
// after, but each still ~209KB at steady state and growing until the cap).
//
// The renderer applies events live from the event channel and uses this array as its *live set*: it dedupes
// by event id, applies what it has not applied yet, and reclaims bookkeeping for ids the source no longer
// lists. Sending only what has not been broadcast yet — plus an overlap long enough to cover events dropped
// by the event-admission gate just before this window — therefore preserves what the renderer does with the
// array, while the pull path (`acp.getState`, the full log) stays untouched for a window that mounts or
// reloads.
//
// The overlap also bounds the one behaviour that does change: a lane that failed to apply an event retries
// only while the event is still listed, so an older failure is now given up sooner than it was with a
// 500-event window. Newest-first recency is what matters for every reader of this array (recent failures,
// gate-dropped transients, live-set bookkeeping).

const BROADCAST_EVENT_OVERLAP = 60

export type StateSnapshotEventsTrimmer = (snapshot: AcpStateSnapshot) => AcpStateSnapshot

export const createStateSnapshotEventsTrimmer = (
  overlap = BROADCAST_EVENT_OVERLAP
): StateSnapshotEventsTrimmer => {
  let lastBroadcastEventId: string | undefined

  return (snapshot) => {
    const events = snapshot.events
    if (events.length === 0) return snapshot

    const anchor =
      lastBroadcastEventId === undefined
        ? -1
        : events.findIndex((event) => event.id === lastBroadcastEventId)
    // An anchor that slid out of the bounded log means the renderer is far behind: fall back to the overlap
    // tail rather than sending nothing.
    const start =
      anchor >= 0 ? Math.max(0, anchor + 1 - overlap) : Math.max(0, events.length - overlap)

    lastBroadcastEventId = events[events.length - 1]?.id ?? lastBroadcastEventId
    if (start === 0) return snapshot
    return { ...snapshot, events: events.slice(start) }
  }
}
