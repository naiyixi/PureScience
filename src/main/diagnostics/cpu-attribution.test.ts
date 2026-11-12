import { describe, expect, it } from 'vitest'

import {
  attributionForWindow,
  attributionSuffix,
  classifyCpuShare,
  cpuAttributionFields,
  cpuExceedsWindow,
  cpuMillisecondsBetween,
  cpuShareOf
} from './cpu-attribution'

const sample = (userMs: number, systemMs = 0): { user: number; system: number } => ({
  user: userMs * 1000,
  system: systemMs * 1000
})

describe('cpu attribution', () => {
  it('turns two process samples into the CPU actually spent between them', () => {
    expect(cpuMillisecondsBetween(sample(100), sample(250, 50))).toBe(200)
    // `process.cpuUsage()` is monotonic; a shrinking reading is not a negative cost.
    expect(cpuMillisecondsBetween(sample(500), sample(100))).toBe(0)
  })

  it('reports a share of the window, clamped and zero for a window of no length', () => {
    expect(cpuShareOf(500, 1_000)).toBe(0.5)
    expect(cpuShareOf(2_000, 1_000)).toBe(1)
    expect(cpuShareOf(-5, 1_000)).toBe(0)
    expect(cpuShareOf(0, 0)).toBe(0)
  })

  it('names our own blocking work above the band and the absence of CPU below it', () => {
    expect(classifyCpuShare(0.8, 5_000)).toBe('cpu-bound-in-process')
    expect(classifyCpuShare(0.6, 5_000)).toBe('cpu-bound-in-process')
    expect(classifyCpuShare(0.15, 5_000)).toBe('no-cpu-in-process')
    expect(classifyCpuShare(0, 22_763_558)).toBe('no-cpu-in-process')
  })

  it('leaves the band between them unresolved instead of forcing a verdict', () => {
    expect(classifyCpuShare(0.3, 5_000)).toBe('inconclusive')
    expect(classifyCpuShare(Number.NaN, 5_000)).toBe('inconclusive')
  })

  it('leaves an instantaneous step unresolved rather than reading it as a scheduler problem', () => {
    // A zero-length window carries no share to judge; "it returned at once" is the least suspicious shape
    // in the log and must not be reported as a scheduler problem.
    expect(classifyCpuShare(0, 0)).toBe('inconclusive')
  })

  it('only marks the low band in a summary line', () => {
    expect(attributionSuffix('no-cpu-in-process')).toBe('(no-cpu)')
    expect(attributionSuffix('cpu-bound-in-process')).toBe('')
    expect(attributionSuffix('inconclusive')).toBe('')
  })

  it('names the low band for what was measured, not for a cause CPU sampling cannot see', () => {
    // The band is reached by a descheduled process AND by a handler awaiting a remote read (the application
    // command router awaits the engine and the network), so the name must not assert either. This pin exists
    // because the literal it replaced — `process-not-scheduled` — turned every awaited call into a machine
    // fault and sent the next investigation to the scheduler.
    const lowBand: string = classifyCpuShare(0, 5_000)
    expect(lowBand).toBe('no-cpu-in-process')
    expect(lowBand).not.toMatch(/schedul/)
  })

  it('computes the three fields a slow line carries from two samples of one window', () => {
    // The helper exists so the ten call sites cannot drift in rounding. Microseconds in, milliseconds out, and
    // the share is rounded to three places because a log line is read by a person, not compared to a threshold.
    expect(cpuAttributionFields({ user: 0, system: 0 }, { user: 826_400, system: 0 }, 900)).toEqual(
      {
        cpuMs: 826,
        cpuShare: 0.918,
        attribution: 'cpu-bound-in-process'
      }
    )
    // A window where the process consumed nothing at all is the 6.3-hour case: 22.7 million ms of wall time.
    expect(
      cpuAttributionFields({ user: 0, system: 0 }, { user: 13_000, system: 0 }, 3_065)
    ).toEqual({ cpuMs: 13, cpuShare: 0.004, attribution: 'no-cpu-in-process' })
  })

  it('keeps a zero-length window without a verdict, and never divides by it', () => {
    expect(cpuAttributionFields({ user: 5_000, system: 0 }, { user: 9_000, system: 0 }, 0)).toEqual(
      {
        cpuMs: 4,
        cpuShare: 0,
        attribution: 'inconclusive'
      }
    )
  })

  it('refuses to call a window ours when the process counter outran the window itself', () => {
    // `process.cpuUsage()` counts every thread. A reading above the window's own length therefore proves
    // some of that CPU was not this call's — and the clamped share (1) cannot tell "we filled the window"
    // from "other threads worked while this call waited". Measured in the packaged log (2026-11-12):
    // 1,140 of 6,384 slow IPC rows are in this shape, and all of them read `cpu-bound-in-process`.
    expect(attributionForWindow(26_928, 20_005)).toBe('inconclusive')
    expect(attributionForWindow(1_149, 1_024)).toBe('inconclusive')
    // Exactly filling the window is the honest top of the scale: every millisecond was CPU here.
    expect(attributionForWindow(1_000, 1_000)).toBe('cpu-bound-in-process')
    // One millisecond of slack, because the counter is rounded to whole milliseconds: a serial handler
    // that filled its window can land just above it, and that is not evidence of another thread.
    expect(attributionForWindow(1_001, 1_000)).toBe('cpu-bound-in-process')
    expect(cpuExceedsWindow(1_000, 1_000)).toBe(false)
    expect(cpuExceedsWindow(1_001, 1_000)).toBe(false)
    expect(cpuExceedsWindow(1_002, 1_000)).toBe(true)
    // Below the window the bands are unchanged, so ordinary lines keep the vocabulary they had.
    expect(attributionForWindow(826, 900)).toBe('cpu-bound-in-process')
    expect(attributionForWindow(13, 3_065)).toBe('no-cpu-in-process')
  })

  it('marks the exceeding case by name, and leaves the ordinary line without the marker', () => {
    // Withholding a verdict silently is what made the old `inconclusive` band unreadable: the marker is
    // the only field that says the ratio was not a share of the window.
    expect(
      cpuAttributionFields({ user: 0, system: 0 }, { user: 26_928_000, system: 0 }, 20_005)
    ).toEqual({
      cpuMs: 26_928,
      cpuShare: 1,
      attribution: 'inconclusive',
      cpuExceedsWindow: true
    })
    const ordinary = cpuAttributionFields({ user: 0, system: 0 }, { user: 826_400, system: 0 }, 900)
    expect(ordinary).not.toHaveProperty('cpuExceedsWindow')
    expect(ordinary.attribution).toBe('cpu-bound-in-process')
  })
})
