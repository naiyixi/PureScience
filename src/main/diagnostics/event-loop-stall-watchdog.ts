import { freemem, loadavg, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'

import type { Logger } from '../logger'
import { classifyCpuShare, cpuShareOf, type ActivityAttribution } from './cpu-attribution'
import {
  createHostStallSampler,
  type HostStallReading,
  type HostStallSampler
} from './host-stall-sampler'
import { sharedLoopHeldWindows, type LoopHeldWindows } from './loop-held-windows'
import { sharedStallRecords, type StallRecordRing } from './stall-record-ring'
import {
  createRollingStackProfile,
  type RollingStackProfile,
  type StackProfile,
  type StallFrame
} from './stall-stack-profile'

// A 113.9 s save and a 7.2 s `SELECT 1` in the same 150 s window cannot both be explained by "the save is
// slow": the segment timings grew by the same factor (write 641x, authority read 639x), and the event loop
// itself reported 7-12 s delays. That shape has two possible causes and no existing reading separates
// them: our own long synchronous block, or the process/machine not being scheduled at all (paging, disk
// thrash, CPU starvation). Wall-clock timers cannot tell those apart — they are late in both cases.
//
// This watchdog adds the three readings that can:
//   1. `cpuShare` — process CPU time (all threads) against the wall time the loop was late. A stall that
//      burns most of its wall time on CPU is ours; one that burns almost none was descheduled.
//   2. a V8 CPU profile that is already recording when the stall arrives, so the blocking frame is named
//      instead of guessed (see `stall-stack-profile`). It used to be armed *only after* the first stall,
//      which left the longest stall of a burst — the one worth naming — with no stack at all: it reported
//      `no-second-stall` every time, by construction.
//   3. `host` — the same window sampled by a thread of our own (see `host-stall-sampler`), because the
//      machine readings taken by the main thread only ever describe the moment the stall ended. That
//      timeline says whether the machine kept running while we were held, and what it looked like inside
//      the stall (free memory, load, paging counters). It runs permanently behind a bounded ring for the
//      same reason the profiler does: the first stall is often the longest, and a sampler created by that
//      stall could only ever report that it started too late.
//
// Deliberately not a fix: this proves a stall existed and roughly what held it, not why the pages were
// gone. Until a sample names a function (or the machine reading shows the memory is gone) the save path
// must be left alone — changing it would also change the 91% of "slow" saves that are a normal 404 ms tail.

const DEFAULT_TICK_MS = 500
const DEFAULT_STALL_THRESHOLD_MS = 500
// The always-recording profile is dropped and restarted this often, which keeps a permanently running
// profiler from growing for the life of the process (measured at the fine cadence: 2,484 samples / 0.1 MB per
// idle 5 s). Rotation runs on the loop's own tick, never on a timer of its own: a timer could fire between
// the stall ending and the tick that reads the record, throwing away exactly the samples it needs.
const DEFAULT_PRESAMPLE_ROTATE_MS = 30_000
// Named heuristics, not facts — see `cpu-attribution`, which holds the one band both this watchdog and the
// compose/settings recorders classify against.

export type StallAttribution = ActivityAttribution

export type { StallFrame, StackProfile }

export type StallStack =
  // `unobservedMs` is the part of the window the profiler did not sample at all: it is neither main-thread
  // run time nor evidence of anything we did.
  | { status: 'profiled'; mainThreadMs: number; unobservedMs: number; frames: StallFrame[] }
  // No sampler at all (no inspector, or one the runtime refused). Saying that keeps "we did not catch it"
  // from reading like "there was nothing to catch".
  | { status: 'unavailable' }
  | { status: 'disabled' }

export type MachineReading = {
  rssMb?: number
  heapUsedMb?: number
  freeMemMb?: number
  totalMemMb?: number
  loadAvg1m?: number
}

export type EventLoopStallRecord = MachineReading & {
  windowMs: number
  // How far past its own schedule this window arrived. This is the quantity the threshold is about;
  // `windowMs` alone cannot separate a late loop from an on-time one, because the tick period is part of
  // the window (see the note above `DEFAULT_STALL_THRESHOLD_MS`).
  lateMs: number
  cpuMs: number
  cpuShare: number
  attribution: StallAttribution
  stack: StallStack
  // What another thread saw while the loop was held. Always present: "not measured" has to be a named
  // state, never a missing field that reads like a healthy machine.
  host: HostStallReading
}

export type EventLoopStallWatchdogInput = {
  log: Pick<Logger, 'warn'>
  tickMs?: number
  thresholdMs?: number
  // How often the always-recording profile is dropped and restarted.
  presampleRotateMs?: number
  // Where the reported windows are remembered for the IPC slow-handler split (see `loop-held-windows`).
  // Defaults to the shared registry; tests inject their own so one case cannot see another's windows.
  heldWindows?: LoopHeldWindows
  // Where the reported records are remembered for the support bundle (see `stall-record-ring`). Defaults to
  // the shared ring for the same reason: the bundle facts are assembled in the composition root, which has
  // no other way to reach the watchdog. Tests inject their own.
  records?: StallRecordRing
  // Seams. Production passes nothing; tests drive time, CPU, machine state and both samplers directly.
  now?: () => number
  // Wall clock (epoch ms), used to line the sampler's timeline up with the stall: the sampler runs on its
  // own thread and stamps with `Date.now()`, so the two clocks have to be the same kind.
  wallClock?: () => number
  cpuUsage?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage
  machine?: () => MachineReading
  // The stack sampler is recording before the first stall arrives. `() => undefined` is what a runtime
  // without an inspector gets, so cases that do not exercise the stack pass that instead of a real session.
  createPresampler?: () => RollingStackProfile | undefined
  createHostSampler?: () => HostStallSampler | undefined
}

export type EventLoopStallWatchdog = { stop: () => void }

const toMb = (bytes: number): number => Math.round(bytes / 1e6)

const readMachine = (): MachineReading => {
  try {
    const usage = process.memoryUsage()
    const load = loadavg()[0]
    return {
      rssMb: toMb(usage.rss),
      heapUsedMb: toMb(usage.heapUsed),
      freeMemMb: toMb(freemem()),
      totalMemMb: toMb(totalmem()),
      ...(Number.isFinite(load) ? { loadAvg1m: Number(load.toFixed(2)) } : {})
    }
  } catch {
    // Unmeasurable is not zero: omit the reading instead of claiming the machine was healthy.
    return {}
  }
}

export const startEventLoopStallWatchdog = (
  input: EventLoopStallWatchdogInput
): EventLoopStallWatchdog => {
  const now = input.now ?? (() => performance.now())
  const wallClock = input.wallClock ?? ((): number => Date.now())
  const cpuUsage = input.cpuUsage ?? ((previous) => process.cpuUsage(previous))
  const machine = input.machine ?? readMachine
  const createPresampler =
    input.createPresampler ?? ((): RollingStackProfile | undefined => createRollingStackProfile())
  const createHostSampler = input.createHostSampler ?? (() => createHostStallSampler())
  const tickMs = input.tickMs ?? DEFAULT_TICK_MS
  const thresholdMs = input.thresholdMs ?? DEFAULT_STALL_THRESHOLD_MS
  const presampleRotateMs = input.presampleRotateMs ?? DEFAULT_PRESAMPLE_ROTATE_MS
  const heldWindows = input.heldWindows ?? sharedLoopHeldWindows
  const records = input.records ?? sharedStallRecords

  const presampler = createPresampler()
  // Both samplers are recording before the first stall: a timeline (or a stack) that starts *after* the event
  // can only describe the recovery. The host sampler keeps its own bounded ring and answers reads without
  // being torn down, so there is no window to arm and no timer that could take it away mid-burst (see
  // `host-stall-sampler`).
  const hostSampler = createHostSampler()
  let lastTick = now()
  let lastCpu = cpuUsage()
  let nextRotateAt = lastTick + presampleRotateMs
  let stopped = false

  const report = (record: EventLoopStallRecord): void => {
    // Remembered before the log call: a bundle exported after a hang must carry the reading even when the
    // logger itself is the thing that is late. A diagnostic must never take down the loop it measures.
    try {
      records.record(record)
    } catch {
      // Ring is bounded and cannot throw in practice; if it ever did, logging is still the primary record.
    }
    try {
      input.log.warn('event loop stalled', record)
    } catch {
      // A diagnostic must never take down the loop it is measuring.
    }
  }

  const rotateIfDue = (current: number): void => {
    if (!presampler || current < nextRotateAt) return
    presampler.rotate()
    nextRotateAt = current + presampleRotateMs
  }

  const tick = (): void => {
    if (stopped) return
    const current = now()
    const windowMs = Math.round(current - lastTick)
    const cpu = cpuUsage(lastCpu)
    lastTick = current
    lastCpu = cpuUsage()
    // The threshold is about lateness, not about the window. Both defaults are 500 ms, so the loop's own
    // schedule already fills the whole window and comparing `windowMs` against the threshold reported
    // *every* tick as a stall: on the shipped build 26,331 records in 3.7 h, 97.2 % of them 500-503 ms
    // windows (median CPU share 0.23) with no evidence of anything. Deducting the schedule first leaves
    // only the windows that actually arrived late; the 2.8 % that remain in those same logs are the ones
    // carrying a multi-second block (median CPU share 0.92 — these are ours, not the scheduler's).
    const lateMs = windowMs - tickMs
    if (lateMs < thresholdMs) {
      rotateIfDue(current)
      return
    }

    // Remember the part of the window the loop was actually late by, so a handler that spans it can say how
    // much of its duration the process was not running (the rest is its own work). Recorded before either
    // report path so the first stall of a burst counts too — that one is often the long one.
    heldWindows.record(current - lateMs, current)

    const cpuMs = Math.round((cpu.user + cpu.system) / 1000)
    const cpuShare = cpuShareOf(cpuMs, windowMs)
    // The stall ended now: both samplers are read against this instant minus the stall itself.
    const endedAtWall = wallClock()
    const base = {
      ...machine(),
      windowMs,
      lateMs,
      cpuMs,
      cpuShare: Number(cpuShare.toFixed(3)),
      attribution: classifyCpuShare(cpuShare, windowMs)
    }

    const hostSlice: Promise<HostStallReading> = hostSampler
      ? hostSampler.read(endedAtWall - windowMs, endedAtWall)
      : Promise.resolve<HostStallReading>({ status: 'unavailable' })
    // `take()` restarts the segment, so whatever happens next is recorded from this instant on.
    const stackSlice: Promise<StackProfile | undefined> = presampler
      ? presampler.take(windowMs)
      : Promise.resolve(undefined)
    nextRotateAt = current + presampleRotateMs

    void Promise.all([stackSlice, hostSlice]).then(([profile, host]) => {
      if (!profile) {
        report({ ...base, stack: { status: 'unavailable' }, host })
        return
      }
      // Main-thread run time is the stricter verdict: `cpuShare` also counts the libuv threadpool and V8
      // helper threads, which can be busy while the main thread itself was never scheduled.
      const mainThreadShare = cpuShareOf(profile.mainThreadMs, windowMs)
      report({
        ...base,
        attribution: classifyCpuShare(mainThreadShare, windowMs),
        stack: {
          status: 'profiled',
          mainThreadMs: profile.mainThreadMs,
          unobservedMs: profile.unobservedMs,
          frames: profile.frames
        },
        host
      })
    })
  }

  const timer = setInterval(tick, tickMs)
  // Never hold the process open for a diagnostic.
  timer.unref?.()

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
      hostSampler?.stop()
      presampler?.stop()
    }
  }
}
