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

// -- the process-wide ring the support bundle reads -------------------------------------------
//
// The named log line above answers "a kernel is burning cpu" for whoever is looking at the log at that
// moment. It does not travel: the log is capped and rotated (this machine's reached 81 MB), and the
// support bundle copies logs newest-first under an 8 MB cap — so a bundle exported about "the machine was
// slow for an hour, the fan never stopped" can arrive after the line that explained it has rotated out.
//
// This ring is the machine-readable tail of the same windows, written by the monitor and read by the
// bundle facts in the same process. Two properties matter more than the shape:
//
//   * Every completed window is kept, not only the over-threshold ones. Without the quiet readings, "97%"
//     has nothing to be compared against, and "12% while idle" would look like no signal at all.
//   * A window that could not be measured is never written as a zero — see `status` and
//     `unsampledReasons`: `probe-failed` and `unsupported-platform` are answers, and 0% is not one of them.
//
// Deliberately a process-wide singleton, for the same reason as `slow-operation-ring`: the monitor is
// created where its executor is built and the bundle facts are assembled in the composition root, so a
// hand-off would add a seam neither side needs. Tests inject their own ring.

/** One completed cpu window for one idle kernel. */
export type KernelCpuSample = Readonly<{
  /** Wall clock the window ended at (ISO 8601). */
  at: string
  key: string
  kind: string
  env: string
  pid: number
  /** Percent of one core averaged over `windowMs`; a kernel with several spinners can exceed 100. */
  cpuPercent: number
  windowMs: number
  thresholdPercent: number
  /** Whether this window would have been reported as a spin episode. */
  spinning: boolean
}>

export type KernelCpuWindow = Omit<KernelCpuSample, 'at' | 'spinning'>

/**
 * Named states instead of an empty list. `no-samples` means the monitor ran and no window completed
 * (kernels had just spawned, or none was idle); `monitor-not-started` means nothing was ever looked at.
 * Merging those two is how "nobody was watching" starts reading as "the machine was fine".
 */
export type NotebookKernelCpuStatus =
  'samples' | 'no-samples' | 'monitor-not-started' | 'unsupported-platform' | 'probe-failed'

export type NotebookKernelCpuSummary = Readonly<{
  capacity: number
  /** Windows recorded since the ring was created (kept + dropped). */
  observed: number
  /** Recorded but no longer kept: the oldest ones, dropped first. */
  dropped: number
  oldestAt?: string
  newestAt?: string
  status: NotebookKernelCpuStatus
  /** Whether a monitor is sampling right now. A stopped one is not a clean machine. */
  monitor: 'running' | 'stopped' | 'never-started'
  /** Every named reason the observation could not run; empty when it could. */
  unsampledReasons: IdleSpinUnsampledReason[]
  /**
   * The newest window per kernel, kept independently of the tail's rotation: with eleven kernels alive a
   * 120-record tail covers about three minutes, and "which kernel is burning what" must survive that.
   */
  latest: KernelCpuSample[]
  /** Oldest first, so the tail reads as a timeline. */
  records: KernelCpuSample[]
}>

export type KernelCpuRing = Readonly<{
  record: (window: KernelCpuWindow) => void
  noteMonitorStarted: () => void
  noteMonitorStopped: () => void
  noteUnsampled: (reason: IdleSpinUnsampledReason) => void
  summary: () => NotebookKernelCpuSummary
  /** Test seam: forget everything without rebuilding the ring. */
  clear: () => void
}>

export type KernelCpuRingInput = Readonly<{
  /** Windows kept. 120 at the 15 s interval is a quarter hour for one kernel, and a few KB. */
  capacity?: number
  /** Kernels whose newest window is kept regardless of rotation. */
  latestCapacity?: number
  /** Seam. Production leaves it alone. */
  now?: () => Date
}>

export const DEFAULT_KERNEL_CPU_RING_CAPACITY = 120
export const DEFAULT_KERNEL_CPU_LATEST_CAPACITY = 32

export const createKernelCpuRing = (input: KernelCpuRingInput = {}): KernelCpuRing => {
  const capacity = Math.max(1, Math.floor(input.capacity ?? DEFAULT_KERNEL_CPU_RING_CAPACITY))
  const latestCapacity = Math.max(
    1,
    Math.floor(input.latestCapacity ?? DEFAULT_KERNEL_CPU_LATEST_CAPACITY)
  )
  const now = input.now ?? ((): Date => new Date())
  const records: KernelCpuSample[] = []
  const latest = new Map<string, KernelCpuSample>()
  const unsampledReasons = new Set<IdleSpinUnsampledReason>()
  let observed = 0
  let everStarted = false
  let running = false

  const record = (window: KernelCpuWindow): void => {
    // A window whose percentage is not a number is a broken probe, not a quiet kernel: dropping it is the
    // honest move, and `noteUnsampled('probe-failed')` is what records why it is missing.
    if (!Number.isFinite(window.cpuPercent) || !Number.isFinite(window.windowMs)) return
    const sample: KernelCpuSample = {
      at: now().toISOString(),
      key: window.key,
      kind: window.kind,
      env: window.env,
      pid: window.pid,
      cpuPercent: window.cpuPercent,
      windowMs: window.windowMs,
      thresholdPercent: window.thresholdPercent,
      spinning: window.cpuPercent >= window.thresholdPercent
    }
    records.push(sample)
    observed += 1
    while (records.length > capacity) records.shift()
    latest.set(sample.key, sample)
    if (latest.size > latestCapacity) {
      // Oldest by the window's own clock, so a replaced kernel does not pin an entry forever.
      const oldest = [...latest.entries()].sort((left, right) =>
        left[1].at.localeCompare(right[1].at)
      )[0]
      if (oldest) latest.delete(oldest[0])
    }
  }

  const summary = (): NotebookKernelCpuSummary => {
    const kept = records.length
    const oldestAt = kept > 0 ? records[0].at : undefined
    const newestAt = kept > 0 ? records[kept - 1].at : undefined
    const reasons = [...unsampledReasons]
    const status: NotebookKernelCpuStatus =
      kept > 0
        ? 'samples'
        : reasons.includes('unsupported-platform')
          ? 'unsupported-platform'
          : reasons.includes('probe-failed')
            ? 'probe-failed'
            : everStarted
              ? 'no-samples'
              : 'monitor-not-started'
    return {
      capacity,
      observed,
      dropped: observed - kept,
      ...(oldestAt ? { oldestAt } : {}),
      ...(newestAt ? { newestAt } : {}),
      status,
      monitor: running ? 'running' : everStarted ? 'stopped' : 'never-started',
      unsampledReasons: reasons,
      latest: [...latest.values()].sort((left, right) => left.at.localeCompare(right.at)),
      records: records.map((sample) => ({ ...sample }))
    }
  }

  return {
    record,
    noteMonitorStarted: (): void => {
      everStarted = true
      running = true
    },
    noteMonitorStopped: (): void => {
      running = false
    },
    noteUnsampled: (reason): void => {
      unsampledReasons.add(reason)
    },
    summary,
    clear: (): void => {
      records.length = 0
      latest.clear()
      unsampledReasons.clear()
      observed = 0
      everStarted = false
      running = false
    }
  }
}

// Written by every idle-spin monitor in this process, read by the support bundle facts.
export const sharedKernelCpu: KernelCpuRing = createKernelCpuRing()

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
  /** Where completed windows land. Defaults to the process-wide ring the support bundle reads. */
  ring?: KernelCpuRing
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
  private readonly ring: KernelCpuRing
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
    this.ring = options.ring ?? sharedKernelCpu
  }

  // Idempotent: the executor calls this whenever it spawns a kernel.
  start(): void {
    if (this.handle) return
    if (this.platform === 'win32') {
      this.ring.noteUnsampled('unsupported-platform')
      this.reportUnsampled('unsupported-platform')
      return
    }
    this.handle = this.schedule(() => void this.sampleOnce(), this.intervalMs)
    // Recorded in the ring as well as in the field: a bundle exported while nothing is sampling must be
    // able to say whether a monitor ever existed, which is a different answer from "the kernel was quiet".
    this.ring.noteMonitorStarted()
  }

  // Stops sampling and forgets every baseline: a later start() must not compare against cpu time taken
  // before the gap (that would read as one huge window).
  stop(): void {
    this.handle?.cancel()
    this.handle = undefined
    this.samples.clear()
    this.ring.noteMonitorStopped()
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
          // Both ledgers say why: the callback dedupes its own log line, the ring keeps the named reason for
          // a bundle exported from a process whose log has already rotated past it.
          this.ring.noteUnsampled(reading.reason)
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
        // Every completed window is kept, not only the ones that cross the threshold: "97% while idle"
        // only means something beside the quiet readings around it.
        this.ring.record({
          key: target.key,
          kind: target.kind,
          env: target.env,
          pid: target.pid,
          cpuPercent,
          windowMs,
          thresholdPercent: this.thresholdPercent
        })
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
