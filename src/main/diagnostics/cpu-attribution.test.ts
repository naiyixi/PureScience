import { describe, expect, it } from 'vitest'

import {
  attributionSuffix,
  classifyCpuShare,
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

  it('names our own blocking work above the band and descheduling below it', () => {
    expect(classifyCpuShare(0.8, 5_000)).toBe('cpu-bound-in-process')
    expect(classifyCpuShare(0.6, 5_000)).toBe('cpu-bound-in-process')
    expect(classifyCpuShare(0.15, 5_000)).toBe('process-not-scheduled')
    expect(classifyCpuShare(0, 22_763_558)).toBe('process-not-scheduled')
  })

  it('leaves the band between them unresolved instead of forcing a verdict', () => {
    expect(classifyCpuShare(0.3, 5_000)).toBe('inconclusive')
    expect(classifyCpuShare(Number.NaN, 5_000)).toBe('inconclusive')
  })

  it('never calls an instantaneous step "not scheduled"', () => {
    // A zero-length window carries no share to judge; "it returned at once" is the least suspicious shape
    // in the log and must not be reported as a scheduler problem.
    expect(classifyCpuShare(0, 0)).toBe('inconclusive')
  })

  it('only marks the descheduled case in a summary line', () => {
    expect(attributionSuffix('process-not-scheduled')).toBe('(not-scheduled)')
    expect(attributionSuffix('cpu-bound-in-process')).toBe('')
    expect(attributionSuffix('inconclusive')).toBe('')
  })
})
