import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  startEventLoopStallWatchdog,
  summarizeProfile,
  type EventLoopStallRecord,
  type StallFrame,
  type V8Profile
} from './event-loop-stall-watchdog'
import type { HostStallSampler } from './host-stall-sampler'
import { createLoopHeldWindows } from './loop-held-windows'

// The watchdog cases drive time by hand; a real sampler thread would stamp the test's own clock instead of
// the one they advance. This stub answers as "the thread saw nothing inside the stall", which is the honest
// answer for a window nobody sampled — and one case below drives a timeline through it.
const quietHostSampler = (): HostStallSampler => ({
  stop: async () => ({ status: 'no-in-stall-samples' }),
  cancel: () => undefined
})

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
      createSampler: () => undefined,
      createHostSampler: quietHostSampler
    })

    for (let index = 0; index < 5; index += 1) {
      time.advance(100, 5)
      vi.advanceTimersByTime(100)
    }
    watchdog.stop()
    expect(warned).toHaveLength(0)
  })

  // The two defaults are equal, and that is the whole trap: a case that drives a 100 ms tick against a
  // 500 ms threshold can never notice that the shipped cadence fills the threshold by itself. This case
  // uses the production pair, and the windows are the ones the shipped build actually wrote (501/502 ms).
  it('stays silent at the shipped cadence and reports only the lateness past it', () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const watchdog = startEventLoopStallWatchdog({
      log,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({ freeMemMb: 70 }),
      createSampler: () => undefined,
      createHostSampler: quietHostSampler
    })

    for (const step of [500, 501, 502, 500, 503, 500]) {
      time.advance(step, 5)
      vi.advanceTimersByTime(500)
    }
    expect(warned).toHaveLength(0)

    // One window that arrived a full threshold late: 500 ms of schedule + 500 ms of lateness.
    time.advance(1_000, 100)
    vi.advanceTimersByTime(500)

    expect(warned).toHaveLength(1)
    expect(warned[0]?.data.windowMs).toBe(1_000)
    expect(warned[0]?.data.lateMs).toBe(500)
    watchdog.stop()
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
      createSampler: created,
      createHostSampler: quietHostSampler
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

  it('remembers the window it reported so a handler spanning it can say how long it was not running', () => {
    vi.useFakeTimers()
    const time = drive()
    const { log } = collect()
    const held = createLoopHeldWindows()
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({ freeMemMb: 90 }),
      createSampler: () => undefined,
      createHostSampler: quietHostSampler,
      heldWindows: held
    })

    // Schedule only: the loop was on time, so nothing is remembered as held.
    time.advance(100, 5)
    vi.advanceTimersByTime(100)
    expect(held.heldMsWithin(0, 1_000_000)).toBe(0)

    // 2 s late with a 100 ms tick: the unresponsive part is the 1.9 s past the schedule, not the whole window.
    time.advance(2_000, 100)
    vi.advanceTimersByTime(100)
    const endOfWindow = time.now()
    expect(held.heldMsWithin(endOfWindow - 1_900, endOfWindow)).toBe(1_900)
    expect(held.heldMsWithin(endOfWindow - 2_000, endOfWindow)).toBe(1_900)
    // A handler that finished before the block began was not held by it.
    expect(held.heldMsWithin(endOfWindow - 5_000, endOfWindow - 2_500)).toBe(0)
    watchdog.stop()
  })

  it('names the blocking frame from the profile when a second stall lands inside the window', async () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const frames: StallFrame[] = [
      { frame: 'saveSession (src/main/session-persistence/coordinator.ts:412)', samples: 46 }
    ]
    const stop = vi.fn(async () => ({ mainThreadMs: 4_900, unobservedMs: 0, frames }))
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      profileWindowMs: 10_000,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({}),
      createSampler: () => ({ stop, cancel: () => undefined }),
      createHostSampler: quietHostSampler
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
    expect(second?.stack).toEqual({
      status: 'profiled',
      mainThreadMs: 4_900,
      unobservedMs: 0,
      frames
    })
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
      createSampler: () => undefined,
      createHostSampler: quietHostSampler
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
      createSampler: () => undefined,
      createHostSampler: quietHostSampler
    })

    time.advance(5_000, 2_000)
    vi.advanceTimersByTime(100)

    expect(warned[0]?.data.cpuShare).toBe(0.4)
    expect(warned[0]?.data.attribution).toBe('inconclusive')
    watchdog.stop()
  })

  it('records an unavailable sampler instead of a stall with no stack as if nothing was wrong', async () => {
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
      createSampler: () => undefined,
      createHostSampler: quietHostSampler
    })

    time.advance(2_000, 1_600)
    vi.advanceTimersByTime(100)
    time.advance(2_000, 1_600)
    vi.advanceTimersByTime(100)
    // The second stall is reported from the samplers' promise: both halve out, then the record lands.
    await Promise.resolve()
    await Promise.resolve()

    expect(warned).toHaveLength(2)
    expect(warned[0]?.data.stack).toEqual({ status: 'unavailable' })
    expect(warned[1]?.data.stack).toEqual({ status: 'unavailable' })
    // The two samplers fail independently: with no profiler the window is still armed, so the second stall
    // is served by the sampler thread instead of arming a second window and leaking the first thread.
    expect(warned[0]?.data.host).toEqual({ status: 'window-armed' })
    expect(warned[1]?.data.host).toEqual({ status: 'no-in-stall-samples' })
    watchdog.stop()
  })

  it('hands the stall window to the sampler thread and reports what it saw inside', async () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const windows: [number, number][] = []
    const host: HostStallSampler = {
      stop: async (fromMs, toMs) => {
        windows.push([fromMs, toMs])
        return {
          status: 'sampled',
          intervalMs: 250,
          stallMs: toMs - fromMs,
          samples: 19,
          expectedSamples: 19,
          maxGapMs: 250,
          continuity: 'kept-sampling',
          cpuMs: 20,
          cpuShare: 0.004,
          freeMemMbMin: 38
        }
      },
      cancel: () => undefined
    }
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      profileWindowMs: 10_000,
      now: time.now,
      // The sampler stamps with the wall clock, so the window has to be expressed in the same clock.
      wallClock: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({ freeMemMb: 40 }),
      createSampler: () => ({ stop: async () => undefined, cancel: () => undefined }),
      createHostSampler: () => host
    })

    time.advance(2_000, 100)
    vi.advanceTimersByTime(100)
    // The window is armed by the first stall; nothing has been sampled inside a stall yet.
    expect(warned[0]?.data.host).toEqual({ status: 'window-armed' })

    time.advance(5_000, 20)
    vi.advanceTimersByTime(100)
    await Promise.resolve()
    await Promise.resolve()

    expect(windows).toEqual([[3_000, 8_000]])
    expect(warned[1]?.data.host).toMatchObject({
      status: 'sampled',
      samples: 19,
      continuity: 'kept-sampling',
      freeMemMbMin: 38
    })
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
      createSampler: () => undefined,
      createHostSampler: quietHostSampler
    })

    watchdog.stop()
    time.advance(2_000, 1_600)
    vi.advanceTimersByTime(100)
    expect(warned).toHaveLength(0)
  })
})

// The rule below has already been wrong once, and only a real frozen process exposed it: a profile taken
// across a 2 s `SIGSTOP` reported `mainThreadMs 2103` for a 2053 ms stall, because the gap between two
// samples (the sampling thread was stopped too) was added up as main-thread run time. That turned a machine
// freeze into "our own code did it".
describe('reading a V8 profile', () => {
  const frame = {
    id: 1,
    callFrame: { functionName: 'block', url: 'file:///app/out/main/index.js', lineNumber: 10 }
  }

  it('counts a gap wider than the sampler cadence as unobserved, not as main-thread work', () => {
    const frozen: V8Profile = {
      startTime: 1,
      nodes: [frame],
      samples: [1, 1, 1, 1],
      // Three ordinary samples, then the hole: 2 s in which the sampling thread itself did not run.
      timeDeltas: [11_000, 11_000, 11_000, 2_000_000]
    }

    const profile = summarizeProfile(frozen, 2_000)
    expect(profile.unobservedMs).toBe(2_000)
    // The three real samples still name the frame; the hole is reported separately and adds no run time.
    expect(profile.mainThreadMs).toBe(33)
    expect(profile.frames).toEqual([{ frame: 'block (out/main/index.js:11)', samples: 3 }])
  })

  it('counts every ordinary sample when the loop was simply busy', () => {
    const busy: V8Profile = {
      startTime: 1,
      nodes: [frame],
      samples: [1, 1, 1, 1],
      timeDeltas: [11_000, 11_000, 11_000, 11_000]
    }

    const profile = summarizeProfile(busy, 50)
    expect(profile.unobservedMs).toBe(0)
    expect(profile.mainThreadMs).toBe(44)
    expect(profile.frames[0]?.samples).toBe(4)
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
