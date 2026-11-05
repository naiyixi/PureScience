import { describe, expect, it } from 'vitest'
import {
  FOREGROUND_MIN_FPS,
  MIN_PERCENTILE_SAMPLES,
  describeFrameMetric,
  percentile,
  summarizeFrameCadence,
  type FrameCadenceSummary
} from './perf-frame-cadence'

const cadence = (gapMs: number, count = 60): number[] =>
  Array.from({ length: count }, (_, index) => (index % 7 === 3 ? gapMs * 3 : gapMs))

/** The formula this module replaced, kept here so the defect it caused stays reproducible. */
const previousP95Index = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
}

describe('percentile', () => {
  it('returns null instead of the maximum when there are too few samples', () => {
    // Four frames is what a short phase produces; the old formula called the worst gap "p95".
    expect(previousP95Index([16, 17, 18, 120])).toBe(120)
    expect(percentile([16, 17, 18, 120], 0.95)).toBeNull()
    expect(MIN_PERCENTILE_SAMPLES).toBeGreaterThan(4)
  })

  it('is not the maximum even at the sample floor', () => {
    const gaps = Array.from({ length: 20 }, (_, index) => index + 1)
    expect(previousP95Index(gaps)).toBe(20)
    expect(percentile(gaps, 0.95)).toBe(19)
    expect(percentile(gaps, 0.95)).not.toBe(20)
  })

  it('computes the median with a plain nearest-rank p50', () => {
    expect(
      percentile(
        Array.from({ length: 21 }, (_, index) => index + 1),
        0.5
      )
    ).toBe(11)
  })

  it('ignores non-finite samples but still counts the rest', () => {
    const gaps = [...Array.from({ length: 20 }, (_, index) => index + 1), Number.NaN]
    expect(percentile(gaps, 0.95)).toBe(19)
  })

  it('honours an explicit sample floor', () => {
    const gaps = Array.from({ length: 12 }, (_, index) => index + 1)
    expect(percentile(gaps, 0.95)).toBeNull()
    expect(percentile(gaps, 0.95, 10)).toBe(12)
  })
})

describe('summarizeFrameCadence', () => {
  it('calls a 60 Hz idle cadence usable', () => {
    const summary = summarizeFrameCadence(cadence(16.7))
    expect(summary.verdict).toBe('usable')
    expect(summary.medianMs).toBe(17)
    expect(summary.budgetMs).toBeCloseTo(1000 / FOREGROUND_MIN_FPS)
  })

  it('calls a cadence far below the budget throttled, not slow', () => {
    const summary = summarizeFrameCadence(cadence(81))
    expect(summary.verdict).toBe('throttled')
    expect(summary.medianMs).toBe(81)
    expect(summary.detail).toContain('not producing foreground frames')
    expect(summary.detail).toContain('81ms')
  })

  it('reports no reading rather than 0 ms when no tick was observed', () => {
    const summary = summarizeFrameCadence([])
    expect(summary.verdict).toBe('no-frames')
    expect(summary.medianMs).toBeNull()
    expect(summary.detail).toContain('no requestAnimationFrame ticks')
  })

  it('ignores non-finite and negative gaps instead of averaging them in', () => {
    const summary = summarizeFrameCadence([Number.NaN, -5, 16, 17, 16, Number.POSITIVE_INFINITY])
    expect(summary.verdict).toBe('usable')
    expect(summary.medianMs).toBe(16)
  })

  it('treats a cadence exactly on the budget as usable', () => {
    expect(summarizeFrameCadence(cadence(20)).verdict).toBe('usable')
    expect(summarizeFrameCadence(cadence(21)).verdict).toBe('throttled')
  })

  it('honours an explicit minFps', () => {
    expect(summarizeFrameCadence(cadence(30), 24).verdict).toBe('usable')
    expect(summarizeFrameCadence(cadence(30), 60).verdict).toBe('throttled')
  })
})

describe('describeFrameMetric', () => {
  const usable = (): FrameCadenceSummary => summarizeFrameCadence(cadence(16.7))

  it('prints the sample count, the maximum and the percentile', () => {
    expect(describeFrameMetric(usable(), { frames: 120, p95Ms: 24, maxMs: 41.4 })).toBe(
      'frames=120 max=41ms p95=24ms'
    )
  })

  it('withholds the percentile when the phase produced too few frames, but keeps n and the maximum', () => {
    const line = describeFrameMetric(usable(), { frames: 8, p95Ms: null, maxMs: 120 })
    expect(line).toBe(`frames=8 max=120ms p95=n/a (fewer than ${MIN_PERCENTILE_SAMPLES} samples)`)
  })

  it('never prints a frame number when the window is throttled', () => {
    const line = describeFrameMetric(summarizeFrameCadence(cadence(81)), {
      frames: 120,
      p95Ms: 24,
      maxMs: 41.4
    })
    expect(line).toContain('frames=n/a')
    expect(line).toContain('p95=n/a')
    expect(line).not.toContain('24')
    expect(line).not.toContain('41')
  })

  it('keeps the same refusal for a run that saw no frames at all', () => {
    const empty: FrameCadenceSummary = summarizeFrameCadence([])
    expect(describeFrameMetric(empty, { frames: 0, p95Ms: null, maxMs: 0 })).toContain('frames=n/a')
  })
})
