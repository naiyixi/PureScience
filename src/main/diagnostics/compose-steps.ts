// Per-step attribution for application composition (v2.0.0 P0-3).
//
// Real evidence, 2026-10-10: the packaged app logged `compose-runtime` at 11:51:31.445 and the next
// line, `storage/data root resolved`, at 11:51:57.083 — 25.6 seconds with NOTHING in between, so the
// startup gap could be neither explained nor fixed. The distribution over 137 startups (min 0.6 s,
// median 12.5 s, p90 61.5 s, and both 1.0 s and 26.4 s for the SAME version and data root) says the cost
// is dominated by machine-side conditions — which is exactly why the missing half is attribution: a
// number that moves between runs is only actionable once the step that produced it is named.
//
// So every awaited composition step is timed. A slow step logs its own line (so a slow startup names its
// culprit), a failing step logs with the failure's category, and the caller logs ONE summary line: a
// healthy startup stays at one line, while a slow one is attributable without a profiler.

import { diagnosticErrorFields } from '../logger'
import {
  attributionSuffix,
  classifyCpuShare,
  cpuMillisecondsBetween,
  cpuShareOf,
  type ActivityAttribution,
  type CpuUsageSample
} from './cpu-attribution'
import {
  heldSplitForMonotonicWindow,
  sharedLoopHeldWindows,
  type HeldReading,
  type HeldSplitSource
} from './loop-held-windows'

export type ComposeStepOutcome = 'ok' | 'failed'

export type ComposeStep = Readonly<{
  name: string
  durationMs: number
  outcome: ComposeStepOutcome
}>

/** One recorded step plus what the process spent of it. Kept internal: `steps()` stays the public shape. */
type TimedStep = ComposeStep &
  Readonly<{
    cpuMs: number
    cpuShare: number
    attribution: ActivityAttribution
    /** Present only when part of the step fell inside a recorded stall. */
    heldMs?: number
    /** Present only when the stall ring no longer covers this span — see `HeldUnsplittable`. */
    heldUnmeasured?: 'windows-dropped'
  }>

/**
 * One step as an artifact carries it: the same fields the slow line prints, so a support bundle and the log
 * cannot describe the same step differently.
 */
export type ComposeStepSnapshot = Readonly<{
  name: string
  durationMs: number
  outcome: ComposeStepOutcome
  cpuMs: number
  cpuShare: number
  attribution: ActivityAttribution
  /** Present only when part of this step fell inside a recorded stall. */
  heldMs?: number
  /**
   * Present only when the stall ring no longer covers this step's span (it dropped the oldest windows). The
   * step then carries no `heldMs` and contributes nothing to the window's `heldMs` total: not measured is not
   * the same answer as zero, and this marker is what keeps them apart in the archive.
   */
  heldUnmeasured?: 'windows-dropped'
}>

/**
 * The window as a whole. `totalMs` is wall time from the first step's start to the last step's end;
 * `stepMs` is what the named steps cover, and `gapMs` is the remainder — the synchronous code and module
 * init between steps, which no step can name. Without that third number a reader subtracts the steps from
 * the total and gets a phantom "unattributed" block (this repository really did spend a round on that
 * difference, see `docs/evidence/2026-10-26-startup-attribution-closed.md`).
 *
 * `gapMs` is defined as the remainder (`totalMs - stepMs`, floored at 0) rather than measured separately, so
 * the three numbers always add up exactly even after rounding. `heldMs` is a per-step total and therefore
 * says nothing about time between steps.
 */
export type ComposeStepsSnapshot = Readonly<{
  totalMs: number
  stepMs: number
  gapMs: number
  heldMs?: number
  steps: ComposeStepSnapshot[]
}>

export type ComposeStepLogger = {
  info: (message: string, metadata: Record<string, unknown>) => void
  warn: (message: string, metadata: Record<string, unknown>) => void
  error: (message: string, metadata: Record<string, unknown>) => void
}

/**
 * Line names for the three records the recorder can emit. Defaults are the startup-composition
 * vocabulary; a second caller (settings preflight) names its own so one grep answers one question.
 */
export type ComposeStepMessages = {
  slow: string
  failed: string
  summary: string
}

export type ComposeStepRecorderOptions = {
  log: ComposeStepLogger
  /** Injectable clock so the recorder is testable without waiting on real time. */
  now?: () => number
  /**
   * Injectable process CPU source. A duration alone cannot separate our own blocking work from a window this
   * process spent no CPU on (descheduled, awaiting something outside, or running on another thread) — the same
   * machine logged a compose step at 22,763,287 ms whose CPU share was 0 (see `cpu-attribution`), so every slow
   * line now carries both halves.
   */
  cpuUsage?: () => CpuUsageSample
  /**
   * Injectable loop-held window source, for the same reason `now` and `cpuUsage` are: the split has to be
   * provable without the process actually freezing. Defaults to the windows the stall watchdog records.
   */
  heldWindows?: HeldSplitSource
  /** A step at or above this duration logs its own `slow` line. */
  slowMs?: number
  /** How many slowest steps the summary keeps. */
  summarySize?: number
  /** Line names. Omitted = the startup-composition defaults, unchanged. */
  messages?: ComposeStepMessages
}

export type ComposeStepRecorder = {
  /** Times one composition step. Rethrows failures after recording them. */
  step: <T>(name: string, run: () => Promise<T> | T) => Promise<T>
  /** Wall time from the first step to the last completion. */
  totalMs: () => number
  /**
   * The window and its steps as one artifact. The same values the summary line logs — computed once here so a
   * support bundle and that line cannot disagree, and so the total, the covered part and the gap always add up.
   */
  snapshot: () => ComposeStepsSnapshot
  /** Logs the one-line summary (called by the caller where the window closes). */
  logSummary: () => void
}

const DEFAULT_SLOW_MS = 250
const DEFAULT_SUMMARY_SIZE = 6
const DEFAULT_MESSAGES: ComposeStepMessages = {
  slow: 'compose step slow',
  failed: 'compose step failed',
  summary: 'compose runtime steps'
}

export const createComposeStepRecorder = (
  options: ComposeStepRecorderOptions
): ComposeStepRecorder => {
  const now = options.now ?? ((): number => performance.now())
  const cpuUsage = options.cpuUsage ?? ((): CpuUsageSample => process.cpuUsage())
  const slowMs = options.slowMs ?? DEFAULT_SLOW_MS
  const summarySize = options.summarySize ?? DEFAULT_SUMMARY_SIZE
  const messages = options.messages ?? DEFAULT_MESSAGES
  const heldWindows = options.heldWindows ?? sharedLoopHeldWindows
  // The recorded entry keeps the same reading the slow line prints: a split when there is one, the named
  // marker when the ring cannot answer, and neither when the loop was free.
  const heldFields = (
    held: HeldReading | undefined
  ): { heldMs?: number; heldUnmeasured?: 'windows-dropped' } =>
    held === undefined
      ? {}
      : 'heldMs' in held
        ? { heldMs: held.heldMs }
        : { heldUnmeasured: held.heldUnmeasured }

  const recorded: TimedStep[] = []
  let startedAt: number | undefined
  let endedAt: number | undefined

  const step = async <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
    const stepStart = now()
    const cpuStart = cpuUsage()
    startedAt ??= stepStart
    try {
      const value = await run()
      const durationMs = Math.max(0, now() - stepStart)
      endedAt = now()
      const cpuMs = cpuMillisecondsBetween(cpuStart, cpuUsage())
      const cpuShare = cpuShareOf(cpuMs, durationMs)
      const attribution = classifyCpuShare(cpuShare, durationMs)
      // Computed once, so the slow line, the recorded entry and the summary total cannot disagree about the
      // same step.
      const held = heldSplitForMonotonicWindow(
        stepStart,
        stepStart + durationMs,
        durationMs,
        heldWindows
      )
      recorded.push({
        name,
        durationMs,
        outcome: 'ok',
        cpuMs,
        cpuShare: Number(cpuShare.toFixed(3)),
        attribution,
        ...heldFields(held)
      })
      if (durationMs >= slowMs) {
        options.log.warn(messages.slow, {
          step: name,
          durationMs: Math.round(durationMs),
          cpuMs,
          cpuShare: Number(cpuShare.toFixed(3)),
          attribution,
          // Present only when part of this step fell inside a loop-held window: a startup step that looked
          // slow because the process was not running must not read like one that did work for that long.
          ...(held ?? {})
        })
      }
      return value
    } catch (error) {
      const durationMs = Math.max(0, now() - stepStart)
      endedAt = now()
      const cpuMs = cpuMillisecondsBetween(cpuStart, cpuUsage())
      const cpuShare = cpuShareOf(cpuMs, durationMs)
      const attribution = classifyCpuShare(cpuShare, durationMs)
      const held = heldSplitForMonotonicWindow(
        stepStart,
        stepStart + durationMs,
        durationMs,
        heldWindows
      )
      recorded.push({
        name,
        durationMs,
        outcome: 'failed',
        cpuMs,
        cpuShare: Number(cpuShare.toFixed(3)),
        attribution,
        ...heldFields(held)
      })
      options.log.error(messages.failed, {
        step: name,
        durationMs: Math.round(durationMs),
        cpuMs,
        cpuShare: Number(cpuShare.toFixed(3)),
        attribution,
        // The failure branch carries the same split: a step that failed after being suspended must not be
        // read as a step that spent that time failing.
        ...(held ?? {}),
        ...diagnosticErrorFields(error)
      })
      throw error
    }
  }

  const snapshot = (): ComposeStepsSnapshot => {
    const totalMs = Math.round(
      startedAt === undefined || endedAt === undefined ? 0 : Math.max(0, endedAt - startedAt)
    )
    const steps: ComposeStepSnapshot[] = recorded.map((entry) => ({
      name: entry.name,
      durationMs: Math.round(entry.durationMs),
      outcome: entry.outcome,
      cpuMs: entry.cpuMs,
      cpuShare: entry.cpuShare,
      attribution: entry.attribution,
      ...(entry.heldMs === undefined ? {} : { heldMs: Math.round(entry.heldMs) }),
      ...(entry.heldUnmeasured === undefined ? {} : { heldUnmeasured: entry.heldUnmeasured })
    }))
    const stepMs = steps.reduce((total, entry) => total + entry.durationMs, 0)
    const heldMs = recorded.reduce((total, entry) => total + (entry.heldMs ?? 0), 0)
    return {
      totalMs,
      stepMs,
      // The remainder, not a second measurement: `totalMs = stepMs + gapMs` must hold exactly after rounding,
      // or the next reader finds a millisecond-sized "unattributed" block and starts investigating it.
      gapMs: Math.max(0, totalMs - stepMs),
      ...(heldMs > 0 ? { heldMs: Math.round(heldMs) } : {}),
      steps
    }
  }

  return {
    step,
    totalMs: (): number =>
      startedAt === undefined || endedAt === undefined ? 0 : Math.max(0, endedAt - startedAt),
    snapshot,
    logSummary: (): void => {
      // One reading feeds both this line and the support bundle: the total, the covered part and the gap are
      // the same three numbers there, so the two can never tell different stories about one startup.
      const { totalMs, stepMs, gapMs, heldMs, steps } = snapshot()
      // Rank by the time the STEP ITSELF used, not by the wall time it occupied. A step caught inside a
      // loop-held window is the longest wall time in the run while having done none of it — measured on this
      // machine: 22,763,287 ms with a 0 cpu share (see `cpu-attribution`) — so ranked by wall time it takes a
      // slot away from a step that really spent the window, and the line then answers "who cost us" with a
      // list of steps that were merely parked.
      //
      // Two lists, because re-ranking alone would leave `stepMs` unexplainable: the parked step's wall time is
      // still inside `stepMs` (it sums durations), so it has to be nameable from this same line or the next
      // reader finds millions of milliseconds covered by no entry. Entries keep printing the wall time — the
      // number every other record calls `durationMs` — followed by the held part, so `wall = own + held` is
      // readable without opening another line.
      const ownMs = (entry: ComposeStepSnapshot): number =>
        Math.max(0, entry.durationMs - (entry.heldMs ?? 0))
      const format = (entry: ComposeStepSnapshot): string =>
        `${entry.name}=${entry.durationMs}ms${entry.outcome === 'failed' ? '(failed)' : ''}${attributionSuffix(
          entry.attribution
        )}${entry.heldMs === undefined ? '' : `(held ${entry.heldMs}ms)`}`
      const byOwnTime = steps
        .map((entry, index) => ({ entry, index }))
        .sort(
          (left, right) =>
            ownMs(right.entry) - ownMs(left.entry) ||
            // A run in which nothing was measured as parked keeps wall-time order (and was never held).
            right.entry.durationMs - left.entry.durationMs ||
            left.index - right.index
        )
      const slowest = byOwnTime.slice(0, summarySize).map(({ entry }) => format(entry))
      // Ranked by the part nothing of this step ran in. The same entry can appear in both lists — a step can
      // be both expensive and partly parked — and a step that is entirely parked appears here even when its
      // own time keeps it out of `slowest`.
      const suspended = steps
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => (entry.heldMs ?? 0) > 0)
        .sort(
          (left, right) =>
            (right.entry.heldMs ?? 0) - (left.entry.heldMs ?? 0) || left.index - right.index
        )
        .slice(0, summarySize)
        .map(({ entry }) => format(entry))
      options.log.info(messages.summary, {
        totalMs,
        stepCount: steps.length,
        // Only when some step was actually held: an ordinary run's summary keeps its existing shape.
        ...(heldMs === undefined ? {} : { heldMs }),
        // Present only when the window holds time no step covers: a run whose steps tile the window keeps its
        // old shape, and a reader is never handed a zero to interpret.
        ...(gapMs > 0 ? { stepMs, gapMs } : {}),
        slowest: slowest.join(' '),
        // Absent when no step had a held part at all, so an ordinary startup's line keeps its old shape.
        ...(suspended.length === 0 ? {} : { suspended: suspended.join(' ') })
      })
    }
  }
}
