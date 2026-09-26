import { describe, expect, it } from 'vitest'

import type { AcpRuntimeEvent } from '../../../../shared/acp'
import { mergeLiveEvents } from './runtime-event-live-set'

const createEvent = (index: number): AcpRuntimeEvent =>
  ({ id: `event-${index}`, sessionId: 'session-1', kind: 'message' }) as unknown as AcpRuntimeEvent

const ids = (events: readonly AcpRuntimeEvent[]): string[] => events.map((event) => event.id)

describe('mergeLiveEvents', () => {
  it('keeps events the incoming window no longer carries', () => {
    // The trimmer sends 60-event windows; the ledger behind the ones that dropped out has to stay alive.
    const merged = mergeLiveEvents(
      [createEvent(0), createEvent(1)],
      [createEvent(1), createEvent(2)]
    )
    expect(ids(merged)).toEqual(['event-0', 'event-1', 'event-2'])
  })

  it('does not duplicate an event that appears in both', () => {
    const merged = mergeLiveEvents([createEvent(1)], [createEvent(1)])
    expect(ids(merged)).toEqual(['event-1'])
  })

  it('keeps the incoming array untouched when nothing was seen before', () => {
    const incoming = [createEvent(0), createEvent(1)]
    expect(mergeLiveEvents([], incoming)).toEqual(incoming)
  })

  it('returns the previous set unchanged for an empty window', () => {
    const previous = [createEvent(0)]
    // An empty snapshot array (a state change with no events) must not wipe the live set — that wipe is what
    // reset lane bookkeeping and re-applied events.
    expect(mergeLiveEvents(previous, [])).toBe(previous)
  })

  it('evicts the oldest when the limit is reached', () => {
    const previous = [createEvent(0), createEvent(1), createEvent(2)]
    const merged = mergeLiveEvents(previous, [createEvent(3)], 3)
    expect(ids(merged)).toEqual(['event-1', 'event-2', 'event-3'])
  })
})
