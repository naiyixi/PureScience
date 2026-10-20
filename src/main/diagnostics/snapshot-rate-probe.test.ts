import { describe, expect, it } from 'vitest'

import { createSnapshotRateProbe, type SnapshotRateReading } from './snapshot-rate-probe'

// Every timing here is driven through the injected clock: a probe measuring wall time could pass with any
// numbers at all, while the assertions below are about the arithmetic of a window, not about this machine.
const createClock = (start = 1_000): { now: () => number; advance: (ms: number) => void } => {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    }
  }
}

const collectReadings = (): {
  log: { info: (msg: string, data?: unknown) => void }
  readings: () => SnapshotRateReading[]
} => {
  const readings: SnapshotRateReading[] = []
  return {
    log: {
      info: (_message, data) => {
        readings.push(data as SnapshotRateReading)
      }
    },
    readings: () => readings
  }
}

describe('createSnapshotRateProbe', () => {
  it('reports one window with the call count split by path and the build cost', () => {
    const clock = createClock()
    const sink = collectReadings()
    const probe = createSnapshotRateProbe({ log: sink.log, windowMs: 30_000, now: clock.now })

    // Each build costs exactly what the test advances the clock by.
    const result = probe.measure('emission', () => {
      clock.advance(4)
      return 'snapshot'
    })
    expect(result).toBe('snapshot')
    probe.measure('pull', () => {
      clock.advance(2)
    })
    probe.measure('pull', () => {
      clock.advance(9)
    })
    // 15 ms into a 30 s window: nothing has closed yet.
    expect(sink.readings()).toEqual([])

    clock.advance(30_000)
    probe.measure('emission', () => {
      clock.advance(3)
    })

    // The build that pushes the window past its target closes it and is counted in it — the alternative
    // (deferring it to the next window) would let a lone call land in a window with a 30 s denominator.
    expect(sink.readings()).toEqual([
      {
        windowMs: 30_018,
        calls: 4,
        emissionCalls: 2,
        pullCalls: 2,
        totalMs: 18,
        maxMs: 9,
        meanMs: 4.5
      }
    ])
  })

  it('reports nothing for a window with no builds, and the next window starts where that one closed', () => {
    const clock = createClock()
    const sink = collectReadings()
    const probe = createSnapshotRateProbe({ log: sink.log, windowMs: 1_000, now: clock.now })

    clock.advance(5_000)
    probe.flush()
    // Silence is the reading: a line with `calls 0` would look like a measurement of idle traffic.
    expect(sink.readings()).toEqual([])

    // Both builds are measured from the flush at 6,000, not from process start.
    probe.measure('pull', () => {
      clock.advance(1)
    })
    clock.advance(500)
    probe.measure('pull', () => {
      clock.advance(1)
    })
    expect(sink.readings()).toEqual([])

    clock.advance(600)
    probe.measure('pull', () => {
      clock.advance(1)
    })
    expect(sink.readings()).toEqual([
      { windowMs: 1_103, calls: 3, emissionCalls: 0, pullCalls: 3, totalMs: 3, maxMs: 1, meanMs: 1 }
    ])
  })

  it('does not double-book a build that measures itself again', () => {
    const clock = createClock()
    const sink = collectReadings()
    const probe = createSnapshotRateProbe({ log: sink.log, windowMs: 1_000, now: clock.now })

    const outer = probe.measure('emission', () => {
      clock.advance(7)
      const inner = probe.measure('pull', () => {
        clock.advance(50)
        return 'inner'
      })
      expect(inner).toBe('inner')
      return 'outer'
    })
    expect(outer).toBe('outer')

    clock.advance(1_000)
    probe.measure('pull', () => {
      clock.advance(1)
    })
    // The nested call ran but is not a second build: the window holds two calls, and the outer one is billed
    // its real 57 ms (the nested work happened inside it) — never 57 + 50.
    expect(sink.readings()).toEqual([
      {
        windowMs: 1_058,
        calls: 2,
        emissionCalls: 1,
        pullCalls: 1,
        totalMs: 58,
        maxMs: 57,
        meanMs: 29
      }
    ])
  })

  it('still bills a build that throws, and lets the error through', () => {
    const clock = createClock()
    const sink = collectReadings()
    const probe = createSnapshotRateProbe({ log: sink.log, windowMs: 1_000, now: clock.now })

    expect(() =>
      probe.measure('emission', () => {
        clock.advance(12)
        throw new Error('snapshot build failed')
      })
    ).toThrow('snapshot build failed')

    clock.advance(1_000)
    probe.measure('pull', () => {
      clock.advance(1)
    })
    // A build that failed is still a build that cost time; dropping it would hide expensive failures.
    expect(sink.readings()).toEqual([
      {
        windowMs: 1_013,
        calls: 2,
        emissionCalls: 1,
        pullCalls: 1,
        totalMs: 13,
        maxMs: 12,
        meanMs: 6.5
      }
    ])
  })

  it('survives a logger that throws', () => {
    const clock = createClock()
    const probe = createSnapshotRateProbe({
      log: {
        info: () => {
          throw new Error('logger failed')
        }
      },
      windowMs: 1_000,
      now: clock.now
    })

    clock.advance(1_000)
    expect(() =>
      probe.measure('pull', () => {
        clock.advance(1)
      })
    ).not.toThrow()
  })
})
