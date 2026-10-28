import { describe, expect, it } from 'vitest'

import type { EventLoopStallRecord } from './event-loop-stall-watchdog'
import { createStallRecordRing } from './stall-record-ring'

// A record shaped like the watchdog's own: the ring is only interesting if what it keeps is the real record,
// not a projection of it (a projection would be a second vocabulary for the same evidence).
const stall = (windowMs: number): EventLoopStallRecord => ({
  windowMs,
  lateMs: windowMs - 500,
  cpuMs: Math.round(windowMs * 0.9),
  cpuShare: 0.9,
  attribution: 'cpu-bound-in-process',
  cause: {
    kind: 'cpu-in-process',
    basis: 'cpu-bound in this process, gc 0 ms in 0 pause(s), fs canary 1 ms with 0 in flight',
    gc: { status: 'measured', pauseMs: 0, pauses: 0 },
    fs: { status: 'measured', canaryMs: 1, inFlight: 0 }
  },
  stack: {
    status: 'profiled',
    mainThreadMs: Math.round(windowMs * 0.9),
    unobservedMs: 0,
    samples: 18,
    frames: [{ frame: 'busy (src/main/busy.ts:1)', samples: 18 }]
  },
  host: {
    status: 'sampled',
    intervalMs: 250,
    stallMs: windowMs,
    samples: 4,
    expectedSamples: 4,
    continuity: 'kept-sampling'
  },
  freeMemMb: 120,
  loadAvg1m: 2.5
})

const clockFrom = (startMs: number): { now: () => Date; tick: (ms: number) => void } => {
  let current = startMs
  return {
    now: () => new Date(current),
    tick: (ms: number) => {
      current += ms
    }
  }
}

describe('stall record ring', () => {
  it('keeps the newest records and counts the ones it had to drop', () => {
    const clock = clockFrom(Date.parse('2026-10-25T08:00:00.000Z'))
    const ring = createStallRecordRing({ capacity: 2, now: clock.now })

    ring.record(stall(1_000))
    clock.tick(1_000)
    ring.record(stall(2_000))
    clock.tick(1_000)
    ring.record(stall(3_000))

    const summary = ring.summary()
    expect(summary.capacity).toBe(2)
    expect(summary.observed).toBe(3)
    expect(summary.dropped).toBe(1)
    // The tail, not the head: the oldest kept record is the second one recorded.
    expect(summary.records.map((record) => record.windowMs)).toEqual([2_000, 3_000])
    expect(summary.oldestAt).toBe('2026-10-25T08:00:01.000Z')
    expect(summary.newestAt).toBe('2026-10-25T08:00:02.000Z')
    expect(summary.status).toBe('records')
  })

  it('keeps the record itself, not a summary of it', () => {
    const ring = createStallRecordRing({ now: () => new Date('2026-10-25T08:00:00.000Z') })
    ring.record(stall(7_400))

    const [record] = ring.summary().records
    expect(record.windowMs).toBe(7_400)
    expect(record.attribution).toBe('cpu-bound-in-process')
    // The stack and the host timeline are the two halves the evidence is about; a ring that dropped either
    // would leave the bundle saying a stall happened without saying what was seen inside it.
    expect(record.stack).toEqual({
      status: 'profiled',
      mainThreadMs: 6_660,
      unobservedMs: 0,
      samples: 18,
      frames: [{ frame: 'busy (src/main/busy.ts:1)', samples: 18 }]
    })
    expect(record.host).toMatchObject({ status: 'sampled', continuity: 'kept-sampling' })
    expect(record.freeMemMb).toBe(120)
  })

  it('names the empty case instead of leaving the reader to infer it', () => {
    const ring = createStallRecordRing()

    const summary = ring.summary()
    // An idle process and a process nobody watched both produce an empty list; the bundle must not let that
    // read as "the machine was fine".
    expect(summary.status).toBe('no-stalls-observed')
    expect(summary.observed).toBe(0)
    expect(summary.dropped).toBe(0)
    expect(summary.records).toEqual([])
    // Absent rather than empty strings: there is no window to describe.
    expect(summary.oldestAt).toBeUndefined()
    expect(summary.newestAt).toBeUndefined()
  })

  it('never reports fewer drops than it has, and a capacity below one still keeps one', () => {
    const ring = createStallRecordRing({ capacity: 0 })
    for (let index = 0; index < 3; index += 1) ring.record(stall(1_000 + index))

    const summary = ring.summary()
    expect(summary.capacity).toBe(1)
    expect(summary.records).toHaveLength(1)
    expect(summary.observed).toBe(3)
    expect(summary.dropped).toBe(2)
  })

  it('hands out a copy so a reader cannot edit what the watchdog kept', () => {
    const ring = createStallRecordRing()
    ring.record(stall(1_200))

    const first = ring.summary()
    first.records.length = 0
    expect(ring.summary().records).toHaveLength(1)
  })
})
