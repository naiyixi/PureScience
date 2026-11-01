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

/**
 * The fs reading taken at the instant the stall ended: a canary read and how many of our instrumented reads
 * were already waiting on the same pool.
 *
 * `inFlight` is not a pool depth. It counts only the callers that report themselves (`beginFsOperation`, today
 * the managed preview acquire path), so 0 means "no evidence that anything of ours was queueing" — never "the
 * pool was idle", and never something a verdict can treat as calm.
 */
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
// The canary alone cannot decide saturation. Its completion callback runs on the loop, so a loop that was gone
// measures exactly like a pool that was busy — a canary started at the stall's edge and awaited after it always
// includes the stall itself. What separates the two is whether anything of ours was already waiting on the pool
// when the stall ended, and that is `inFlight`: the verdict requires it (see the gate below).
const FS_SATURATED_MIN_MS = 20
const FS_SATURATED_SHARE = 0.1

const describeGc = (gc: GcPauseReading): string =>
  gc.status === 'measured' ? `gc ${gc.pauseMs} ms in ${gc.pauses} pause(s)` : 'gc not observed'

const describeFs = (fs: StallFsReading): string => {
  if (fs.status !== 'measured') return 'fs canary unavailable'
  return fs.inFlight > 0
    ? `fs canary ${fs.canaryMs} ms with ${fs.inFlight} of our reads waiting`
    : `fs canary ${fs.canaryMs} ms with nothing of ours queued`
}

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

  // A slow canary with nothing of ours queued is not saturation: the only thing it can have been waiting for is
  // the loop, which is what stalled in the first place. Six days of packaged-build logs say why this gate has to
  // be here — of 3,460 records labelled `fs-queue-saturated` (3,585 stalls total), 3,436 carried `inFlight: 0`
  // and a canary that outlived the stall 4.1× at the median (p90 9.9×), so the label was describing a loop that
  // was gone and pointing the next reader at the wrong subsystem.
  // docs/evidence/2026-11-02-stall-cause-fs-verdict.md
  const fsSaturated =
    fs.status === 'measured' &&
    fs.inFlight > 0 &&
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
    // A canary that waited with nothing of ours queued is the number a reader will trip over, so the sentence
    // says what it was instead of leaving the reader to conclude the pool was busy after all.
    const unqueuedCanary =
      fs.canaryMs >= FS_SATURATED_MIN_MS && fs.inFlight === 0
        ? '; that canary waited on a loop that was gone, not on a busy pool'
        : ''
    return {
      kind: 'unexplained',
      basis: `${lateMs} ms late with ${describeGc(gc)} and ${describeFs(fs)}${unqueuedCanary}; held outside what this process measures`,
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
