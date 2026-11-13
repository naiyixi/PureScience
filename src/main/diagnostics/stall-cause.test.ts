import { describe, expect, it } from 'vitest'

import type { GcPauseReading } from './gc-pause-monitor'
import { classifyStallCause, type StallFsReading } from './stall-cause'

const gcMeasured = (pauseMs: number, pauses = 1): GcPauseReading => ({
  status: 'measured',
  pauseMs,
  pauses
})
const gcUnavailable: GcPauseReading = { status: 'unavailable' }
const fsMeasured = (canaryMs: number, inFlight = 0): StallFsReading => ({
  status: 'measured',
  canaryMs,
  inFlight
})
const fsUnavailable: StallFsReading = { status: 'unavailable' }

describe('stall cause', () => {
  it('names a collection only when it is both long enough and a real share of the window', () => {
    expect(
      classifyStallCause({
        lateMs: 900,
        attribution: 'no-cpu-in-process',
        gc: gcMeasured(400, 3),
        fs: fsMeasured(1)
      }).kind
    ).toBe('garbage-collection')
    // 40 ms is under the 50 ms floor: a pause that small cannot account for a visible halt.
    expect(
      classifyStallCause({
        lateMs: 900,
        attribution: 'cpu-bound-in-process',
        gc: gcMeasured(40),
        fs: fsMeasured(1)
      }).kind
    ).toBe('cpu-in-process')
    // Long gate but a small share of a very long window: one 60 ms collection does not explain 900 ms.
    expect(
      classifyStallCause({
        lateMs: 900,
        attribution: 'cpu-bound-in-process',
        gc: gcMeasured(60),
        fs: fsMeasured(1)
      }).kind
    ).toBe('cpu-in-process')
  })

  it('puts the file-system canary above a busy CPU reading', () => {
    // The canary is the only measurement that separates "our thread pool was saturated" from "we were busy
    // computing": when it waited, that is the story even if CPU time was high.
    const cause = classifyStallCause({
      lateMs: 800,
      attribution: 'cpu-bound-in-process',
      gc: gcMeasured(0, 0),
      fs: fsMeasured(250, 4)
    })
    expect(cause.kind).toBe('fs-queue-saturated')
    expect(cause.basis).toContain('fs canary 250 ms')
    expect(cause.fs).toEqual({ status: 'measured', canaryMs: 250, inFlight: 4 })
  })

  it('says a collection first when both instruments would match', () => {
    // A collection burns CPU *and* can leave the pool waiting; naming the more specific one keeps the record
    // from pointing at the thread pool every time the heap grows.
    expect(
      classifyStallCause({
        lateMs: 700,
        attribution: 'cpu-bound-in-process',
        gc: gcMeasured(500, 2),
        fs: fsMeasured(300, 2)
      }).kind
    ).toBe('garbage-collection')
  })

  it('separates "we ruled everything out" from "nothing was measured"', () => {
    const ruledOut = classifyStallCause({
      lateMs: 700,
      attribution: 'no-cpu-in-process',
      gc: gcMeasured(0, 0),
      fs: fsMeasured(1)
    })
    expect(ruledOut.kind).toBe('unexplained')
    expect(ruledOut.basis).toContain('held outside what this process measures')

    const notMeasured = classifyStallCause({
      lateMs: 700,
      attribution: 'no-cpu-in-process',
      gc: gcUnavailable,
      fs: fsUnavailable
    })
    expect(notMeasured.kind).toBe('unmeasured')
    // The absent instruments are named in the sentence, not silently missing from it.
    expect(notMeasured.basis).toContain('gc not observed')
    expect(notMeasured.basis).toContain('fs canary unavailable')
  })

  it('keeps a short canary wait from being called the cause of a long stall', () => {
    // Device distribution: the canary's median during a slow acquire is 24 ms. That says the pool was busy,
    // not that it held a 1.2 s stall — the share gate is what keeps the label from overclaiming. All three
    // cases carry a waiting read, so what moves them is the share gate and not the queueing gate below.
    const shortWait = classifyStallCause({
      lateMs: 1_200,
      attribution: 'no-cpu-in-process',
      gc: gcMeasured(0, 0),
      fs: fsMeasured(24, 2)
    })
    expect(shortWait.kind).toBe('unexplained')

    // Same 24 ms against a 200 ms window is a real share of it.
    expect(
      classifyStallCause({
        lateMs: 200,
        attribution: 'no-cpu-in-process',
        gc: gcMeasured(0, 0),
        fs: fsMeasured(24, 2)
      }).kind
    ).toBe('fs-queue-saturated')

    // Under the 20 ms floor the pool was idle, whatever the window is.
    expect(
      classifyStallCause({
        lateMs: 100,
        attribution: 'no-cpu-in-process',
        gc: gcMeasured(0, 0),
        fs: fsMeasured(5, 2)
      }).kind
    ).toBe('unexplained')
  })

  it('refuses the pool verdict when nothing of ours was waiting on it', () => {
    // The shape six days of packaged-build logs produced 3,436 times: a canary that outlived the stall by an
    // order of magnitude while `inFlight` was 0. The canary's callback is a loop callback, so that wait is the
    // loop being gone — not the thread pool being busy. Naming the pool here sends the next reader to the wrong
    // subsystem, which is the failure this record exists to prevent. Numbers below are a real log record.
    const cause = classifyStallCause({
      lateMs: 507,
      attribution: 'no-cpu-in-process',
      gc: gcMeasured(0, 0),
      fs: fsMeasured(5_826, 0)
    })
    expect(cause.kind).toBe('unexplained')
    expect(cause.basis).toContain('nothing of ours queued')
    expect(cause.basis).toContain('waited on a loop that was gone')
    // The measurement stays in the record: a refused verdict is not a missing one.
    expect(cause.fs).toEqual({ status: 'measured', canaryMs: 5_826, inFlight: 0 })
  })

  it('still names the pool when a read of ours was waiting behind it', () => {
    // The other direction, so the gate cannot be satisfied by simply never naming the pool. 24 of the logged
    // stalls did carry a waiting read (`inFlight` 1–3); those are the ones where the label is the finding.
    const cause = classifyStallCause({
      lateMs: 800,
      attribution: 'no-cpu-in-process',
      gc: gcMeasured(0, 0),
      fs: fsMeasured(250, 1)
    })
    expect(cause.kind).toBe('fs-queue-saturated')
    expect(cause.basis).toContain('1 of our reads waiting')
  })

  it('keeps a single missing instrument from being read as a calm one', () => {
    // GC observed and quiet, fs unavailable: one of the two instruments never ran, so the record cannot say
    // the window was explained — that is `unmeasured`, not `unexplained`.
    expect(
      classifyStallCause({
        lateMs: 700,
        attribution: 'no-cpu-in-process',
        gc: gcMeasured(0, 0),
        fs: fsUnavailable
      }).kind
    ).toBe('unmeasured')
  })

  it('carries the numbers behind the verdict', () => {
    const cause = classifyStallCause({
      lateMs: 1_200,
      attribution: 'no-cpu-in-process',
      gc: gcMeasured(900, 4),
      fs: fsMeasured(2)
    })
    expect(cause).toMatchObject({
      kind: 'garbage-collection',
      gc: { status: 'measured', pauseMs: 900, pauses: 4 },
      fs: { status: 'measured', canaryMs: 2, inFlight: 0 }
    })
    expect(cause.basis).toContain('gc 900 ms in 4 pause(s) of 1200 ms late')
  })

  // The sampler thread shares the process, so a hole in its timeline as wide as the stall is the one reading
  // that rules app code out. Measured on the shipped 2.26.0 log: 120 of 659 records have that shape (their host
  // gaps run from 666 ms to 1,073 s), and today 11 of them are labelled `cpu-in-process` — an artefact, because
  // the CPU was not being spent by a running thread either.
  it('rules app code out when no thread of the process ran, ahead of GC and CPU', () => {
    const cause = classifyStallCause({
      lateMs: 1_000,
      attribution: 'cpu-bound-in-process',
      gc: gcMeasured(900, 5),
      fs: fsMeasured(1),
      host: {
        status: 'sampled',
        continuity: 'gapped',
        maxGapMs: 1_000,
        samples: 0,
        expectedSamples: 4
      }
    })
    expect(cause.kind).toBe('process-frozen')
    expect(cause.basis).toContain('no thread of this process ran for 1000 of 1000 ms late')
    expect(cause.basis).toContain('not to app code')
    // The instruments are still reported: a reader has to be able to check the verdict against the numbers.
    expect(cause.gc).toEqual({ status: 'measured', pauseMs: 900, pauses: 5 })
  })

  it('does not call a partially sampled window frozen', () => {
    // A sampler that kept ticking (or missed only part of the window) describes a running process: the loop was
    // held by something inside it, and the other instruments get to decide.
    const partial = classifyStallCause({
      lateMs: 1_000,
      attribution: 'no-cpu-in-process',
      gc: gcMeasured(0, 0),
      fs: fsMeasured(1),
      host: {
        status: 'sampled',
        continuity: 'gapped',
        maxGapMs: 400,
        samples: 3,
        expectedSamples: 4
      }
    })
    expect(partial.kind).toBe('unexplained')
    const kept = classifyStallCause({
      lateMs: 1_000,
      attribution: 'no-cpu-in-process',
      gc: gcMeasured(0, 0),
      fs: fsMeasured(1),
      host: { status: 'sampled', continuity: 'kept-sampling', samples: 4, expectedSamples: 4 }
    })
    expect(kept.kind).toBe('unexplained')
  })

  it('names the canary failure in the sentence a reader sees', () => {
    const cause = classifyStallCause({
      lateMs: 700,
      attribution: 'no-cpu-in-process',
      gc: gcMeasured(0, 0),
      fs: { status: 'unavailable', reason: 'missing' }
    })
    expect(cause.basis).toContain('fs canary unavailable (missing)')
  })
})
