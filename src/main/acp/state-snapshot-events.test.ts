import { describe, expect, it } from 'vitest'

import type { AcpRuntimeEvent, AcpStateSnapshot } from '../../shared/acp'
import { createStateSnapshotEventsTrimmer } from './state-snapshot-events'

const createEvent = (index: number, sessionId = 'session-1'): AcpRuntimeEvent =>
  ({
    id: `event-${index}`,
    sessionId,
    kind: 'message',
    timestamp: index
  }) as unknown as AcpRuntimeEvent

const createSnapshot = (count: number): AcpStateSnapshot =>
  ({
    status: 'connected',
    cwd: '/workspace',
    sessionIds: ['session-1'],
    events: Array.from({ length: count }, (_value, index) => createEvent(index)),
    pendingPermissions: [],
    permissionProfiles: {},
    permissionGrants: {},
    contextUsageBySession: {},
    promptInFlight: false,
    promptInFlightSessionIds: []
  }) as unknown as AcpStateSnapshot

const idsOf = (snapshot: AcpStateSnapshot): string[] => snapshot.events.map((event) => event.id)

describe('state snapshot events trimmer', () => {
  it('sends only the events after the previous broadcast, plus the overlap', () => {
    const trim = createStateSnapshotEventsTrimmer(5)

    // First broadcast: no anchor yet, so the overlap tail is what a freshly mounted renderer may still need.
    const first = trim(createSnapshot(20))
    expect(idsOf(first)).toEqual(['event-15', 'event-16', 'event-17', 'event-18', 'event-19'])

    // Two more events arrive: the second broadcast carries them, and reaches back by the overlap.
    const second = trim(createSnapshot(22))
    expect(idsOf(second)).toEqual([
      'event-15',
      'event-16',
      'event-17',
      'event-18',
      'event-19',
      'event-20',
      'event-21'
    ])

    // Nothing new arrived: the trimmer answers with the overlap behind the last broadcast event rather than
    // an empty live set, so a state change that only moved something else (status, in-flight flags) still
    // hands the renderer a usable set.
    const third = trim(createSnapshot(22))
    expect(idsOf(third)).toEqual(['event-17', 'event-18', 'event-19', 'event-20', 'event-21'])
  })

  it('keeps the payload flat as the log grows', () => {
    const trim = createStateSnapshotEventsTrimmer(5)
    trim(createSnapshot(500))
    const after = trim(createSnapshot(501))
    expect(after.events.length).toBeLessThan(10)
  })

  it('falls back to the overlap tail when the anchor slid out of the bounded log', () => {
    const trim = createStateSnapshotEventsTrimmer(4)
    trim(createSnapshot(10))
    // A restart-sized gap: the log now holds events 0..9 again but none of them is the anchor.
    const trimmed = trim(createSnapshot(8))
    expect(idsOf(trimmed)).toEqual(['event-4', 'event-5', 'event-6', 'event-7'])
  })

  it('passes an empty log through untouched', () => {
    const trim = createStateSnapshotEventsTrimmer(5)
    const empty = createSnapshot(0)
    expect(trim(empty)).toBe(empty)
  })

  it('leaves everything else on the snapshot alone', () => {
    const trim = createStateSnapshotEventsTrimmer(1)
    const trimmed = trim(createSnapshot(4))
    expect(trimmed.status).toBe('connected')
    expect(trimmed.sessionIds).toEqual(['session-1'])
    expect(trimmed.promptInFlight).toBe(false)
  })
})
