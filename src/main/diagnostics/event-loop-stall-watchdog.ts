import { Session } from 'node:inspector'
import { freemem, loadavg, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'

import type { Logger } from '../logger'
import {
  createHostStallSampler,
  type HostStallReading,
  type HostStallSampler
} from './host-stall-sampler'

// A 113.9 s save and a 7.2 s `SELECT 1` in the same 150 s window cannot both be explained by "the save is
// slow": the segment timings grew by the same factor (write 641x, authority read 639x), and the event loop
// itself reported 7-12 s delays. That shape has two possible causes and no existing reading separates
// them: our own long synchronous block, or the process/machine not being scheduled at all (paging, disk
// thrash, CPU starvation). Wall-clock timers cannot tell those apart — they are late in both cases.
//
// This watchdog adds the three readings that can:
//   1. `cpuShare` — process CPU time (all threads) against the wall time the loop was late. A stall that
//      burns most of its wall time on CPU is ours; one that burns almost none was descheduled.
//   2. a V8 CPU profile armed for a bounded window after the first stall. A *second* stall inside that
//      window is sampled from a separate thread, so the blocking frame is named instead of guessed. The
//      profile also yields main-thread run time, which is stricter than `cpuShare` (that one counts the
//      libuv threadpool and V8 helper threads too).
//   3. `host` — the same window sampled by a thread of our own (see `host-stall-sampler`), because the
//      machine readings taken by the main thread only ever describe the moment the stall ended. That
//      timeline says whether the machine kept running while we were held, and what it looked like inside
//      the stall (free memory, load, paging counters).
//
// Deliberately not a fix: this proves a stall existed and roughly what held it, not why the pages were
// gone. Until a sample names a function (or the machine reading shows the memory is gone) the save path
// must be left alone — changing it would also change the 91% of "slow" saves that are a normal 404 ms tail.

const DEFAULT_TICK_MS = 500
const DEFAULT_STALL_THRESHOLD_MS = 500
const DEFAULT_PROFILE_WINDOW_MS = 15_000
// Named heuristics, not facts: measured on 2026-10-19 probes, a busy loop fills ~0.8 of its wall time with
// CPU while an idle-but-descheduled process fills ~0.0. The band between them stays unresolved instead of
// being forced into a verdict.
const CPU_BOUND_SHARE = 0.6
const DESCHEDULED_SHARE = 0.15
const PROFILE_SAMPLING_INTERVAL_US = 1_000
const MAX_REPORTED_FRAMES = 3
// Samples are attributed to the stall that just ended; a little slack absorbs the tick's own scheduling.
const PROFILE_WINDOW_SLACK_MS = 50
// The profiler asks for a 1 ms cadence and this runtime delivers roughly one sample per 10 ms; a gap of
// half a second between two samples therefore does not mean "the main thread ran for half a second", it
// means the sampling thread itself was not running (the whole process was stopped). Counting such a gap as
// main-thread run time turns a machine freeze into an accusation of our own code — measured, not theorised:
// a 2 s `SIGSTOP` produced `mainThreadMs 2103` and `cpu-bound-in-process` before this bound existed.
const PROFILE_UNOBSERVED_DELTA_MS = 500

export type StallAttribution = 'cpu-bound-in-process' | 'process-not-scheduled' | 'inconclusive'

export type StallFrame = { frame: string; samples: number }

export type StallStack =
  // `unobservedMs` is the part of the window the profiler did not sample at all (see
  // PROFILE_UNOBSERVED_DELTA_MS): it is neither main-thread run time nor evidence of anything we did.
  | { status: 'profiled'; mainThreadMs: number; unobservedMs: number; frames: StallFrame[] }
  // The first stall arms the profiler, so without a second stall inside the window there is nothing to
  // sample. Saying that keeps "we did not catch it" from reading like "there was nothing to catch".
  | { status: 'no-second-stall' }
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

export type StackProfile = { mainThreadMs: number; unobservedMs: number; frames: StallFrame[] }

type StackSampler = {
  // `stalledForMs` bounds the summary to the samples taken during the stall that just ended.
  stop: (stalledForMs: number) => Promise<StackProfile | undefined>
  cancel: () => void
}

export type EventLoopStallWatchdogInput = {
  log: Pick<Logger, 'warn'>
  tickMs?: number
  thresholdMs?: number
  profileWindowMs?: number
  // Seams. Production passes nothing; tests drive time, CPU, machine state and the sampler directly.
  now?: () => number
  // Wall clock (epoch ms), used to line the sampler's timeline up with the stall: the sampler runs on its
  // own thread and stamps with `Date.now()`, so the two clocks have to be the same kind.
  wallClock?: () => number
  cpuUsage?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage
  machine?: () => MachineReading
  createSampler?: () => StackSampler | undefined
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

const classify = (share: number): StallAttribution => {
  if (!Number.isFinite(share)) return 'inconclusive'
  if (share >= CPU_BOUND_SHARE) return 'cpu-bound-in-process'
  if (share <= DESCHEDULED_SHARE) return 'process-not-scheduled'
  return 'inconclusive'
}

// Frames worth reporting are ours and our dependencies': V8 helper/native frames (empty url), node
// internals and this module's own callback would otherwise win every profile, since the watchdog is the
// busiest JS right after a stall. Everything else is kept, including bundled code — in the packaged app
// every product frame looks like `out/main/index.js:<line>` anyway.
const isReportableFrame = (url: string, functionName: string): boolean => {
  if (!url) return false
  if (url.startsWith('node:')) return false
  // Only this module's own files (source and build), not its test: the test blocks the loop on purpose and
  // the frame it produces is exactly what proves the sampler works.
  if (/event-loop-stall-watchdog\.(ts|js)(\?|$)/.test(url)) return false
  if (functionName === '(garbage collector)' || functionName === '(program)') return false
  return true
}

const frameLabel = (url: string, functionName: string, lineNumber: number): string => {
  const match = /(?:^|\/)((?:src|out|e2e)\/.*)$/.exec(url)
  const file = match ? match[1] : url.split('/').filter(Boolean).slice(-2).join('/')
  return `${functionName || '(anonymous)'} (${file}:${lineNumber + 1})`
}

export type V8Profile = {
  startTime: number
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]
  samples: number[]
  timeDeltas: number[]
}

// Exported so a test can pin the one rule that has already been wrong once: a delta wider than the
// sampler's cadence is time nobody observed, not main-thread run time (see PROFILE_UNOBSERVED_DELTA_MS).
export const summarizeProfile = (profile: V8Profile, stalledForMs: number): StackProfile => {
  const framesById = new Map(profile.nodes.map((node) => [node.id, node.callFrame]))
  // The profile's own clock is monotonic (its `startTime` is not an epoch), so the stall is bounded
  // relative to the profile's total duration: the sampler is stopped in the tick that fires when the stall
  // ends, which puts the stall at the tail of the recording.
  const totalUs = profile.timeDeltas.reduce((sum, delta) => sum + (delta ?? 0), 0)
  const fromUs = totalUs - (stalledForMs + PROFILE_WINDOW_SLACK_MS) * 1000
  const counts = new Map<string, number>()
  let mainThreadUs = 0
  let unobservedUs = 0
  let cumulativeUs = 0
  const unobservedFromUs = PROFILE_UNOBSERVED_DELTA_MS * 1000
  for (let index = 0; index < profile.samples.length; index += 1) {
    const deltaUs = profile.timeDeltas[index] ?? 0
    cumulativeUs += deltaUs
    if (cumulativeUs < fromUs) continue
    // A gap wider than the sampler's plausible cadence is time nobody observed: the process was not
    // running. Report it as unobserved instead of crediting it to the main thread.
    if (deltaUs >= unobservedFromUs) {
      unobservedUs += deltaUs
      continue
    }
    mainThreadUs += deltaUs
    const frame = framesById.get(profile.samples[index])
    if (!frame || !isReportableFrame(frame.url, frame.functionName)) continue
    const label = frameLabel(frame.url, frame.functionName, frame.lineNumber)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const frames = [...counts.entries()]
    .map(([frame, samples]) => ({ frame, samples }))
    .sort((left, right) => right.samples - left.samples)
    .slice(0, MAX_REPORTED_FRAMES)
  return {
    mainThreadMs: Math.round(mainThreadUs / 1000),
    unobservedMs: Math.round(unobservedUs / 1000),
    frames
  }
}

const openProfileSession = (): Session | undefined => {
  try {
    const session = new Session()
    session.connect()
    session.post('Profiler.enable')
    session.post('Profiler.setSamplingInterval', { interval: PROFILE_SAMPLING_INTERVAL_US })
    session.post('Profiler.start')
    return session
  } catch {
    // DevTools may already own the debugger, or the runtime may have no inspector: the caller records
    // `unavailable` rather than reporting a stall with no stack as if it had looked.
    return undefined
  }
}

// Sampling profiler on its own inspector session, enabled on demand and stopped as soon as it has served
// its window: a permanently running 1 ms sampler would accumulate samples for the life of the process.
const createV8StackSampler = (): StackSampler | undefined => {
  const session = openProfileSession()
  if (!session) return undefined
  let closed = false
  const disconnect = (): void => {
    if (closed) return
    closed = true
    try {
      session.disconnect()
    } catch {
      // Best effort: a diagnostic must never throw into the caller's tick.
    }
  }

  return {
    stop: (stalledForMs) =>
      new Promise<StackProfile | undefined>((resolve) => {
        try {
          session.post('Profiler.stop', (error, result) => {
            disconnect()
            const profile = (result as { profile?: V8Profile } | undefined)?.profile
            if (error || !profile) {
              resolve(undefined)
              return
            }
            try {
              resolve(summarizeProfile(profile, stalledForMs))
            } catch {
              resolve(undefined)
            }
          })
        } catch {
          disconnect()
          resolve(undefined)
        }
      }),
    cancel: () => {
      if (closed) return
      try {
        session.post('Profiler.stop', () => disconnect())
      } catch {
        disconnect()
      }
    }
  }
}

export const startEventLoopStallWatchdog = (
  input: EventLoopStallWatchdogInput
): EventLoopStallWatchdog => {
  const now = input.now ?? (() => performance.now())
  const wallClock = input.wallClock ?? ((): number => Date.now())
  const cpuUsage = input.cpuUsage ?? ((previous) => process.cpuUsage(previous))
  const machine = input.machine ?? readMachine
  const createSampler = input.createSampler ?? createV8StackSampler
  const createHostSampler = input.createHostSampler ?? (() => createHostStallSampler())
  const tickMs = input.tickMs ?? DEFAULT_TICK_MS
  const thresholdMs = input.thresholdMs ?? DEFAULT_STALL_THRESHOLD_MS
  const profileWindowMs = input.profileWindowMs ?? DEFAULT_PROFILE_WINDOW_MS

  let lastTick = now()
  let lastCpu = cpuUsage()
  let sampler: StackSampler | undefined
  let samplerUnavailable = false
  let hostSampler: HostStallSampler | undefined
  // Armed, not "has a profiler": the two samplers fail independently (DevTools may already own the
  // inspector while the sampler thread works fine), so the window has to be tracked on its own.
  let armed = false
  let windowTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const disarm = (): void => {
    armed = false
    if (windowTimer) {
      clearTimeout(windowTimer)
      windowTimer = undefined
    }
    sampler?.cancel()
    sampler = undefined
    hostSampler?.cancel()
    hostSampler = undefined
  }

  const arm = (): void => {
    if (stopped || armed) return
    armed = true
    const created = createSampler()
    sampler = created
    samplerUnavailable = !created
    // The sampler thread does not depend on the profiler, and it has to be running *before* the next stall
    // begins: sampling only after the fact could never describe the inside of a stall.
    hostSampler = createHostSampler()
    windowTimer = setTimeout(() => {
      // No second stall: stop paying for samples that would only describe ordinary work.
      windowTimer = undefined
      disarm()
    }, profileWindowMs)
    windowTimer.unref?.()
  }

  const report = (record: EventLoopStallRecord): void => {
    try {
      input.log.warn('event loop stalled', record)
    } catch {
      // A diagnostic must never take down the loop it is measuring.
    }
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
    if (lateMs < thresholdMs) return

    const cpuMs = Math.round((cpu.user + cpu.system) / 1000)
    const cpuShare = windowMs > 0 ? Math.min(1, cpuMs / windowMs) : 0
    // The stall ended now: the sampler's timeline is lined up against this instant minus the stall itself.
    const endedAtWall = wallClock()
    const base = {
      ...machine(),
      windowMs,
      lateMs,
      cpuMs,
      cpuShare: Number(cpuShare.toFixed(3)),
      attribution: classify(cpuShare)
    }

    if (!armed) {
      // Arm first: whether the stack can be sampled at all is part of this record, not the next one's.
      arm()
      report({
        ...base,
        stack: samplerUnavailable ? { status: 'unavailable' } : { status: 'no-second-stall' },
        // Whatever the host sampler is going to see, it cannot have seen it yet: it starts now.
        host: hostSampler ? { status: 'window-armed' } : { status: 'unavailable' }
      })
      return
    }

    // Hand the samplers over instead of cancelling them: `disarm()` would close the session and the thread
    // this stop needs.
    armed = false
    if (windowTimer) {
      clearTimeout(windowTimer)
      windowTimer = undefined
    }
    const pending = sampler
    sampler = undefined
    const pendingHost = hostSampler
    hostSampler = undefined
    const hostSlice: Promise<HostStallReading> = pendingHost
      ? pendingHost.stop(endedAtWall - windowMs, endedAtWall)
      : Promise.resolve({ status: 'unavailable' })
    const profileSlice = pending ? pending.stop(windowMs) : Promise.resolve(undefined)
    void Promise.all([profileSlice, hostSlice]).then(([profile, host]) => {
      if (!profile) {
        report({ ...base, stack: { status: 'unavailable' }, host })
        return
      }
      // Main-thread run time is the stricter verdict: `cpuShare` also counts the libuv threadpool and V8
      // helper threads, which can be busy while the main thread itself was never scheduled.
      const mainThreadShare = windowMs > 0 ? Math.min(1, profile.mainThreadMs / windowMs) : 0
      report({
        ...base,
        attribution: classify(mainThreadShare),
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
      disarm()
    }
  }
}
