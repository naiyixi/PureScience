import { Session } from 'node:inspector'

// Everything a stall record needs in order to *name* the code that held the loop: the rules for reading a V8
// CPU profile, and a sampler that is already recording when the stall arrives.
//
// Why the sampler has to be running beforehand: the watchdog used to arm its profiler only after a stall had
// already been reported, so the *first* stall of a burst — consistently the longest one (19.7 s in the
// 2026-10-23 logs) — could never carry a stack. It reported `no-second-stall`, which is honest but useless:
// the one segment worth naming was the one segment nobody could sample.
//
// Why the cadence is coarse (measured 2026-10-25, 8-core machine, ~1.2 s CPU-bound loop, 6 interleaved rounds
// against its own baseline): a permanently recording 1 ms sampler cost +18 % and +23 % of wall time on two
// separate runs — well above this machine's own noise, so it cannot be a default. 20 ms, 50 ms and 100 ms were
// indistinguishable from the baseline (that is the honest reading: below the noise floor, not "free"). 50 ms
// it is: 20 wake-ups/s still names the hot function inside a multi-second block — measured, one 1.1 s block
// produced 17-20 samples all on the blocking function — while asking the sampling thread to wake 20 times a
// second instead of 1000.
const DEFAULT_PRESAMPLE_INTERVAL_US = 50_000
const MAX_REPORTED_FRAMES = 3
// Samples are attributed to the stall that just ended; a little slack absorbs both the tick's own scheduling
// and the coarse cadence (the last pre-stall sample can be a whole interval early).
const PROFILE_WINDOW_SLACK_MS = 50
// The profiler asks for one sample per `intervalUs`, but this runtime delivers them less often than asked; a
// gap of half a second between two samples therefore does not mean "the main thread ran for half a second",
// it means the sampling thread itself was not running (the whole process was stopped). Counting such a gap as
// main-thread run time turns a machine freeze into an accusation of our own code — measured, not theorised:
// a 2 s `SIGSTOP` produced `mainThreadMs 2103` and `cpu-bound-in-process` before this bound existed.
const PROFILE_UNOBSERVED_DELTA_MS = 500

export type StallFrame = { frame: string; samples: number }

export type StackProfile = { mainThreadMs: number; unobservedMs: number; frames: StallFrame[] }

export type V8Profile = {
  startTime: number
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]
  samples: number[]
  timeDeltas: number[]
}

// Frames worth reporting are ours and our dependencies': V8 helper/native frames (empty url), node internals
// and this module's own callback would otherwise win every profile, since the sampler is the busiest JS right
// after a stall. Everything else is kept, including bundled code — in the packaged app every product frame
// looks like `out/main/index.js:<line>` anyway.
const isReportableFrame = (url: string, functionName: string): boolean => {
  if (!url) return false
  if (url.startsWith('node:')) return false
  // Only the watchdog's own files (source and build), not its test: the test holds the loop on purpose and
  // the frame it produces is exactly what proves the sampler works.
  if (/event-loop-stall-watchdog\.(ts|js)(\?|$)/.test(url)) return false
  if (/stall-stack-profile\.(ts|js)(\?|$)/.test(url)) return false
  if (functionName === '(garbage collector)' || functionName === '(program)') return false
  return true
}

const frameLabel = (url: string, functionName: string, lineNumber: number): string => {
  const match = /(?:^|\/)((?:src|out|e2e)\/.*)$/.exec(url)
  const file = match ? match[1] : url.split('/').filter(Boolean).slice(-2).join('/')
  return `${functionName || '(anonymous)'} (${file}:${lineNumber + 1})`
}

// Exported so a test can pin the one rule that has already been wrong once: a delta wider than the sampler's
// cadence is time nobody observed, not main-thread run time (see PROFILE_UNOBSERVED_DELTA_MS).
export const summarizeProfile = (
  profile: V8Profile,
  stalledForMs: number,
  slackMs: number = PROFILE_WINDOW_SLACK_MS
): StackProfile => {
  const framesById = new Map(profile.nodes.map((node) => [node.id, node.callFrame]))
  // The profile's own clock is monotonic (its `startTime` is not an epoch), so the stall is bounded relative
  // to the profile's total duration: the sampler is stopped in the tick that fires when the stall ends, which
  // puts the stall at the tail of the recording.
  const totalUs = profile.timeDeltas.reduce((sum, delta) => sum + (delta ?? 0), 0)
  const fromUs = totalUs - (stalledForMs + slackMs) * 1000
  const counts = new Map<string, number>()
  let mainThreadUs = 0
  let unobservedUs = 0
  let cumulativeUs = 0
  let inWindowSamples = 0
  const unobservedFromUs = PROFILE_UNOBSERVED_DELTA_MS * 1000
  for (let index = 0; index < profile.samples.length; index += 1) {
    const deltaUs = profile.timeDeltas[index] ?? 0
    cumulativeUs += deltaUs
    if (cumulativeUs < fromUs) continue
    inWindowSamples += 1
    // A gap wider than the sampler's plausible cadence is time nobody observed: the process was not running.
    // Report it as unobserved instead of crediting it to the main thread.
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
  // A window with no sample in it says nothing about the window — the V8 sampling thread never got to run.
  // Measured on a Windows CI runner: a 500 ms block came back `profiled` with zero frames and zero unobserved
  // time, which reads exactly like an idle loop. Say `unobserved` for the whole window instead of letting two
  // zeros claim it was seen; the caller can then tell "nobody looked" from "we saw nothing happening".
  if (inWindowSamples === 0) unobservedUs = (stalledForMs + slackMs) * 1000
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

// The slice of `node:inspector` this module needs, so a test can drive the session's answers without a real
// inspector (and without the whole EventEmitter surface a `Session` carries).
export type ProfileSession = {
  post: (
    method: string,
    params?: Record<string, unknown> | ((error: Error | null, result?: unknown) => void),
    callback?: (error: Error | null, result?: unknown) => void
  ) => void
  disconnect: () => void
}

export type RollingStackProfile = {
  // Ends the current segment, answers what it recorded for the trailing `stalledForMs`, and starts a fresh
  // segment. `undefined` means the session could not be read — never "there was nothing to see".
  take: (stalledForMs: number) => Promise<StackProfile | undefined>
  // Ends the current segment and throws it away. A profiler that never dropped its samples would grow for the
  // life of the process (measured: 2,484 samples / 0.1 MB per idle 5 s at 1 ms).
  rotate: () => void
  stop: () => void
}

export type RollingStackProfileInput = {
  intervalUs?: number
  // Seam. Production leaves it alone.
  openSession?: () => ProfileSession | undefined
}

const openInspectorSession = (intervalUs: number): ProfileSession | undefined => {
  try {
    const session = new Session()
    session.connect()
    session.post('Profiler.enable')
    session.post('Profiler.setSamplingInterval', { interval: intervalUs })
    session.post('Profiler.start')
    return session
  } catch {
    // DevTools may already own the debugger, or the runtime may have no inspector: the watchdog records
    // `unavailable` rather than a stall with no stack as if it had looked.
    return undefined
  }
}

export const createRollingStackProfile = (
  input: RollingStackProfileInput = {}
): RollingStackProfile | undefined => {
  const intervalUs = input.intervalUs ?? DEFAULT_PRESAMPLE_INTERVAL_US
  const openSession =
    input.openSession ?? ((): ProfileSession | undefined => openInspectorSession(intervalUs))
  const session = openSession()
  if (!session) return undefined
  let closed = false
  // Inspector `post` calls answer through callbacks and must not interleave: a `start` issued while a `stop`
  // is still in flight would either lose the profile or leave the session recording nothing.
  let chain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work)
    chain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  const stopSegment = (): Promise<V8Profile | undefined> =>
    new Promise<V8Profile | undefined>((resolve) => {
      if (closed) {
        resolve(undefined)
        return
      }
      try {
        session.post('Profiler.stop', (error, result) => {
          if (error) {
            closed = true
            resolve(undefined)
            return
          }
          resolve((result as { profile?: V8Profile } | undefined)?.profile)
        })
      } catch {
        closed = true
        resolve(undefined)
      }
    })

  const startSegment = (): void => {
    if (closed) return
    try {
      session.post('Profiler.start')
    } catch {
      closed = true
    }
  }

  return {
    take: (stalledForMs) =>
      enqueue(async () => {
        const profile = await stopSegment()
        startSegment()
        if (!profile) return undefined
        try {
          // The slack has to cover the cadence: the last sample before the stall can be a whole interval early.
          return summarizeProfile(
            profile,
            stalledForMs,
            Math.max(PROFILE_WINDOW_SLACK_MS, intervalUs / 1000)
          )
        } catch {
          return undefined
        }
      }),
    rotate: () => {
      void enqueue(async () => {
        await stopSegment()
        startSegment()
      })
    },
    stop: () => {
      void enqueue(async () => {
        await stopSegment()
        closed = true
        try {
          session.disconnect()
        } catch {
          // Best effort: a diagnostic must never throw into the caller's teardown.
        }
      })
    }
  }
}
