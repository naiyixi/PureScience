// One named verdict per stall, built from three measurements that are taken anyway: the CPU this process
// burned (`cpu-attribution`), the garbage pauses V8 reported inside the window (`gc-pause-monitor`), and
// whether the shared file-system pool was saturated at the moment the loop came back (`fs-queue-probe`, the
// same canary the preview-acquire path already uses).
//
// The point is not a nicer word for `no-cpu-in-process`. Six days of packaged-build logs (24 stall records)
// answered that for every stall in the low band, and the reading is honest but useless: it cannot separate a
// stop-the-world collection, a saturated thread pool, and a descheduled process. Whoever reads it next has to
// redo the investigation. So each record now carries the components *and* the sentence that decided it — a
// reader can check the verdict against the numbers instead of trusting a label.
//
// Two kinds are deliberately not verdicts: `unexplained` means every instrument ran and none of them accounts
// for the window (the loop was held by something this process cannot see — the scheduler, paging, another
// process); `unmeasured` means an instrument was absent, so nothing was ruled out. Collapsing those into one
// word is how "nobody was watching" starts reading like "the machine was fine".

import type { ActivityAttribution } from './cpu-attribution'
import type { GcPauseReading } from './gc-pause-monitor'

export type StallCauseKind =
  'garbage-collection' | 'fs-queue-saturated' | 'cpu-in-process' | 'unexplained' | 'unmeasured'

/** The fs reading taken at the instant the stall ended: a canary read and what was already in flight. */
export type StallFsReading =
  { status: 'measured'; canaryMs: number; inFlight: number } | { status: 'unavailable' }

export type StallCause = {
  kind: StallCauseKind
  /** The measured quantities the kind follows from, in one line, so the verdict can be checked. */
  basis: string
  gc: GcPauseReading
  fs: StallFsReading
}

// A pause has to be both worth naming and a real share of the window: 50 ms is the smallest pause that shows
// up as a visible hiccup, and 40 % keeps a long window with one short collection from being called "GC".
const GC_DOMINANT_MIN_MS = 50
const GC_DOMINANT_SHARE = 0.4
// The canary is a 1 KB read that has to queue for a thread-pool slot (libuv keeps four by default). Measured
// on this machine, in the shipped build's own `managed preview acquire was slow` lines (57 samples): 5 read in
// 2 ms or less, 29 took 20 ms or more, median 24, p90 180, max 686. So 20 ms is where the pool stops being
// idle, and a tenth of the window keeps a 24 ms wait from being reported as the cause of a 900 ms stall.
const FS_SATURATED_MIN_MS = 20
const FS_SATURATED_SHARE = 0.1

const describeGc = (gc: GcPauseReading): string =>
  gc.status === 'measured' ? `gc ${gc.pauseMs} ms in ${gc.pauses} pause(s)` : 'gc not observed'

const describeFs = (fs: StallFsReading): string =>
  fs.status === 'measured'
    ? `fs canary ${fs.canaryMs} ms with ${fs.inFlight} in flight`
    : 'fs canary unavailable'

export const classifyStallCause = (input: {
  lateMs: number
  attribution: ActivityAttribution
  gc: GcPauseReading
  fs: StallFsReading
}): StallCause => {
  const { lateMs, attribution, gc, fs } = input
  const gcDominant =
    gc.status === 'measured' &&
    gc.pauseMs >= GC_DOMINANT_MIN_MS &&
    gc.pauseMs >= lateMs * GC_DOMINANT_SHARE
  if (gcDominant && gc.status === 'measured') {
    return {
      kind: 'garbage-collection',
      basis: `${describeGc(gc)} of ${lateMs} ms late`,
      gc,
      fs
    }
  }

  const fsSaturated =
    fs.status === 'measured' &&
    fs.canaryMs >= FS_SATURATED_MIN_MS &&
    fs.canaryMs >= lateMs * FS_SATURATED_SHARE
  if (fsSaturated && fs.status === 'measured') {
    return {
      kind: 'fs-queue-saturated',
      basis: `${describeFs(fs)} while the loop came back`,
      gc,
      fs
    }
  }

  if (attribution === 'cpu-bound-in-process') {
    return {
      kind: 'cpu-in-process',
      basis: `cpu-bound in this process, ${describeGc(gc)}, ${describeFs(fs)}`,
      gc,
      fs
    }
  }

  // Both instruments ran: neither GC nor the file-system pool accounts for the window.
  if (gc.status === 'measured' && fs.status === 'measured') {
    return {
      kind: 'unexplained',
      basis: `${lateMs} ms late with ${describeGc(gc)} and ${describeFs(fs)}; held outside what this process measures`,
      gc,
      fs
    }
  }

  return {
    kind: 'unmeasured',
    basis: `${lateMs} ms late, attribution ${attribution}, ${describeGc(gc)}, ${describeFs(fs)}`,
    gc,
    fs
  }
}
