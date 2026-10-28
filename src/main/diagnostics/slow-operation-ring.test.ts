import { describe, expect, it } from 'vitest'

import { createSlowOperationRing } from './slow-operation-ring'

// The ring is only interesting if what it keeps is the record the producers built, with the same field names:
// a projection here would be a second vocabulary for evidence the log line already publishes, and the two
// would drift the first time one side gained a field.
const clockFrom = (startMs: number): { now: () => Date; tick: (ms: number) => void } => {
  let current = startMs
  return {
    now: () => new Date(current),
    tick: (ms: number) => {
      current += ms
    }
  }
}

describe('slow-operation ring', () => {
  it('keeps what was measured, and leaves an unmeasured split named instead of zero', () => {
    const clock = clockFrom(1_790_000_000_000)
    const ring = createSlowOperationRing({ now: clock.now })

    ring.record({
      kind: 'ipc',
      name: 'sessions:save-session',
      surface: 'renderer',
      location: 'workbench',
      durationMs: 2_093,
      // A share of 0 is a reading ("the process used no CPU"), not a missing value: dropping it would let a
      // suspended process read like an unmeasured one.
      cpuMs: 0,
      cpuShare: 0,
      attribution: 'no-cpu-in-process'
    })
    clock.tick(250)
    ring.record({
      kind: 'command',
      name: 'storage:get-info',
      code: 'slow-handler',
      durationMs: 1_400,
      heldUnmeasured: 'windows-dropped'
    })

    const [first, second] = ring.summary().records
    expect(first).toEqual({
      kind: 'ipc',
      name: 'sessions:save-session',
      surface: 'renderer',
      location: 'workbench',
      durationMs: 2_093,
      cpuMs: 0,
      cpuShare: 0,
      attribution: 'no-cpu-in-process',
      at: new Date(1_790_000_000_000).toISOString()
    })
    // The state that says "the split was needed and cannot be answered" has to survive normalisation: as a
    // zero it would read as "the loop was free" in every consumer of the bundle.
    expect(second).toEqual({
      kind: 'command',
      name: 'storage:get-info',
      code: 'slow-handler',
      durationMs: 1_400,
      heldUnmeasured: 'windows-dropped',
      at: new Date(1_790_000_000_250).toISOString()
    })
    expect(second).not.toHaveProperty('heldMs')
    expect(second).not.toHaveProperty('surface')
  })

  it('keeps the newest records and says how many it dropped', () => {
    const clock = clockFrom(1_790_000_000_000)
    const ring = createSlowOperationRing({ capacity: 2, now: clock.now })

    for (const name of ['a', 'b', 'c']) {
      ring.record({ kind: 'command', name, durationMs: 100 })
      clock.tick(1_000)
    }

    const summary = ring.summary()
    expect(summary.capacity).toBe(2)
    expect(summary.observed).toBe(3)
    // "We saw three and kept two" must not read as "there were two": the two numbers are separate answers.
    expect(summary.dropped).toBe(1)
    expect(summary.status).toBe('records')
    // Oldest first, so the tail reads as a timeline.
    expect(summary.records.map((entry) => entry.name)).toEqual(['b', 'c'])
    expect(summary.oldestAt).toBe(new Date(1_790_000_001_000).toISOString())
    expect(summary.newestAt).toBe(new Date(1_790_000_002_000).toISOString())
  })

  it('names the empty state instead of shipping an empty list', () => {
    const ring = createSlowOperationRing()

    const summary = ring.summary()
    expect(summary.status).toBe('no-slow-operations-observed')
    expect(summary.observed).toBe(0)
    expect(summary.dropped).toBe(0)
    expect(summary.records).toEqual([])
    // Absent rather than empty strings: there is no oldest record to name.
    expect(summary.oldestAt).toBeUndefined()
    expect(summary.newestAt).toBeUndefined()
  })

  it('cannot be pushed past its capacity even when it is cleared and reused', () => {
    const ring = createSlowOperationRing({ capacity: 3 })
    for (let index = 0; index < 10; index += 1) {
      ring.record({ kind: 'ipc', name: `channel-${index}`, durationMs: 60 })
    }
    expect(ring.summary().records).toHaveLength(3)

    ring.clear()
    // A cleared ring starts its counters over: the records it kept are gone, so a `dropped` that kept counting
    // would describe a history the ring no longer has.
    expect(ring.summary().status).toBe('no-slow-operations-observed')
    expect(ring.summary().observed).toBe(0)

    ring.record({ kind: 'ipc', name: 'after-clear', durationMs: 75 })
    const summary = ring.summary()
    expect(summary.records.map((entry) => entry.name)).toEqual(['after-clear'])
    expect(summary.dropped).toBe(0)
  })
})
