import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  startEventLoopStallWatchdog,
  type EventLoopStallRecord,
  type StallFrame
} from './event-loop-stall-watchdog'
import type { HostStallSampler } from './host-stall-sampler'
import type { GcPauseMonitor } from './gc-pause-monitor'
import { createLoopHeldWindows } from './loop-held-windows'
import { createStallRecordRing } from './stall-record-ring'
import {
  createRollingStackProfile,
  summarizeProfile,
  type RollingStackProfile,
  type StackProfile,
  type V8Profile
} from './stall-stack-profile'

// The watchdog cases drive time by hand; a real sampler thread would stamp the test's own clock instead of
// the one they advance. This stub answers as "the thread saw nothing inside the stall", which is the honest
// answer for a window nobody sampled — and one case below drives a timeline through it.
const quietHostSampler = (): HostStallSampler => ({
  read: async () => ({ status: 'no-in-stall-samples' }),
  snapshot: async () => undefined,
  stop: () => undefined
})

// A runtime without an inspector: every record then says `unavailable`, which is what these cases are not
// about. Cases that do exercise the stack inject a stub that answers with a profile.
const noPresampler = (): RollingStackProfile | undefined => undefined

// The two instruments behind `cause` are defaulted here, not in the module, for the same reason the samplers
// are: these cases drive their own clock, so a real `PerformanceObserver` would report pauses on
// `performance.now()` while the windows are on the fake one, and a real canary read (a temp file, one I/O)
// would keep the record from ever being reported to a case that only advances timers. One case below leaves
// both at their production defaults on a real clock and asserts what they produce.
const noGcMonitor = (): GcPauseMonitor | undefined => undefined
const quietFsProbe = {
  inFlight: (): number => 0,
  startCanaryRead: async (): Promise<number> => 1
}

const presamplerStub = (
  // `samples` is filled from the frames unless a case names it: a fixture that reports frames is describing
  // samples that named them, while the "everything landed on filtered code" case has samples and no frames.
  profile?: Omit<StackProfile, 'samples'> & { samples?: number }
): {
  presampler: RollingStackProfile
  take: ReturnType<typeof vi.fn>
  rotate: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
} => {
  const take = vi.fn(async () =>
    profile
      ? {
          ...profile,
          samples: profile.samples ?? profile.frames.reduce((sum, frame) => sum + frame.samples, 0)
        }
      : undefined
  )
  const rotate = vi.fn()
  const stop = vi.fn()
  return { presampler: { take, rotate, stop }, take, rotate, stop }
}

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

// Every record now comes out of the samplers' promise (there is no synchronous first-stall path any more), so
// a case has to let those microtasks run before reading the log.
const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
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
      createPresampler: noPresampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: noGcMonitor,
      fsProbe: quietFsProbe
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
  it('stays silent at the shipped cadence and reports only the lateness past it', async () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const watchdog = startEventLoopStallWatchdog({
      log,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({ freeMemMb: 70 }),
      createPresampler: noPresampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: noGcMonitor,
      fsProbe: quietFsProbe
    })

    for (const step of [500, 501, 502, 500, 503, 500]) {
      time.advance(step, 5)
      vi.advanceTimersByTime(500)
    }
    expect(warned).toHaveLength(0)

    // One window that arrived a full threshold late: 500 ms of schedule + 500 ms of lateness.
    time.advance(1_000, 100)
    vi.advanceTimersByTime(500)
    await settle()

    expect(warned).toHaveLength(1)
    expect(warned[0]?.data.windowMs).toBe(1_000)
    expect(warned[0]?.data.lateMs).toBe(500)
    watchdog.stop()
  })

  // The gap this case pins is the one the shipped logs showed for weeks: the sampler used to be armed *after*
  // the first stall was reported, so the first (and usually longest) stall of a burst could never carry a
  // stack — it said `no-second-stall` by construction. Now the profile is already recording when it arrives.
  it('reads the stack sampler that was already recording when the very first stall arrives', async () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const { presampler, take } = presamplerStub()
    const createPresampler = vi.fn(() => presampler)
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({ freeMemMb: 40, loadAvg1m: 12.5 }),
      createPresampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: noGcMonitor,
      fsProbe: quietFsProbe
    })
    // Created once, at start-up: that is the whole point — nothing waits for a stall to begin sampling.
    expect(createPresampler).toHaveBeenCalledTimes(1)

    // 2 s of wall time for a 100 ms tick, 1.6 s of it on CPU.
    time.advance(2_000, 1_600)
    vi.advanceTimersByTime(100)
    await settle()

    expect(warned).toHaveLength(1)
    expect(warned[0]?.message).toBe('event loop stalled')
    expect(warned[0]?.data.windowMs).toBe(2_000)
    expect(warned[0]?.data.cpuMs).toBe(1_600)
    expect(warned[0]?.data.cpuShare).toBe(0.8)
    // The stub answered with no profile, so the record has to say so rather than claim it looked.
    expect(warned[0]?.data.stack).toEqual({ status: 'unavailable' })
    expect(warned[0]?.data.freeMemMb).toBe(40)
    expect(warned[0]?.data.loadAvg1m).toBe(12.5)
    expect(take).toHaveBeenCalledWith(2_000)
    watchdog.stop()
  })

  it('remembers the window it reported so a handler spanning it can say how long it was not running', async () => {
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
      createPresampler: noPresampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: noGcMonitor,
      fsProbe: quietFsProbe,
      heldWindows: held
    })

    // Schedule only: the loop was on time, so nothing is remembered as held.
    time.advance(100, 5)
    vi.advanceTimersByTime(100)
    expect(held.heldMsWithin(0, 1_000_000)).toBe(0)

    // 2 s late with a 100 ms tick: the unresponsive part is the 1.9 s past the schedule, not the whole window.
    time.advance(2_000, 100)
    vi.advanceTimersByTime(100)
    await settle()
    const endOfWindow = time.now()
    expect(held.heldMsWithin(endOfWindow - 1_900, endOfWindow)).toBe(1_900)
    expect(held.heldMsWithin(endOfWindow - 2_000, endOfWindow)).toBe(1_900)
    // A handler that finished before the block began was not held by it.
    expect(held.heldMsWithin(endOfWindow - 5_000, endOfWindow - 2_500)).toBe(0)
    watchdog.stop()
  })

  it('names the blocking frame from the profile of the first stall', async () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const frames: StallFrame[] = [
      { frame: 'saveSession (src/main/session-persistence/coordinator.ts:412)', samples: 46 }
    ]
    const { presampler, take } = presamplerStub({ mainThreadMs: 4_900, unobservedMs: 0, frames })
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({}),
      createPresampler: () => presampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: noGcMonitor,
      fsProbe: quietFsProbe
    })

    // 5 s of wall time for a 100 ms tick, but only 0.6 s of CPU: `cpuShare` alone would call this
    // `no-cpu-in-process`. The profiled main-thread reading (4.9 of those 5 s) is the stricter verdict.
    time.advance(5_000, 600)
    vi.advanceTimersByTime(100)
    await settle()

    expect(warned).toHaveLength(1)
    expect(take).toHaveBeenCalledWith(5_000)
    const record = warned[0]?.data
    expect(record?.windowMs).toBe(5_000)
    expect(record?.cpuShare).toBe(0.12)
    expect(record?.attribution).toBe('cpu-bound-in-process')
    expect(record?.stack).toEqual({
      status: 'profiled',
      mainThreadMs: 4_900,
      unobservedMs: 0,
      samples: 46,
      frames
    })
    watchdog.stop()
  })

  it('says a stall burned almost no CPU without saying why it burned none', async () => {
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
      createPresampler: noPresampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: noGcMonitor,
      fsProbe: quietFsProbe
    })

    time.advance(5_000, 40)
    vi.advanceTimersByTime(100)
    await settle()

    expect(warned).toHaveLength(1)
    expect(warned[0]?.data.cpuShare).toBe(0.008)
    expect(warned[0]?.data.attribution).toBe('no-cpu-in-process')
    watchdog.stop()
  })

  it('keeps the middle band unresolved instead of forcing a verdict', async () => {
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
      createPresampler: noPresampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: noGcMonitor,
      fsProbe: quietFsProbe
    })

    time.advance(5_000, 2_000)
    vi.advanceTimersByTime(100)
    await settle()

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
      createPresampler: noPresampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: noGcMonitor,
      fsProbe: quietFsProbe
    })

    time.advance(2_000, 1_600)
    vi.advanceTimersByTime(100)
    await settle()
    time.advance(2_000, 1_600)
    vi.advanceTimersByTime(100)
    await settle()

    expect(warned).toHaveLength(2)
    expect(warned[0]?.data.stack).toEqual({ status: 'unavailable' })
    expect(warned[1]?.data.stack).toEqual({ status: 'unavailable' })
    // The two samplers fail independently: with no profiler the host thread is still there, so both stalls
    // get their own reading instead of the first one being skipped while a window is "armed".
    expect(warned[0]?.data.host).toEqual({ status: 'no-in-stall-samples' })
    expect(warned[1]?.data.host).toEqual({ status: 'no-in-stall-samples' })
    watchdog.stop()
  })

  it('hands the stall window to the sampler thread and reports what it saw inside', async () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const windows: [number, number][] = []
    const host: HostStallSampler = {
      read: async (fromMs, toMs) => {
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
      snapshot: async () => undefined,
      stop: () => undefined
    }
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      // The sampler stamps with the wall clock, so the window has to be expressed in the same clock.
      wallClock: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({ freeMemMb: 40 }),
      createPresampler: noPresampler,
      createHostSampler: () => host,
      createGcMonitor: noGcMonitor,
      fsProbe: quietFsProbe
    })

    time.advance(2_000, 100)
    vi.advanceTimersByTime(100)
    await settle()
    // The FIRST stall is read, not skipped: the thread was already sampling before it began.
    expect(windows).toEqual([[1_000, 3_000]])
    expect(warned[0]?.data.host).toMatchObject({
      status: 'sampled',
      samples: 19,
      continuity: 'kept-sampling',
      freeMemMbMin: 38
    })

    time.advance(5_000, 20)
    vi.advanceTimersByTime(100)
    await settle()

    expect(windows).toEqual([
      [1_000, 3_000],
      [3_000, 8_000]
    ])
    expect(warned[1]?.data.host).toMatchObject({
      status: 'sampled',
      samples: 19,
      continuity: 'kept-sampling',
      freeMemMbMin: 38
    })
    watchdog.stop()
  })

  // One profiler for the life of the process has to be bounded, and the bound must not eat the samples the
  // next record needs: rotation runs on the loop's own tick, and a stall's `take()` restarts the segment, so
  // the two can never both fire on the same tick and lose the stall.
  it('rotates the always-recording profile on the loop tick and after every stall', async () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const { presampler, take, rotate, stop } = presamplerStub()
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      presampleRotateMs: 1_000,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({}),
      createPresampler: () => presampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: noGcMonitor,
      fsProbe: quietFsProbe
    })

    // Three on-time ticks, 1.1 s of loop time: one rotation, on the tick that crosses the interval.
    for (let index = 0; index < 11; index += 1) {
      time.advance(100, 5)
      vi.advanceTimersByTime(100)
    }
    expect(rotate).toHaveBeenCalledTimes(1)

    // A stall takes the profile instead: it must not also be rotated on the same tick, or the samples the
    // record needs would be thrown away before they are read.
    time.advance(2_000, 1_600)
    vi.advanceTimersByTime(100)
    await settle()
    expect(take).toHaveBeenCalledTimes(1)
    expect(rotate).toHaveBeenCalledTimes(1)

    watchdog.stop()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(warned).toHaveLength(1)
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
      createPresampler: noPresampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: noGcMonitor,
      fsProbe: quietFsProbe
    })

    watchdog.stop()
    time.advance(2_000, 1_600)
    vi.advanceTimersByTime(100)
    expect(warned).toHaveLength(0)
  })

  // The log line is the full record, but it lives in a file the bundle copies under a byte cap and a
  // maintainer has to grep. The ring is what the bundle reads, so the record has to land there too — and it
  // has to land there even when the logger is the thing that fails, since the logger is the slower of the two.
  it('keeps every reported stall in its ring, including when writing the log line throws', async () => {
    vi.useFakeTimers()
    const time = drive()
    const ring = createStallRecordRing({ now: () => new Date('2026-10-25T09:00:00.000Z') })
    const frames: StallFrame[] = [{ frame: 'busy (src/main/busy.ts:7)', samples: 30 }]
    const { presampler } = presamplerStub({ mainThreadMs: 1_800, unobservedMs: 0, frames })
    const log = {
      warn: vi.fn(() => {
        throw new Error('disk full')
      })
    }
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({ freeMemMb: 55 }),
      createPresampler: () => presampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: noGcMonitor,
      fsProbe: quietFsProbe,
      records: ring
    })

    time.advance(2_000, 1_600)
    vi.advanceTimersByTime(100)
    await settle()

    const summary = ring.summary()
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(summary.observed).toBe(1)
    expect(summary.records[0]?.windowMs).toBe(2_000)
    expect(summary.records[0]?.at).toBe('2026-10-25T09:00:00.000Z')
    // The same record the log would have carried, not a reduced copy: the frames are what name the code.
    expect(summary.records[0]?.stack).toMatchObject({ status: 'profiled', frames })
    expect(summary.records[0]?.host).toMatchObject({ status: 'no-in-stall-samples' })
    watchdog.stop()
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

  // The shape a starved runner produced on Windows CI: the record came back `profiled` with zero frames and
  // zero unobserved time, which is indistinguishable from "the loop was idle". A window nobody sampled has to
  // say so, or the caller reads silence as evidence.
  it('reports the whole window as unobserved when the sampler recorded no sample in it', () => {
    const empty: V8Profile = { startTime: 1, nodes: [frame], samples: [], timeDeltas: [] }

    const profile = summarizeProfile(empty, 500)
    expect(profile.frames).toEqual([])
    expect(profile.mainThreadMs).toBe(0)
    // 500 ms stall + the 50 ms coalescing slack the window is widened by.
    expect(profile.unobservedMs).toBe(550)
    expect(profile.samples).toBe(0)
  })

  // The other zero-frame shape, and the one a runner actually produces: the sampler did take samples, but
  // every one of them landed on a frame this module filters on purpose (native, node internals, `(program)`,
  // GC, or our own instrumentation). Before `samples` existed this printed `frames: []` with no unobserved
  // time — the same two numbers an idle loop gives — and a Windows lane failure could not be told from a
  // quiet window. The count now says the sampler ran; the record still names nothing it cannot claim.
  it('keeps the sample count when every sample landed on filtered code', () => {
    const filtered: V8Profile = {
      startTime: 1,
      nodes: [{ id: 1, callFrame: { functionName: '(program)', url: '', lineNumber: -1 } }],
      samples: [1, 1, 1],
      timeDeltas: [11_000, 11_000, 11_000]
    }

    const profile = summarizeProfile(filtered, 50)
    expect(profile.frames).toEqual([])
    expect(profile.unobservedMs).toBe(0)
    expect(profile.samples).toBe(3)
    expect(profile.mainThreadMs).toBe(33)
  })

  // The coarse cadence means the last sample before the stall can be up to a whole interval early: the window
  // the summary looks at has to be widened by the cadence, or the first samples of a stall would be dropped.
  // Totals here: 200+200+50+50 = 500 ms of recording, so a 90 ms stall starts 410 ms in.
  it('widens the window by the coalescing slack it is given', () => {
    const profile: V8Profile = {
      startTime: 1,
      nodes: [frame],
      samples: [1, 1, 1, 1],
      // Two samples well before the stall, then two inside it.
      timeDeltas: [200_000, 200_000, 50_000, 50_000]
    }

    // With the production slack (50 ms) the window opens at 360 ms, so the sample that lands 400 ms in — one
    // 50 ms cadence early — still counts: 3 samples.
    expect(summarizeProfile(profile, 90).frames[0]?.samples).toBe(3)
    // With no slack at all the window opens at 410 ms and that pre-stall sample is excluded: 2 samples.
    expect(summarizeProfile(profile, 90, 0).frames[0]?.samples).toBe(2)
  })
})

// The unit cases above drive injected time; this one runs the real interval, the real `process.cpuUsage`
// and the real V8 sampler, because the sampler is the part that can silently return nothing. It is also the
// case that pins the point of this module: the FIRST block of the run has to come back profiled.
describe('event loop stall watchdog (real clock and sampler)', () => {
  const blockLoop = (ms: number): void => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      // Busy-wait: the point is to hold the loop.
    }
  }

  // Why this case is driven by hand and not by the V8 sampling thread: on a Windows CI runner the sampling
  // thread can be kept off the CPU for an entire busy-wait block, so a case that demands "the profile names
  // THIS test's frame" is measuring the runner's scheduler, not the watchdog. It failed that way on the
  // Windows lane (Verify → Test, `expected false to be true`) while passing 2/2 locally.
  //
  // The promise being tested is "a profile becomes a named frame plus an attribution", and both stalls must
  // answer — that is asserted here with a profile the watchdog cannot fail to receive. The real clock and
  // the real samplers still get their own case below, where only what ANY runner can produce is demanded.
  it('names a function from the profile, on the first stall as well as the second', async () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const frames: StallFrame[] = [
      {
        frame: 'blockLoop (src/main/diagnostics/event-loop-stall-watchdog.test.ts:594)',
        samples: 32
      }
    ]
    const { presampler } = presamplerStub({ mainThreadMs: 1_900, unobservedMs: 0, frames })
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({}),
      createPresampler: () => presampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: noGcMonitor,
      fsProbe: quietFsProbe
    })
    try {
      // Two stalls in a row: the record for the second one must be as usable as the first (the original
      // regression was the first stall arriving without a stack at all).
      time.advance(2_000, 1_800)
      vi.advanceTimersByTime(100)
      await settle()
      time.advance(2_000, 1_800)
      vi.advanceTimersByTime(100)
      await settle()
    } finally {
      watchdog.stop()
    }

    expect(warned).toHaveLength(2)
    for (const entry of warned) {
      const stack = entry.data.stack
      expect(stack.status).toBe('profiled')
      if (stack.status !== 'profiled') throw new Error('unreachable')
      expect(stack.frames.map((frame) => frame.frame)).toContain(frames[0]?.frame)
      expect(entry.data.attribution).toBe('cpu-bound-in-process')
    }
  })

  // The cause is what a reader acts on, so each case here pins one instrument deciding the verdict — and the
  // compatibility half: `attribution` keeps its measured meaning (`no-cpu-in-process`) instead of being
  // overloaded into a cause.
  it('names garbage collection when V8 pauses fill the window', async () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({ freeMemMb: 60 }),
      createPresampler: noPresampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: () => ({
        pauseMsWithin: () => ({ status: 'measured', pauseMs: 400, pauses: 3 }),
        stop: () => undefined
      }),
      fsProbe: quietFsProbe
    })

    time.advance(1_000, 60)
    vi.advanceTimersByTime(100)
    await settle()

    expect(warned).toHaveLength(1)
    const record = warned[0]?.data
    // The measurement stays what it was: almost no CPU here. The cause is the addition, not a redefinition.
    expect(record?.attribution).toBe('no-cpu-in-process')
    expect(record?.cause.kind).toBe('garbage-collection')
    expect(record?.cause.gc).toEqual({ status: 'measured', pauseMs: 400, pauses: 3 })
    expect(record?.cause.basis).toContain('gc 400 ms')
    watchdog.stop()
  })

  it('names the file-system pool when the canary waited behind other work', async () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const httpInFlight = 7
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({ freeMemMb: 60 }),
      createPresampler: noPresampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: () => ({
        pauseMsWithin: () => ({ status: 'measured', pauseMs: 0, pauses: 0 }),
        stop: () => undefined
      }),
      fsProbe: { inFlight: () => httpInFlight, startCanaryRead: async () => 250 }
    })

    time.advance(1_000, 60)
    vi.advanceTimersByTime(100)
    await settle()

    expect(warned).toHaveLength(1)
    expect(warned[0]?.data.cause.kind).toBe('fs-queue-saturated')
    expect(warned[0]?.data.cause.fs).toEqual({
      status: 'measured',
      canaryMs: 250,
      inFlight: httpInFlight
    })
    watchdog.stop()
  })

  it('says the stall was unexplained when both instruments ran and neither accounts for it', async () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({ freeMemMb: 60 }),
      createPresampler: noPresampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: () => ({
        pauseMsWithin: () => ({ status: 'measured', pauseMs: 0, pauses: 0 }),
        stop: () => undefined
      }),
      fsProbe: quietFsProbe
    })

    time.advance(1_000, 60)
    vi.advanceTimersByTime(100)
    await settle()

    expect(warned).toHaveLength(1)
    expect(warned[0]?.data.cause.kind).toBe('unexplained')
    // The sentence has to carry the numbers that were ruled out, or the reader is back to trusting a label.
    expect(warned[0]?.data.cause.basis).toContain('gc 0 ms')
    expect(warned[0]?.data.cause.basis).toContain('fs canary 1 ms')
    watchdog.stop()
  })

  it('says unmeasured when an instrument is missing instead of implying the machine was calm', async () => {
    vi.useFakeTimers()
    const time = drive()
    const { log, warned } = collect()
    const watchdog = startEventLoopStallWatchdog({
      log,
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({ freeMemMb: 60 }),
      createPresampler: noPresampler,
      createHostSampler: quietHostSampler,
      createGcMonitor: noGcMonitor,
      fsProbe: {
        inFlight: () => 0,
        startCanaryRead: async () => {
          throw new Error('no canary file')
        }
      }
    })

    time.advance(1_000, 60)
    vi.advanceTimersByTime(100)
    await settle()

    expect(warned).toHaveLength(1)
    expect(warned[0]?.data.cause.kind).toBe('unmeasured')
    expect(warned[0]?.data.cause.gc).toEqual({ status: 'unavailable' })
    // A failed canary is not a fast canary: the reading has to say it was not taken.
    expect(warned[0]?.data.cause.fs).toEqual({ status: 'unavailable' })
    watchdog.stop()
  })

  // The real-clock/real-sampler half: it must produce records, and every profiled record must account for
  // its window — samples the sampler took (which may all sit on frames this module filters on purpose), or a
  // named unobserved stretch. Which frames a starved runner's sampling thread manages to take is deliberately
  // NOT asserted here (see the case above).
  it('records real stalls and never reports a profiled window with neither frames nor unobserved time', async () => {
    const { log, warned } = collect()
    const watchdog = startEventLoopStallWatchdog({ log, tickMs: 50, thresholdMs: 200 })
    try {
      await new Promise((resolve) => setTimeout(resolve, 150))
      blockLoop(500)
      await new Promise((resolve) => setTimeout(resolve, 400))
    } finally {
      watchdog.stop()
    }

    expect(warned.length).toBeGreaterThan(0)
    for (const entry of warned) {
      // Both instruments are the production ones here (a real `PerformanceObserver` and a real canary read), so
      // this is the case that says the defaults actually produce a reading rather than `unavailable` — the
      // shape a stubbed seam can never prove.
      expect(entry.data.cause.gc.status).toBe('measured')
      expect([
        'garbage-collection',
        'fs-queue-saturated',
        'cpu-in-process',
        'unexplained'
      ]).toContain(entry.data.cause.kind)
      if (entry.data.stack.status !== 'profiled') continue
      // A profiled window has to account for itself: either the sampler holds samples in it, or the window is
      // named as unobserved. Two zeros is the one shape that must not exist — it reads exactly like an idle
      // loop, and it is what the Windows lane produced once under the earlier summary. The message carries the
      // numbers so the next red says which shape it was instead of only `expected false to be true`.
      const stack = entry.data.stack
      expect(
        stack.samples > 0 || stack.unobservedMs > 0,
        `profiled window accounted for neither samples nor unobserved time: ${JSON.stringify(stack)}`
      ).toBe(true)
    }
  }, 15_000)
})

// The presampler itself, with a fake inspector session: what matters is that one session survives the
// stop/start cycle (a bounded window needs it), that a failed read is `undefined` rather than a profile with
// nothing in it, and that `stop()` closes the session exactly once.
describe('rolling stack profile', () => {
  type Fake = {
    posts: string[]
    stopAnswers: (V8Profile | undefined | Error)[]
    session: {
      post: (
        method: string,
        params?: Record<string, unknown> | ((error: Error | null, result?: unknown) => void),
        callback?: (error: Error | null, result?: unknown) => void
      ) => void
      disconnect: () => void
    }
  }

  const fake = (stopAnswers: (V8Profile | undefined | Error)[]): Fake => {
    const posts: string[] = []
    const answerTo = (
      method: string,
      callback?: (error: Error | null, result?: unknown) => void
    ): void => {
      posts.push(method)
      if (method !== 'Profiler.stop' || !callback) return
      const next = stopAnswers.shift()
      if (next instanceof Error) {
        callback(next)
        return
      }
      callback(null, next ? { profile: next } : undefined)
    }
    return {
      posts,
      stopAnswers,
      session: {
        post: (method, params, callback) => {
          const cb = typeof params === 'function' ? params : callback
          answerTo(method, cb)
        },
        disconnect: () => undefined
      }
    }
  }

  const profile = (frameCount: number): V8Profile => ({
    startTime: 1,
    nodes: [
      {
        id: 1,
        callFrame: { functionName: 'work', url: 'file:///app/out/main/index.js', lineNumber: 3 }
      }
    ],
    samples: Array.from({ length: frameCount }, () => 1),
    timeDeltas: Array.from({ length: frameCount }, () => 50_000)
  })

  it('reads one segment per take and keeps recording afterwards', async () => {
    const { posts, session } = fake([profile(4), profile(6)])
    const rolling = createRollingStackProfile({ openSession: () => session })
    if (!rolling) throw new Error('expected a sampler')

    const first = await rolling.take(200)
    expect(first?.frames[0]).toEqual({ frame: 'work (out/main/index.js:4)', samples: 4 })
    // Every take has to leave the session recording again, or the next stall has nothing.
    expect(posts).toEqual(['Profiler.stop', 'Profiler.start'])

    const second = await rolling.take(300)
    expect(second?.frames[0]?.samples).toBe(6)
    expect(posts).toEqual(['Profiler.stop', 'Profiler.start', 'Profiler.stop', 'Profiler.start'])
    rolling.stop()
    await settle()
  })

  it('answers undefined when the session cannot be read, and stops recording after that', async () => {
    const { posts, session } = fake([new Error('inspector gone')])
    const rolling = createRollingStackProfile({ openSession: () => session })
    if (!rolling) throw new Error('expected a sampler')

    expect(await rolling.take(100)).toBeUndefined()
    // A session that failed is not restarted: reporting `unavailable` forever beats pretending to sample.
    expect(posts).toEqual(['Profiler.stop'])
    expect(await rolling.take(100)).toBeUndefined()
    rolling.stop()
  })

  it('drops a segment on rotate without reporting it', async () => {
    const { posts, session } = fake([profile(5)])
    const rolling = createRollingStackProfile({ openSession: () => session })
    if (!rolling) throw new Error('expected a sampler')

    rolling.rotate()
    await settle()
    expect(posts).toEqual(['Profiler.stop', 'Profiler.start'])
    rolling.stop()
    await settle()
    expect(posts).toEqual(['Profiler.stop', 'Profiler.start', 'Profiler.stop'])
  })

  it('is undefined when the runtime has no inspector, which is a state the record can name', () => {
    expect(createRollingStackProfile({ openSession: () => undefined })).toBeUndefined()
  })
})
