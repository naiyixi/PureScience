import type { AcpStateSnapshot, AcpRuntimeEvent, AcpRuntimeEventKind } from '../../shared/acp'
import { isAlwaysAdmittedKind } from '../event-admission'

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
//
// Why the replay is filtered by kind (measured on a real build, not assumed):
//
// Six streamed turns showed this channel carrying 399KB over 18 sends — 22KB per send, 52.8 events per send,
// 429B per event — and 909 of those events (370KB, 93% of the payload) were `message` chunks. The same
// chunks had already crossed on the event channel for 13KB per turn. `message` is in the admission gate's
// ALWAYS_ADMIT set, so a chunk is withheld only if the webContents itself is gone; replaying one is
// therefore pure redundancy, and the renderer dedupes by id so it discarded the payload anyway.
//
// The filter applies to everything the snapshot hands over, with one exception: the newest event is kept even
// when it is a chunk (the empty-live-set guard below). It used to apply to the replay portion only — events
// newer than the anchor went out whole "so the live set could reconcile everything this channel had not
// carried". Measurement said otherwise: after the replay trim this channel still carried 11.3 events / ~5KB
// per send, and `message` was 36KB of the 52KB total (69%) — the same chunks the event channel had just
// delivered, sent a second time because they were newer than the anchor. For a kind that is both
// always-admitted (the gate cannot withhold it) and token-rate, "newer than the anchor" does not mean
// un-carried: this window is subscribed to the event channel, so the chunk arrived there first and the
// duplicate buys nothing. Kinds the gate CAN withhold stay in at any age — they are the reconciliation duty
// the snapshot exists for — and a window that mounts or reloads bootstraps from acp.getState, which is
// untouched. The one behaviour that changes is bounded and already true of the replay trim: a lane that
// failed to apply an event can only retry while the event is still listed.

const BROADCAST_EVENT_OVERLAP = 60

// Kinds that (a) the admission gate always admits — checked against the gate itself in the test file, so this
// list cannot drift from it — and (b) arrive at token rate, so replaying them dominates the payload while
// adding nothing. A kind belongs here only while both hold.
export const REPLAY_REDUNDANT_KINDS: ReadonlySet<AcpRuntimeEventKind> =
  new Set<AcpRuntimeEventKind>(['message'])

export type StateSnapshotEventsTrimmer = (snapshot: AcpStateSnapshot) => AcpStateSnapshot

const isReplayRedundant = (event: AcpRuntimeEvent): boolean =>
  REPLAY_REDUNDANT_KINDS.has(event.kind) && isAlwaysAdmittedKind(event.kind)

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

    const replayed = events.slice(start)
    // No anchor yet — a window may have mounted on top of an in-flight turn, so hand the tail over whole.
    // `start === 0` with an anchor is a different case: the log is simply shorter than the overlap, and every
    // replayed chunk in it is still one the event channel already delivered, so it is filtered like any other.
    if (anchor < 0) return start === 0 ? snapshot : { ...snapshot, events: replayed }

    // The redundant-kind filter covers the new segment too: see the note above — for an always-admitted,
    // token-rate kind, being newer than the anchor does not make it un-delivered.
    const trimmed = replayed.filter((event) => !isReplayRedundant(event))
    // Never hand back an empty live set: a state change that only moved something else (status, in-flight
    // flags) still reconciles against the newest event, and the renderer's bookkeeping keeps its anchor.
    if (trimmed.length === 0) return { ...snapshot, events: [replayed[replayed.length - 1]] }
    return { ...snapshot, events: trimmed }
  }
}
