/**
 * Frame-interval and IPC readings only mean something when the instrument says how many samples it saw and
 * whether the window was producing frames at all. Two defects discovered while reading the v2.23.0 baseline:
 *
 *  · the percentile helper used `floor(n * q)` as the index, which returns the LARGEST value for any sample
 *    count below 20 — a short phase reported its worst single gap as "p95", and 12 IPC samples reported
 *    their max as "p95". A percentile that cannot be told apart from the maximum is not a percentile.
 *  · nothing established that requestAnimationFrame was ticking at a foreground rate, so a window the
 *    compositor was starving looked exactly like a slow application.
 *
 * Both are fixed here, in one place, so the spec that prints the numbers cannot drift away from the rules
 * that decide whether the numbers may be printed at all. Kept out of the spec so the rules get red tests.
 */

export type FrameCadenceVerdict = 'usable' | 'throttled' | 'no-frames'

export type FrameCadenceSummary = {
  readonly verdict: FrameCadenceVerdict
  /** Median idle gap in whole milliseconds, or null when no tick was observed. */
  readonly medianMs: number | null
  /** The cadence a foreground window has to reach for frame numbers to be reportable. */
  readonly budgetMs: number
  readonly detail: string
}

/**
 * A foreground 60 Hz window ticks every ~16.7 ms. 50 fps leaves room for the odd slow tick without calling
 * a healthy window throttled.
 */
export const FOREGROUND_MIN_FPS = 50

/**
 * Below this many samples a percentile is an anecdote: the nearest-rank p95 of 12 samples is the second
 * worst sample, and of 10 samples it is the worst one. Callers get null and say "n/a" instead of a number.
 */
export const MIN_PERCENTILE_SAMPLES = 20

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

/**
 * Nearest-rank percentile (the definition a reader assumes when they see p95). Returns null when there are
 * too few samples to support the claim — never a number derived from a handful of gaps.
 */
export const percentile = (
  values: readonly number[],
  quantile: number,
  minSamples: number = MIN_PERCENTILE_SAMPLES
): number | null => {
  const usable = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)
  if (usable.length === 0 || usable.length < minSamples) return null
  const rank = Math.min(usable.length, Math.max(1, Math.ceil(quantile * usable.length)))
  return usable[rank - 1]!
}

export const summarizeFrameCadence = (
  gapsMs: readonly number[],
  minFps: number = FOREGROUND_MIN_FPS
): FrameCadenceSummary => {
  const budgetMs = 1000 / minFps
  const usable = gapsMs.filter((gap) => Number.isFinite(gap) && gap >= 0)
  if (usable.length === 0) {
    return {
      verdict: 'no-frames',
      medianMs: null,
      budgetMs,
      detail:
        'no requestAnimationFrame ticks were observed — an idle cadence could not be established'
    }
  }
  const middle = Math.round(median(usable))
  if (middle > budgetMs) {
    return {
      verdict: 'throttled',
      medianMs: middle,
      budgetMs,
      detail:
        `idle cadence ${middle}ms is below ${minFps} fps (budget ${Math.round(budgetMs)}ms) — ` +
        'the window is not producing foreground frames, so frame intervals describe the compositor, not the app'
    }
  }
  return {
    verdict: 'usable',
    medianMs: middle,
    budgetMs,
    detail: `idle cadence ${middle}ms is at or above ${minFps} fps — frame intervals describe the app`
  }
}

export type FrameMetricReading = {
  readonly frames: number
  readonly p95Ms: number | null
  readonly maxMs: number
}

/**
 * One line for the harness log. When the instrument is throttled, or the phase produced too few frames, the
 * percentiles are replaced by `n/a` plus the reason: a reading that cannot be acted on must not look like a
 * measurement. The sample count and the maximum are always printed, because those are what tell a paint
 * capacity floor apart from one stall.
 */
export const describeFrameMetric = (
  cadence: FrameCadenceSummary,
  reading: FrameMetricReading
): string => {
  if (cadence.verdict !== 'usable') {
    return `frames=n/a p95=n/a max=n/a (${cadence.verdict}: ${cadence.detail})`
  }
  const samples = `frames=${reading.frames} max=${Math.round(reading.maxMs)}ms`
  if (reading.p95Ms === null) {
    return `${samples} p95=n/a (fewer than ${MIN_PERCENTILE_SAMPLES} samples)`
  }
  return `${samples} p95=${Math.round(reading.p95Ms)}ms`
}
