// Runtime-only supervisor signals: recorded bounded per session, consumed once.
import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearSupervisorEvents,
  recordSupervisorEvent,
  resetSupervisorSignalLog,
  supervisorEventsFor
} from './supervisor-signal-log'

describe('supervisor signal log', () => {
  beforeEach(() => {
    resetSupervisorSignalLog()
  })

  it('keeps sessions apart', () => {
    recordSupervisorEvent('session-a', { type: 'compaction', detail: 'a' }, 1)
    recordSupervisorEvent('session-b', { type: 'compaction', detail: 'b' }, 1)

    expect(supervisorEventsFor('session-a')).toHaveLength(1)
    expect(supervisorEventsFor('session-a')[0]?.detail).toBe('a')
    expect(supervisorEventsFor('session-b')[0]?.detail).toBe('b')
  })

  it('is consumed once so a compaction cannot wake every later turn', () => {
    recordSupervisorEvent('session-a', { type: 'compaction' }, 3)
    expect(supervisorEventsFor('session-a')).toHaveLength(1)

    clearSupervisorEvents('session-a')
    expect(supervisorEventsFor('session-a')).toEqual([])
  })

  it('stays bounded in a long session', () => {
    for (let index = 0; index < 40; index += 1) {
      recordSupervisorEvent('session-a', { type: 'compaction', detail: `#${index}` }, index)
    }

    const events = supervisorEventsFor('session-a')
    expect(events).toHaveLength(20)
    // The recent ones survive; the oldest are dropped.
    expect(events[0]?.detail).toBe('#20')
    expect(events.at(-1)?.detail).toBe('#39')
  })

  it('returns an empty list for a session that recorded nothing', () => {
    expect(supervisorEventsFor('never-seen')).toEqual([])
  })
})
