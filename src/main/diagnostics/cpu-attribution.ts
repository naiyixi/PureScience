// One vocabulary for "was the time ours or were we not running", shared by every timer we report.
//
// Real evidence, 2026-10-25 (`~/Library/Logs/PureScience/main.log`, packaged build, read-only):
//
//   {"msg":"compose step slow","scope":"startup","data":{"step":"permission-grant-registry","durationMs":22763287}}
//   {"msg":"settings key migration was slow","scope":"settings","data":{"totalMs":22763411,
//    "phases":"encryption-available=22763345ms,providers=34ms,connectors=2ms"}}
//   {"msg":"event loop stalled","data":{"windowMs":22763558,"cpuMs":287,"cpuShare":0,"attribution":"process-not-scheduled"}}
//
// Three records, the SAME gap, three different answers: the watchdog said "the process was not running",
// while the two timers that feed startup and settings analysis reported six hours and eighteen minutes of
// work. The same machine logged a 635,268 ms compose step and a 635,144 ms key-migration phase a few hours
// earlier, again next to `cpuShare 0`. A duration alone cannot tell our synchronous block from a suspended
// laptop, so a number that big reads as "the keychain is slow" — and sends the next investigation there.
//
// So: every timer that reports a duration can also report the CPU it consumed in that window, and this file
// holds the one classification both the watchdog and the compose/settings recorders use. Named heuristics,
// not facts: measured 2026-10-19 probes, a busy loop fills ~0.8 of its wall time with CPU while an
// idle-but-descheduled process fills ~0.0. The band between stays unresolved rather than being forced into
// a verdict.

export type ActivityAttribution = 'cpu-bound-in-process' | 'process-not-scheduled' | 'inconclusive'

const CPU_BOUND_SHARE = 0.6
const DESCHEDULED_SHARE = 0.15

export type CpuUsageSample = Readonly<{ user: number; system: number }>

/** Process CPU (all threads) consumed between two `process.cpuUsage()` samples, in milliseconds. */
export const cpuMillisecondsBetween = (before: CpuUsageSample, after: CpuUsageSample): number =>
  Math.max(0, Math.round((after.user - before.user + (after.system - before.system)) / 1000))

/**
 * CPU time as a share of the window. A window with no length says nothing: it returns 0, and the
 * classifier treats a zero-length window as `inconclusive` rather than as "not scheduled" — a step that
 * returned instantly is the least suspicious thing in the log.
 */
export const cpuShareOf = (cpuMs: number, windowMs: number): number => {
  if (!(windowMs > 0)) return 0
  return Math.min(1, Math.max(0, cpuMs / windowMs))
}

export const classifyCpuShare = (share: number, windowMs: number): ActivityAttribution => {
  if (!(windowMs > 0) || !Number.isFinite(share)) return 'inconclusive'
  if (share >= CPU_BOUND_SHARE) return 'cpu-bound-in-process'
  if (share <= DESCHEDULED_SHARE) return 'process-not-scheduled'
  return 'inconclusive'
}

/**
 * The suffix a summary line appends for a duration that was not work. `(failed)` already has that role for
 * outcome, so this one only ever names the descheduled case: an `inconclusive` step keeps the bare number
 * instead of implying a verdict it does not have.
 */
export const attributionSuffix = (attribution: ActivityAttribution): string =>
  attribution === 'process-not-scheduled' ? '(not-scheduled)' : ''
