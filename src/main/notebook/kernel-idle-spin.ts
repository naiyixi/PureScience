import { execFile } from 'node:child_process'

// A cell can leave work running inside the kernel that the app never asked for. Several scientific
// packages start their own redraw thread when they initialise and never yield it back; PyMOL is the one
// measured on this machine — `pymol.finish_launching()` sets `keep_thread_alive` itself and then runs a
// no-GUI `while (p.idle() or p.getRedisplay() or keep_thread_alive …)` loop with no sleep, so with no
// display to drive it the loop never blocks. Reading on 2026-11-06: 97.6% CPU per idle kernel, two such
// kernels spinning for 15 h+, host load average above 20 — felt by the user as "the whole machine is
// slow". `resources/notebook/python_loop.py` now caps that one loop at the end of a cell, but that guard
// can only name the packages it knows: any other spinner, any background worker a cell deliberately
// started, is invisible to it.
//
// So the main process watches CPU itself. This is deliberately an observation and never a control: it
// does not kill, throttle, or restart anything, because a kernel that is genuinely computing in the
// background (a cell that returned after spawning a worker) must not be torn down behind the user's
// back. The reading lands as one named log line, so "the machine got slow" can be answered with a pid,
// a kernel and a number instead of a guess.
//
// Why `ps -o time=` rather than `%cpu`: on macOS `%cpu` is an average over the process's whole lifetime,
// so a loop that started spinning five minutes ago hides inside a small number. `time` is CUMULATIVE cpu
// time, so the difference between two samples over a known wall-clock window IS the usage of that window
// (measured here with `yes > /dev/null`: 1.58 s → 4.27 s over 3 s, i.e. ~90% of one core). ps's text form
// is `MM:SS.ss`, `HH:MM:SS.ss`, or `DD-HH:MM:SS`; a pid that has exited makes ps exit non-zero with empty
// output, which is reported as 'probe-failed' rather than as a reading of zero.
//
// Windows has no portable cumulative-cpu probe here, and a made-up number is worse than none: that
// platform reports the named 'unsupported-platform' state, once, and never samples.

export type KernelCpuReading =
  { status: 'observed'; cpuMs: number } | { status: 'unsampled'; reason: IdleSpinUnsampledReason }

export type IdleSpinUnsampledReason = 'unsupported-platform' | 'probe-failed'

export type KernelCpuProbe = (pid: number) => Promise<KernelCpuReading>

// One kernel the executor currently has available (spawned, alive, and with no request in flight). The
// caller — not this module — decides what "idle" means: the executor's `pending` field is the only
// authority on whether a request is running, and an interval timer must not re-derive that.
export type IdleKernelTarget = {
  key: string
  kind: string
  env: string
  pid: number
}

export type IdleSpinReport = {
  key: string
  kind: string
  env: string
  pid: number
  // Percent of one core averaged over `windowMs`. A kernel with several spinner threads can exceed 100.
  cpuPercent: number
  windowMs: number
  thresholdPercent: number
  consecutiveSamples: number
}

export const DEFAULT_IDLE_SPIN_INTERVAL_MS = 15_000
export const DEFAULT_IDLE_SPIN_THRESHOLD_PERCENT = 50
export const DEFAULT_IDLE_SPIN_CONSECUTIVE_SAMPLES = 2

// `[DD-]HH:MM:SS[.ss]` and `MM:SS.ss`. ps prints the short form until an hour is reached, so the last two
// components are always minutes and seconds.
const CUMULATIVE_CPU_PATTERN = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/

// Parses ps's cumulative cpu text into milliseconds. Returns undefined for anything unrecognised (an
// empty string from a dead pid, a locale oddity) so the caller can name a failed probe instead of
// silently treating it as 0 ms — a 0 would read as "idle" forever.
export const parseCumulativeCpuTime = (raw: string): number | undefined => {
  const match = CUMULATIVE_CPU_PATTERN.exec(raw.trim())
  if (!match) return undefined
  const days = match[1] ? Number(match[1]) : 0
  const hours = match[2] ? Number(match[2]) : 0
  const minutes = Number(match[3])
  const seconds = Number(match[4])
  const totalSeconds = days * 86_400 + hours * 3_600 + minutes * 60 + seconds
  return Number.isFinite(totalSeconds) ? Math.round(totalSeconds * 1_000) : undefined
}

// The real probe: one short-lived `ps` per idle kernel per tick. Cheap (a few ms) and it needs no
// permissions beyond what the app already has — reading another process's cpu time is allowed for the
// same user, which is why this works without any native module.
const psCpuProbe: KernelCpuProbe = (pid) =>
  new Promise((resolve) => {
    execFile('ps', ['-o', 'time=', '-p', String(pid)], { timeout: 5_000 }, (error, stdout) => {
      if (error) return resolve({ status: 'unsampled', reason: 'probe-failed' })
      const cpuMs = parseCumulativeCpuTime(stdout)
      resolve(
        cpuMs === undefined
          ? { status: 'unsampled', reason: 'probe-failed' }
          : { status: 'observed', cpuMs }
      )
    })
  })

type IntervalHandle = { cancel: () => void }
type IntervalScheduler = (tick: () => void, ms: number) => IntervalHandle

// unref'd so an observation timer can never be the reason the app stays alive.
const defaultIntervalScheduler: IntervalScheduler = (tick, ms) => {
  const timer = setInterval(tick, ms)
  const ref = timer as unknown as { unref?: () => void }
  ref.unref?.()
  return { cancel: () => clearInterval(timer) }
}

export type KernelIdleSpinMonitorOptions = {
  // Must return only kernels with no request in flight; the executor owns that fact.
  listIdleKernels: () => IdleKernelTarget[]
  onSpin: (report: IdleSpinReport) => void
  // Called at most once per reason, so a platform without a probe logs one named line rather than one
  // per tick.
  onUnsampled?: (reason: IdleSpinUnsampledReason) => void
  probe?: KernelCpuProbe
  platform?: NodeJS.Platform
  intervalMs?: number
  thresholdPercent?: number
  consecutiveSamples?: number
  now?: () => number
  schedule?: IntervalScheduler
}

type SampleState = {
  pid: number
  cpuMs: number
  atMs: number
  streak: number
  reported: boolean
}

// Watches cumulative cpu time of the kernels that are currently idle. One report per spin episode: a
// kernel that keeps spinning is not re-logged every tick, and it re-arms as soon as a window comes back
// under the threshold, so a kernel that spins again after a quiet period is reported again.
export class KernelIdleSpinMonitor {
  private readonly listIdleKernels: () => IdleKernelTarget[]
  private readonly onSpin: (report: IdleSpinReport) => void
  private readonly onUnsampled?: (reason: IdleSpinUnsampledReason) => void
  private readonly probe: KernelCpuProbe
  private readonly platform: NodeJS.Platform
  private readonly intervalMs: number
  private readonly thresholdPercent: number
  private readonly consecutiveSamples: number
  private readonly now: () => number
  private readonly schedule: IntervalScheduler
  private readonly samples = new Map<string, SampleState>()
  private readonly unsampledReasons = new Set<IdleSpinUnsampledReason>()
  private handle: IntervalHandle | undefined
  private ticking = false

  constructor(options: KernelIdleSpinMonitorOptions) {
    this.listIdleKernels = options.listIdleKernels
    this.onSpin = options.onSpin
    this.onUnsampled = options.onUnsampled
    this.probe = options.probe ?? psCpuProbe
    this.platform = options.platform ?? process.platform
    this.intervalMs = options.intervalMs ?? DEFAULT_IDLE_SPIN_INTERVAL_MS
    this.thresholdPercent = options.thresholdPercent ?? DEFAULT_IDLE_SPIN_THRESHOLD_PERCENT
    this.consecutiveSamples = options.consecutiveSamples ?? DEFAULT_IDLE_SPIN_CONSECUTIVE_SAMPLES
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? defaultIntervalScheduler
  }

  // Idempotent: the executor calls this whenever it spawns a kernel.
  start(): void {
    if (this.handle) return
    if (this.platform === 'win32') {
      this.reportUnsampled('unsupported-platform')
      return
    }
    this.handle = this.schedule(() => void this.sampleOnce(), this.intervalMs)
  }

  // Stops sampling and forgets every baseline: a later start() must not compare against cpu time taken
  // before the gap (that would read as one huge window).
  stop(): void {
    this.handle?.cancel()
    this.handle = undefined
    this.samples.clear()
  }

  get running(): boolean {
    return this.handle !== undefined
  }

  // One sampling round. Exposed (not private) so a test can drive rounds deterministically instead of
  // waiting out the interval.
  async sampleOnce(): Promise<void> {
    // A probe round slower than the interval must not overlap the next one: two concurrent rounds would
    // both read the same baseline and one of them would compute a window of ~0 ms.
    if (this.ticking) return
    this.ticking = true
    try {
      const targets = this.listIdleKernels()
      const live = new Set(targets.map((target) => target.key))
      // A kernel that stopped being idle (a request started) or was torn down loses its baseline, so
      // the next window starts at whatever the cpu time is then.
      for (const key of [...this.samples.keys()]) {
        if (!live.has(key)) this.samples.delete(key)
      }

      const readings = await Promise.all(
        targets.map(async (target) => ({ target, reading: await this.probe(target.pid) }))
      )
      const atMs = this.now()

      for (const { target, reading } of readings) {
        if (reading.status === 'unsampled') {
          this.samples.delete(target.key)
          this.reportUnsampled(reading.reason)
          continue
        }
        const previous = this.samples.get(target.key)
        // First sighting, a respawned kernel (different pid), or a counter that went backwards (pid
        // reuse): take a baseline, never a reading.
        if (!previous || previous.pid !== target.pid || reading.cpuMs < previous.cpuMs) {
          this.samples.set(target.key, {
            pid: target.pid,
            cpuMs: reading.cpuMs,
            atMs,
            streak: 0,
            reported: false
          })
          continue
        }

        const windowMs = atMs - previous.atMs
        if (windowMs <= 0) continue

        const cpuPercent = Math.round(((reading.cpuMs - previous.cpuMs) / windowMs) * 1000) / 10
        const spinning = cpuPercent >= this.thresholdPercent
        const state: SampleState = {
          pid: target.pid,
          cpuMs: reading.cpuMs,
          atMs,
          streak: spinning ? previous.streak + 1 : 0,
          reported: spinning ? previous.reported : false
        }
        this.samples.set(target.key, state)

        if (!spinning || state.reported || state.streak < this.consecutiveSamples) continue
        state.reported = true
        this.onSpin({
          key: target.key,
          kind: target.kind,
          env: target.env,
          pid: target.pid,
          cpuPercent,
          windowMs,
          thresholdPercent: this.thresholdPercent,
          consecutiveSamples: state.streak
        })
      }
    } finally {
      this.ticking = false
    }
  }

  private reportUnsampled(reason: IdleSpinUnsampledReason): void {
    if (this.unsampledReasons.has(reason)) return
    this.unsampledReasons.add(reason)
    this.onUnsampled?.(reason)
  }
}
