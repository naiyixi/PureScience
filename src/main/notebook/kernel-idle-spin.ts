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

// -- how much memory the idle kernels are holding ----------------------------------------------
//
// The CPU ring answers "which kernel is burning a core". The other half of "the machine got slow" is
// "where did the memory go": kernels are kept alive on purpose (DEFAULT_IDLE_MS in kernel-executor), so a
// session that once ran an analysis leaves its interpreter resident after the cell returned. On the 8 GB
// machine measured on 2026-11-17, eleven live python kernels held ~2.4 GB between them while swap sat at
// 10.4 of 11.2 GB — and nothing in the bundle said so. The log line for a spinning kernel carries one
// number for one kernel; a kernel holding 470 MB quietly was invisible.
//
// What is measured, and what is not:
//
//   * `ps -o rss=` reports RESIDENT SET SIZE, which is what this records. It is not `phys_footprint`
//     (macOS's own accounting) and it is not the kernel's heap: shared pages count in every process that
//     maps them, so a sum over kernels over-counts. That is why the total below is always accompanied by
//     how many kernels it covers, and why the per-kernel number is the primary reading.
//   * Memory is a LEVEL, not a rate. It is recorded as one entry per idle kernel per sampling round rather
//     than as a window: subtracting two levels gives a per-window delta nobody asked for, and a level is
//     what a reader comparing kernels needs.
//   * A round whose probe failed is kept as a round with `measured` < `kernels`, never as zeros — the same
//     rule the cpu ring follows, for the same reason.

export type KernelMemoryReading =
  | { status: 'observed'; residentBytes: number }
  | { status: 'unmeasured'; reason: KernelMemoryUnmeasuredReason }

export type KernelMemoryUnmeasuredReason = 'unsupported-platform' | 'probe-failed' | 'parse-failed'

export type KernelMemoryProbe = (pid: number) => Promise<KernelMemoryReading>

/** One kernel's reading in one round. */
export type KernelMemorySample = Readonly<{
  /** Wall clock of the round this reading came from (ISO 8601). */
  at: string
  key: string
  kind: string
  env: string
  pid: number
  residentBytes: number
}>

export type KernelMemoryRoundEntry = Readonly<{
  key: string
  kind: string
  env: string
  pid: number
  reading: KernelMemoryReading
}>

/** One sampling round: every kernel that was idle at that moment, measured or not. */
export type KernelMemoryRound = Readonly<{
  at: string
  entries: readonly KernelMemoryRoundEntry[]
}>

/**
 * The newest round, with the counts that make its total readable. `totalResidentBytes` covers the
 * `measured` kernels of THIS round only: a total that silently folded in a stale reading from an earlier
 * round, or that excluded an unmeasured kernel without saying so, would be a number about nothing.
 */
export type KernelMemoryRoundSummary = Readonly<{
  at: string
  kernels: number
  measured: number
  unmeasured: number
  totalResidentBytes?: number
}>

export type NotebookKernelMemoryStatus =
  | 'samples'
  | 'no-samples'
  | 'monitor-not-started'
  | 'unsupported-platform'
  | 'probe-failed'
  | 'parse-failed'

export type NotebookKernelMemorySummary = Readonly<{
  capacity: number
  /** Rounds recorded since the ring was created (kept + dropped). */
  rounds: number
  /** Rounds recorded but no longer kept: the oldest ones, dropped first. */
  dropped: number
  status: NotebookKernelMemoryStatus
  monitor: 'running' | 'stopped' | 'never-started'
  /** Every named reason a reading could not be taken; empty when they all were. */
  unmeasuredReasons: KernelMemoryUnmeasuredReason[]
  /** The newest round with its counts; absent before the first round. */
  last?: KernelMemoryRoundSummary
  /** Newest round per kernel, kept independently of the timeline's rotation. */
  latest: KernelMemorySample[]
  /** Per-kernel readings, oldest first. */
  records: KernelMemorySample[]
}>

export type KernelMemoryRing = Readonly<{
  recordRound: (round: KernelMemoryRound) => void
  noteMonitorStarted: () => void
  noteMonitorStopped: () => void
  noteUnsampled: (reason: KernelMemoryUnmeasuredReason) => void
  summary: () => NotebookKernelMemorySummary
  /** Test seam: forget everything without rebuilding the ring. */
  clear: () => void
}>

export type KernelMemoryRingInput = Readonly<{
  /** Per-kernel readings kept. 120 at the 15 s interval is a quarter hour for one kernel, a few KB. */
  capacity?: number
  /** Rounds kept, newest last. 40 rounds is ten minutes of rounds and is where the total comes from. */
  roundCapacity?: number
  /** Kernels whose newest reading is kept regardless of rotation. */
  latestCapacity?: number
}>

export const DEFAULT_KERNEL_MEMORY_RING_CAPACITY = 120
export const DEFAULT_KERNEL_MEMORY_ROUND_CAPACITY = 40
export const DEFAULT_KERNEL_MEMORY_LATEST_CAPACITY = 32

export const createKernelMemoryRing = (input: KernelMemoryRingInput = {}): KernelMemoryRing => {
  const capacity = Math.max(1, Math.floor(input.capacity ?? DEFAULT_KERNEL_MEMORY_RING_CAPACITY))
  const roundCapacity = Math.max(
    1,
    Math.floor(input.roundCapacity ?? DEFAULT_KERNEL_MEMORY_ROUND_CAPACITY)
  )
  const latestCapacity = Math.max(
    1,
    Math.floor(input.latestCapacity ?? DEFAULT_KERNEL_MEMORY_LATEST_CAPACITY)
  )
  const records: KernelMemorySample[] = []
  const rounds: KernelMemoryRoundSummary[] = []
  const latest = new Map<string, KernelMemorySample>()
  const reasons = new Set<KernelMemoryUnmeasuredReason>()
  let observedRounds = 0
  let everStarted = false
  let running = false

  const recordRound = (round: KernelMemoryRound): void => {
    const entries = Array.isArray(round.entries) ? round.entries : []
    let measured = 0
    let totalResidentBytes = 0
    for (const entry of entries) {
      if (entry.reading.status === 'unmeasured') {
        // Named, not zeroed: a kernel whose probe failed is a kernel this round knows nothing about.
        reasons.add(entry.reading.reason)
        continue
      }
      if (!Number.isFinite(entry.reading.residentBytes) || entry.reading.residentBytes <= 0) {
        reasons.add('parse-failed')
        continue
      }
      const sample: KernelMemorySample = {
        at: round.at,
        key: entry.key,
        kind: entry.kind,
        env: entry.env,
        pid: entry.pid,
        residentBytes: entry.reading.residentBytes
      }
      records.push(sample)
      latest.set(sample.key, sample)
      measured += 1
      totalResidentBytes += sample.residentBytes
    }
    while (records.length > capacity) records.shift()
    while (latest.size > latestCapacity) {
      // Oldest by the round's own clock, so a replaced kernel does not pin an entry forever.
      const oldest = [...latest.entries()].sort((left, right) =>
        left[1].at.localeCompare(right[1].at)
      )[0]
      if (!oldest) break
      latest.delete(oldest[0])
    }
    // An empty round is not recorded: "no kernel was idle at this moment" is the absence of a round, and
    // keeping it would let `rounds` claim the monitor saw something when it saw nothing.
    if (entries.length === 0) return
    rounds.push({
      at: round.at,
      kernels: entries.length,
      measured,
      unmeasured: entries.length - measured,
      // Only when at least one kernel was measured. A `totalResidentBytes: 0` for a round nobody could be
      // measured in would read as "the kernels hold nothing".
      ...(measured > 0 ? { totalResidentBytes } : {})
    })
    while (rounds.length > roundCapacity) rounds.shift()
    observedRounds += 1
  }

  const summary = (): NotebookKernelMemorySummary => {
    const last = rounds.length > 0 ? rounds[rounds.length - 1] : undefined
    const namedReasons = [...reasons]
    const status: NotebookKernelMemoryStatus =
      records.length > 0
        ? 'samples'
        : namedReasons.includes('unsupported-platform')
          ? 'unsupported-platform'
          : namedReasons.includes('probe-failed')
            ? 'probe-failed'
            : namedReasons.includes('parse-failed')
              ? 'parse-failed'
              : everStarted
                ? 'no-samples'
                : 'monitor-not-started'
    return {
      capacity,
      rounds: observedRounds,
      dropped: observedRounds - rounds.length,
      status,
      monitor: running ? 'running' : everStarted ? 'stopped' : 'never-started',
      unmeasuredReasons: namedReasons,
      ...(last ? { last } : {}),
      latest: [...latest.values()].sort((left, right) => left.at.localeCompare(right.at)),
      records: records.map((sample) => ({ ...sample }))
    }
  }

  return {
    recordRound,
    noteMonitorStarted: (): void => {
      everStarted = true
      running = true
    },
    noteMonitorStopped: (): void => {
      running = false
    },
    noteUnsampled: (reason): void => {
      reasons.add(reason)
    },
    summary,
    clear: (): void => {
      records.length = 0
      rounds.length = 0
      latest.clear()
      reasons.clear()
      observedRounds = 0
      everStarted = false
      running = false
    }
  }
}

// Written by every idle-spin monitor in this process, read by the support bundle facts.
export const sharedKernelMemory: KernelMemoryRing = createKernelMemoryRing()

// `ps -o rss=` prints a bare number of 1024-byte units on both platforms this observation supports.
// Anything else (`''` for a pid that just exited, a locale-odd string) is undefined so the caller can name
// a failed probe — 0 bytes is not one of the answers this observation is allowed to invent.
const RESIDENT_PATTERN = /^\s*(\d+)\s*$/

export const parseResidentBytes = (raw: string): number | undefined => {
  const match = RESIDENT_PATTERN.exec(raw)
  if (!match) return undefined
  const kilobytes = Number(match[1])
  if (!Number.isFinite(kilobytes) || kilobytes <= 0) return undefined
  return kilobytes * 1024
}

// One short-lived `ps` per idle kernel per round, same shape and cost as the cpu probe. Reading another
// process's memory of the same user needs no extra permission, which is why this needs no native module.
const psResidentProbe: KernelMemoryProbe = (pid) =>
  new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 5_000 }, (error, stdout) => {
      if (error) return resolve({ status: 'unmeasured', reason: 'probe-failed' })
      const residentBytes = parseResidentBytes(stdout)
      resolve(
        residentBytes === undefined
          ? { status: 'unmeasured', reason: 'parse-failed' }
          : { status: 'observed', residentBytes }
      )
    })
  })

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
  /** Reads how much memory an idle kernel holds. Defaults to the real `ps -o rss=` probe. */
  memoryProbe?: KernelMemoryProbe
  /** Where memory rounds land. Defaults to the process-wide ring the support bundle reads. */
  memoryRing?: KernelMemoryRing
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
  private readonly memoryProbe: KernelMemoryProbe
  private readonly memoryRing: KernelMemoryRing
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
    this.memoryProbe = options.memoryProbe ?? psResidentProbe
    this.memoryRing = options.memoryRing ?? sharedKernelMemory
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
      this.memoryRing.noteUnsampled('unsupported-platform')
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
    this.memoryRing.noteMonitorStopped()
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

      // Memory, measured in the same round and over the same target list: the executor's `pending` field is
      // the only authority on "idle", and a second ticker would re-derive it. A failed memory probe never
      // touches the cpu baselines above — the two readings are independent on purpose.
      if (this.platform === 'win32') {
        this.memoryRing.noteUnsampled('unsupported-platform')
      } else {
        const memoryReadings = await Promise.all(
          targets.map(async (target) => ({
            target,
            reading: await this.memoryProbe(target.pid)
          }))
        )
        this.memoryRing.recordRound({
          at: new Date(atMs).toISOString(),
          entries: memoryReadings.map(({ target, reading }) => ({
            key: target.key,
            kind: target.kind,
            env: target.env,
            pid: target.pid,
            reading
          }))
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
