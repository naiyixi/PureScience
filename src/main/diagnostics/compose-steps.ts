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

export type ComposeStepOutcome = 'ok' | 'failed'

export type ComposeStep = Readonly<{
  name: string
  durationMs: number
  outcome: ComposeStepOutcome
}>

/** One recorded step plus what the process spent of it. Kept internal: `steps()` stays the public shape. */
type TimedStep = ComposeStep &
  Readonly<{ cpuMs: number; cpuShare: number; attribution: ActivityAttribution }>

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
  /** Every step recorded so far, slowest first. */
  steps: () => ComposeStep[]
  /** Wall time from the first step to the last completion. */
  totalMs: () => number
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
      recorded.push({
        name,
        durationMs,
        outcome: 'ok',
        cpuMs,
        cpuShare: Number(cpuShare.toFixed(3)),
        attribution
      })
      if (durationMs >= slowMs) {
        options.log.warn(messages.slow, {
          step: name,
          durationMs: Math.round(durationMs),
          cpuMs,
          cpuShare: Number(cpuShare.toFixed(3)),
          attribution
        })
      }
      return value
    } catch (error) {
      const durationMs = Math.max(0, now() - stepStart)
      endedAt = now()
      const cpuMs = cpuMillisecondsBetween(cpuStart, cpuUsage())
      const cpuShare = cpuShareOf(cpuMs, durationMs)
      const attribution = classifyCpuShare(cpuShare, durationMs)
      recorded.push({
        name,
        durationMs,
        outcome: 'failed',
        cpuMs,
        cpuShare: Number(cpuShare.toFixed(3)),
        attribution
      })
      options.log.error(messages.failed, {
        step: name,
        durationMs: Math.round(durationMs),
        cpuMs,
        cpuShare: Number(cpuShare.toFixed(3)),
        attribution,
        ...diagnosticErrorFields(error)
      })
      throw error
    }
  }

  return {
    step,
    steps: (): ComposeStep[] =>
      [...recorded]
        .sort((left, right) => right.durationMs - left.durationMs)
        .map(({ name, durationMs, outcome }) => ({ name, durationMs, outcome })),
    totalMs: (): number =>
      startedAt === undefined || endedAt === undefined ? 0 : Math.max(0, endedAt - startedAt),
    logSummary: (): void => {
      const slowest = [...recorded]
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, summarySize)
        .map(
          (entry) =>
            `${entry.name}=${Math.round(entry.durationMs)}ms${
              entry.outcome === 'failed' ? '(failed)' : ''
            }${attributionSuffix(entry.attribution)}`
        )
      options.log.info(messages.summary, {
        totalMs: Math.round(
          startedAt === undefined || endedAt === undefined ? 0 : Math.max(0, endedAt - startedAt)
        ),
        stepCount: recorded.length,
        slowest: slowest.join(' ')
      })
    }
  }
}
