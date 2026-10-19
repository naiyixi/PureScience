import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  startEventLoopStallWatchdog,
  type EventLoopStallRecord,
  type StallFrame
} from './event-loop-stall-watchdog'

type Warned = { message: string; data: EventLoopStallRecord }

const collect = (): {
  log: { warn: (message: string, data: unknown) => void }
  warned: Warned[]
} => {
  const warned: Warned[] = []
  return {
    warned,
    log: {
      warn: (message, data) => {
        warned.push({ message, data: data as EventLoopStallRecord })
      }
    }
  }
}

// Fake clock plus fake CPU: the watchdog reads wall time and process CPU separately, and the whole point
// is the ratio between them, so both have to be driven.
const drive = (): {
  now: () => number
  cpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage
  advance: (ms: number, cpuMs: number) => void
} => {
  let clock = 1_000
  let cpuUs = 0
  return {
    now: (): number => clock,
    // Mirrors `process.cpuUsage(previous)`: called with the previous snapshot it returns the delta, called
    // bare it returns the running total.
    cpuUsage: (previous?: NodeJS.CpuUsage): NodeJS.CpuUsage => ({
      user: Math.max(0, cpuUs - (previous?.user ?? 0)),
      system: 0
    }),
    advance: (ms: number, cpuMs: number): void => {
      clock += ms
      cpuUs += cpuMs * 1_000
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('event loop stall watchdog', () => {
  it('says nothing while the loop keeps its schedule', () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({ freeMemMb: 120 }),
      createSampler: () => undefined
    })

    for (let index = 0; index < 5; index += 1) {
      time.advance(100, 5)
      vi.advanceTimersByTime(100)
    }
    watchdog.stop()
    expect(warned).toHaveLength(0)
  })

  it('attributes a stall that burned CPU to this process and arms the profiler', () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const created = vi.fn(() => ({ stop: async () => undefined, cancel: (): void => undefined }))
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      profileWindowMs: 10_000,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({ freeMemMb: 40, loadAvg1m: 12.5 }),
      createSampler: created
    })

    // 2 s of wall time for a 100 ms tick, 1.6 s of it on CPU.
    time.advance(2_000, 1_600)
    vi.advanceTimersByTime(100)

    expect(warned).toHaveLength(1)
    expect(warned[0]?.message).toBe('event loop stalled')
    expect(warned[0]?.data.windowMs).toBe(2_000)
    expect(warned[0]?.data.cpuMs).toBe(1_600)
    expect(warned[0]?.data.cpuShare).toBe(0.8)
    expect(warned[0]?.data.attribution).toBe('cpu-bound-in-process')
    expect(warned[0]?.data.stack).toEqual({ status: 'no-second-stall' })
    expect(warned[0]?.data.freeMemMb).toBe(40)
    expect(warned[0]?.data.loadAvg1m).toBe(12.5)
    // The first stall has nothing to sample; it arms the window instead.
    expect(created).toHaveBeenCalledTimes(1)
    watchdog.stop()
  })

  it('names the blocking frame from the profile when a second stall lands inside the window', async () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const frames: StallFrame[] = [
      { frame: 'saveSession (src/main/session-persistence/coordinator.ts:412)', samples: 46 }
    ]
    const stop = vi.fn(async () => ({ mainThreadMs: 4_900, frames }))
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      profileWindowMs: 10_000,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({}),
      createSampler: () => ({ stop, cancel: () => undefined })
    })

    time.advance(2_000, 1_600)
    vi.advanceTimersByTime(100)
    time.advance(5_000, 600)
    vi.advanceTimersByTime(100)
    // Let the (fake) Profiler.stop promise settle.
    await Promise.resolve()
    await Promise.resolve()

    expect(warned).toHaveLength(2)
    expect(stop).toHaveBeenCalledWith(5_000)
    const second = warned[1]?.data
    expect(second?.windowMs).toBe(5_000)
    // cpuShare over the whole process is 0.12, but the main thread ran 4.9 of those 5 s: the profiled
    // main-thread reading is the stricter verdict and wins.
    expect(second?.cpuShare).toBe(0.12)
    expect(second?.attribution).toBe('cpu-bound-in-process')
    expect(second?.stack).toEqual({ status: 'profiled', mainThreadMs: 4_900, frames })
    watchdog.stop()
  })

  it('attributes a stall that burned almost no CPU to the process not being scheduled', () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({ freeMemMb: 12 }),
      createSampler: () => undefined
    })

    time.advance(5_000, 40)
    vi.advanceTimersByTime(100)

    expect(warned).toHaveLength(1)
    expect(warned[0]?.data.cpuShare).toBe(0.008)
    expect(warned[0]?.data.attribution).toBe('process-not-scheduled')
    watchdog.stop()
  })

  it('keeps the middle band unresolved instead of forcing a verdict', () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({}),
      createSampler: () => undefined
    })

    time.advance(5_000, 2_000)
    vi.advanceTimersByTime(100)

    expect(warned[0]?.data.cpuShare).toBe(0.4)
    expect(warned[0]?.data.attribution).toBe('inconclusive')
    watchdog.stop()
  })

  it('records an unavailable sampler instead of a stall with no stack as if nothing was wrong', () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({}),
      createSampler: () => undefined
    })

    time.advance(2_000, 1_600)
    vi.advanceTimersByTime(100)
    time.advance(2_000, 1_600)
    vi.advanceTimersByTime(100)

    expect(warned).toHaveLength(2)
    expect(warned[0]?.data.stack).toEqual({ status: 'unavailable' })
    expect(warned[1]?.data.stack).toEqual({ status: 'unavailable' })
    watchdog.stop()
  })

  it('stops reporting after stop()', () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({}),
      createSampler: () => undefined
    })

    watchdog.stop()
    time.advance(2_000, 1_600)
    vi.advanceTimersByTime(100)
    expect(warned).toHaveLength(0)
  })
})

// The unit cases above drive injected time; this one runs the real interval, the real `process.cpuUsage`
// and the real V8 sampler, because the sampler is the part that can silently return nothing.
describe('event loop stall watchdog (real clock and sampler)', () => {
  const blockLoop = (ms: number): void => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      // Busy-wait: the point is to hold the loop.
    }
  }

  it('names a function from a real profile of a real block', async () => {
    const { log, warned } = collect()
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 50,
      thresholdMs: 200,
      profileWindowMs: 10_000
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 150))
      blockLoop(500)
      await new Promise((resolve) => setTimeout(resolve, 150))
      blockLoop(700)
      await new Promise((resolve) => setTimeout(resolve, 600))
    } finally {
      watchdog.stop()
    }

    const profiled = warned.filter((entry) => entry.data.stack.status === 'profiled')
    expect(profiled.length).toBeGreaterThan(0)
    const stack = profiled[0]?.data.stack
    if (stack?.status !== 'profiled') throw new Error('expected a profiled stall')
    expect(stack.mainThreadMs).toBeGreaterThan(0)
    expect(stack.frames.length).toBeGreaterThan(0)
    expect(
      stack.frames.some((frame) => frame.frame.includes('event-loop-stall-watchdog.test'))
    ).toBe(true)
    expect(profiled[0]?.data.attribution).toBe('cpu-bound-in-process')
  }, 15_000)
})
