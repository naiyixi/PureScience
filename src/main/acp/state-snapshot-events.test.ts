import { describe, expect, it } from 'vitest'

import type { AcpRuntimeEvent, AcpRuntimeEventKind, AcpStateSnapshot } from '../../shared/acp'
import { isAlwaysAdmittedKind } from '../event-admission'
import { REPLAY_REDUNDANT_KINDS, createStateSnapshotEventsTrimmer } from './state-snapshot-events'

const createEvent = (
  index: number,
  kind: AcpRuntimeEventKind = 'message',
  sessionId = 'session-1'
): AcpRuntimeEvent =>
  ({
    id: `event-${index}`,
    sessionId,
    kind,
    timestamp: index
  }) as unknown as AcpRuntimeEvent

// A realistic stream: token-rate `message` chunks (what the event channel always delivers) with a transient
// `thought` every fifth event (the class the gate may withhold, so the overlap has to keep re-sending it).
const createStream = (count: number): AcpRuntimeEvent[] =>
  Array.from({ length: count }, (_value, index) =>
    createEvent(index, index % 5 === 4 ? 'thought' : 'message')
  )

const createSnapshot = (count: number): AcpStateSnapshot =>
  ({
    status: 'connected',
    cwd: '/workspace',
    sessionIds: ['session-1'],
    events: createStream(count),
    pendingPermissions: [],
    permissionProfiles: {},
    permissionGrants: {},
    contextUsageBySession: {},
    promptInFlight: false,
    promptInFlightSessionIds: []
  }) as unknown as AcpStateSnapshot

const snapshotWith = (events: AcpRuntimeEvent[]): AcpStateSnapshot =>
  ({
    ...(createSnapshot(0) as unknown as Record<string, unknown>),
    events
  }) as unknown as AcpStateSnapshot

const idsOf = (snapshot: AcpStateSnapshot): string[] => snapshot.events.map((event) => event.id)
const kindsOf = (snapshot: AcpStateSnapshot): AcpRuntimeEventKind[] =>
  snapshot.events.map((event) => event.kind)

describe('state snapshot events trimmer', () => {
  it('hands the first broadcast the overlap tail intact', () => {
    const trim = createStateSnapshotEventsTrimmer(5)

    // No anchor yet: a window may have mounted on top of an in-flight turn, so the tail goes out whole —
    // chunk events included, rather than the filtered form.
    const first = trim(createSnapshot(20))
    expect(idsOf(first)).toEqual(['event-15', 'event-16', 'event-17', 'event-18', 'event-19'])
  })

  it('replays only what the gate could have withheld, plus everything new', () => {
    const trim = createStateSnapshotEventsTrimmer(5)
    trim(createSnapshot(20))

    // Two more events arrive. New events always go; inside the replayed window the chunks the event channel
    // already delivered are dropped, and the transient the gate might have withheld stays.
    const second = trim(createSnapshot(22))
    expect(idsOf(second)).toEqual(['event-19', 'event-20', 'event-21'])
    expect(kindsOf(second)).toEqual(['thought', 'message', 'message'])
  })

  it('never hands back an empty live set when nothing new arrived', () => {
    const trim = createStateSnapshotEventsTrimmer(5)
    trim(createSnapshot(20))

    // A state change that only moved something else (status, in-flight flags) still reconciles against the
    // newest event instead of clearing the renderer's bookkeeping.
    const third = trim(createSnapshot(20))
    expect(idsOf(third)).toEqual(['event-19'])
  })

  it('stops re-shipping chunk events once they have been broadcast', () => {
    const trim = createStateSnapshotEventsTrimmer(60)
    trim(createSnapshot(100))

    // One turn on top of a full window: events 100..139 (a chunk stream with a transient every fifth event).
    const after = trim(createSnapshot(140))
    const kinds = kindsOf(after)

    // Every chunk in the payload is newer than the anchor; the replayed part is the droppable class only.
    const newestReplayedId = idsOf(after).indexOf('event-99')
    expect(newestReplayedId).toBeGreaterThanOrEqual(0)
    expect(kinds.slice(0, newestReplayedId + 1).every((kind) => kind === 'thought')).toBe(true)
    // 12 transients reach back (44,49,…,99), then all 40 new events.
    expect(after.events.length).toBe(12 + 40)
  })

  it('keeps the payload flat as the log grows', () => {
    const trim = createStateSnapshotEventsTrimmer(5)
    trim(createSnapshot(500))
    const after = trim(createSnapshot(501))
    expect(after.events.length).toBeLessThan(20)
  })

  it('does not filter when the anchor slid out of the bounded log', () => {
    const trim = createStateSnapshotEventsTrimmer(4)
    trim(createSnapshot(10))
    // A restart-sized gap: the log now holds events 0..7 again but none of them is the anchor, so the window
    // is far behind and gets the raw overlap tail.
    const trimmed = trim(createSnapshot(8))
    expect(idsOf(trimmed)).toEqual(['event-4', 'event-5', 'event-6', 'event-7'])
  })

  it('passes an empty log through untouched', () => {
    const trim = createStateSnapshotEventsTrimmer(5)
    const empty = snapshotWith([])
    expect(trim(empty)).toBe(empty)
  })

  it('leaves everything else on the snapshot alone', () => {
    const trim = createStateSnapshotEventsTrimmer(1)
    const trimmed = trim(createSnapshot(4))
    expect(trimmed.status).toBe('connected')
    expect(trimmed.sessionIds).toEqual(['session-1'])
    expect(trimmed.promptInFlight).toBe(false)
  })

  it('only skips replaying kinds the admission gate always admits', () => {
    // The skip is only sound while every kind it applies to provably reached the renderer: a kind the gate
    // can withhold has to stay in the overlap even when it is high-volume. This fails if the lists drift.
    for (const kind of REPLAY_REDUNDANT_KINDS) {
      expect(isAlwaysAdmittedKind(kind)).toBe(true)
    }
    expect(REPLAY_REDUNDANT_KINDS.has('thought')).toBe(false)
  })
})
