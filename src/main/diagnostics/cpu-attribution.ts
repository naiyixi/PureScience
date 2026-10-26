// One vocabulary for "was the time ours, or did this process spend no CPU on it", shared by every timer we
// report.
//
// Real evidence, 2026-10-25 (`~/Library/Logs/PureScience/main.log`, packaged build, read-only):
//
//   {"msg":"compose step slow","scope":"startup","data":{"step":"permission-grant-registry","durationMs":22763287}}
//   {"msg":"settings key migration was slow","scope":"settings","data":{"totalMs":22763411,
//    "phases":"encryption-available=22763345ms,providers=34ms,connectors=2ms"}}
//   {"msg":"event loop stalled","data":{"windowMs":22763558,"cpuMs":287,"cpuShare":0,"attribution":"no-cpu-in-process"}}
//
// Three records, the SAME gap, three different answers: the watchdog said "not scheduled", while the two
// timers that feed startup and settings analysis reported six hours and eighteen minutes of
// work. The same machine logged a 635,268 ms compose step and a 635,144 ms key-migration phase a few hours
// earlier, again next to `cpuShare 0`. A duration alone cannot tell our synchronous block from a suspended
// laptop, so a number that big reads as "the keychain is slow" — and sends the next investigation there.
//
// So: every timer that reports a duration can also report the CPU it consumed in that window, and this file
// holds the one classification both the watchdog and the compose/settings recorders use. Named heuristics,
// not facts: measured 2026-10-19 probes, a busy loop fills ~0.8 of its wall time with CPU while an
// idle-but-descheduled process fills ~0.0. The band between stays unresolved rather than being forced into
// a verdict.
//
// What the low band does NOT say. `no-cpu-in-process` is the measurement, not a cause: three different
// situations produce it and process CPU cannot separate them — the OS did not schedule this process, the
// handler was awaiting something outside it (a remote call, the engine, a child process), or the work ran on
// another thread. Callers that also know the loop-held windows (`loop-held-windows`) print that split beside
// these fields, and it is the discriminator this app actually has: a held window means the loop itself was
// not running, no held window means the loop was free and the time went somewhere this process does not
// measure. The band used to be called `process-not-scheduled`, which claimed a cause the numbers never
// carried — an application command that awaited a 300 ms remote read was logged as a machine fault, and the
// next investigation went looking for a starved process that was fine.

export type ActivityAttribution = 'cpu-bound-in-process' | 'no-cpu-in-process' | 'inconclusive'

const CPU_BOUND_SHARE = 0.6
// Below this share the window spent essentially no CPU here. Named for the measurement: the low band covers
// descheduling, awaiting an outside service and work on another thread alike (see the header).
const NO_CPU_SHARE = 0.15

export type CpuUsageSample = Readonly<{ user: number; system: number }>

/** Process CPU (all threads) consumed between two `process.cpuUsage()` samples, in milliseconds. */
export const cpuMillisecondsBetween = (before: CpuUsageSample, after: CpuUsageSample): number =>
  Math.max(0, Math.round((after.user - before.user + (after.system - before.system)) / 1000))

/**
 * CPU time as a share of the window. A window with no length says nothing: it returns 0, and the
 * classifier treats a zero-length window as `inconclusive` rather than as the low band — a step that
 * returned instantly is the least suspicious thing in the log.
 */
export const cpuShareOf = (cpuMs: number, windowMs: number): number => {
  if (!(windowMs > 0)) return 0
  return Math.min(1, Math.max(0, cpuMs / windowMs))
}

export const classifyCpuShare = (share: number, windowMs: number): ActivityAttribution => {
  if (!(windowMs > 0) || !Number.isFinite(share)) return 'inconclusive'
  if (share >= CPU_BOUND_SHARE) return 'cpu-bound-in-process'
  if (share <= NO_CPU_SHARE) return 'no-cpu-in-process'
  return 'inconclusive'
}

/**
 * The suffix a summary line appends for a duration that was not work. `(failed)` already has that role for
 * outcome, so this one only ever names the low band: an `inconclusive` step keeps the bare number instead of
 * implying a verdict it does not have. `(no-cpu)` says what was measured — no CPU here — and deliberately not
 * why (see the header).
 */
export const attributionSuffix = (attribution: ActivityAttribution): string =>
  attribution === 'no-cpu-in-process' ? '(no-cpu)' : ''

export type CpuAttributionFields = Readonly<{
  cpuMs: number
  cpuShare: number
  attribution: ActivityAttribution
}>

/**
 * The three fields a slow line carries, computed from the two `process.cpuUsage()` samples around the window.
 * One function so every call site cannot drift in rounding or in which classifier they use — the whole point
 * of this module is that there is one answer to "was the time ours". The callers are enumerated in the plan
 * ledger rather than counted here: a number in this comment would be a second source that nobody re-reads.
 */
export const cpuAttributionFields = (
  before: CpuUsageSample,
  after: CpuUsageSample,
  windowMs: number
): CpuAttributionFields => {
  const cpuMs = cpuMillisecondsBetween(before, after)
  const share = cpuShareOf(cpuMs, windowMs)
  return {
    cpuMs,
    cpuShare: Number(share.toFixed(3)),
    attribution: classifyCpuShare(share, windowMs)
  }
}
