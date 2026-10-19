import { Worker } from 'node:worker_threads'

// The stall watchdog can say *whether* a stall burned CPU, but the machine-side numbers it logs
// (`freeMemMb`, `loadAvg1m`) are read **when the stall ends** — they describe the machine a moment after
// recovery, not what it looked like while the loop was held. Worse, a reading taken by the main thread
// cannot exist at all while the main thread is held, so "the machine had no free pages" was never
// measured, only guessed from the after-the-fact snapshot.
//
// This module adds the missing half: a sampler on its own thread that keeps taking readings *through* the
// stall and hands over its timeline afterwards. Two things fall out of that timeline:
//   1. `continuity` — if the sampler kept ticking across the stall, the machine was running and the main
//      thread alone was starved; if the timeline has a hole exactly as wide as the stall, the whole
//      process (all threads) was stopped, which is what a swap-out or an external suspend looks like.
//   2. the host readings inside the stall (`freeMemMbMin`, `loadAvg1mMax`) and, where the platform exposes
//      them, paging counters (`pageouts` / `swapouts`) as a delta across the stall — the numbers that can
//      say "pages were being thrown out while we waited" instead of inferring it.
//
// Deliberately not a verdict: this module reports what it saw. The watchdog keeps its `attribution` and
// does not gain a third threshold that would have to be invented before it could be calibrated.
//
// The sampler does raw IO only (OS calls inside the worker); interpreting the platform's paging text
// happens back on the main thread in `parsePagingCounters`, so the parsing rules have exactly one home and
// can be tested without a stall.

const DEFAULT_INTERVAL_MS = 250
const DEFAULT_PAGING_EVERY_MS = 500
// A flush that never arrives must not turn a diagnostic into a hang: report "unavailable" instead.
const FLUSH_TIMEOUT_MS = 1_500
// A hole is called a hole only when it is wider than a few ordinary ticks (a busy sampler at 250 ms stays
// well under 3x unless something stopped it). Heuristic, named, and reported next to the raw `maxGapMs`.
const GAP_FACTOR = 3
const MAX_BUFFERED_SAMPLES = 2_000

export type HostSample = {
  at: number
  cpuMs: number
  freeMemMb?: number
  loadAvg1m?: number
  rssMb?: number
}

export type PagingReading = { at: number; text: string }

export type PagingCounters = { pageouts?: number; swapouts?: number }

type HostStallSlice = {
  status: 'sampled'
  intervalMs: number
  stallMs: number
  // Samples whose timestamp falls inside the stall. Zero is a real answer: it means the sampler itself was
  // not running during the stall, which is exactly the whole-process-frozen shape.
  samples: number
  expectedSamples: number
  maxGapMs?: number
  continuity: 'kept-sampling' | 'gapped' | 'unknown'
  // Only present when at least one sample landed inside the stall: summing zero samples would report "the
  // process used no CPU" when the truth is "nobody was sampling".
  cpuMs?: number
  cpuShare?: number
  freeMemMbMin?: number
  freeMemMbMax?: number
  loadAvg1mMax?: number
  rssMbMax?: number
  pageouts?: number
  swapouts?: number
}

export type HostStallReading =
  | HostStallSlice
  // The first stall only arms the window; nothing has been sampled inside a stall yet.
  | { status: 'window-armed' }
  // No thread available, or the sampler produced neither an in-stall sample nor a pair straddling the
  // stall. Named so it can never be read as "the machine was fine".
  | { status: 'unavailable' }
  | { status: 'no-in-stall-samples' }

export type HostStallSampler = {
  stop: (fromMs: number, toMs: number) => Promise<HostStallReading>
  cancel: () => void
}

export type HostStallSamplerInput = {
  intervalMs?: number
  pagingEveryMs?: number
  // Seams. Tests replace the worker program; production leaves it alone.
  workerSource?: string
  platform?: NodeJS.Platform
  flushTimeoutMs?: number
}

// Where the paging counters live on each platform. Kept in one place so the worker's IO and the parser
// cannot drift apart; a platform without an entry simply reports no paging counters.
const PAGING_SOURCE: Partial<Record<NodeJS.Platform, { command?: string; file?: string }>> = {
  darwin: { command: 'vm_stat' },
  linux: { file: '/proc/vmstat' }
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { freemem, loadavg } = require('node:os')

const intervalMs = workerData.intervalMs
const pagingEveryMs = workerData.pagingEveryMs
const pagingSource = workerData.pagingSource || null
const maxSamples = workerData.maxSamples

const samples = []
const paging = []
let previous = process.cpuUsage()
let lastPagingAt = 0

const readPaging = () => {
  if (!pagingSource) return
  try {
    let text
    if (pagingSource.command) {
      text = require('node:child_process').execFileSync(pagingSource.command, {
        encoding: 'utf8',
        timeout: 2000
      })
    } else if (pagingSource.file) {
      text = require('node:fs').readFileSync(pagingSource.file, 'utf8')
    } else {
      return
    }
    lastPagingAt = Date.now()
    paging.push({ at: lastPagingAt, text: text })
  } catch {
    // An unreadable counter stays absent; a missing reading is not a zero.
  }
}

const sample = () => {
  const at = Date.now()
  const cpu = process.cpuUsage(previous)
  previous = process.cpuUsage()
  const load = loadavg()[0]
  if (samples.length < maxSamples) {
    samples.push({
      at: at,
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      freeMemMb: Math.round(freemem() / 1e6),
      rssMb: Math.round(process.memoryUsage().rss / 1e6),
      ...(Number.isFinite(load) ? { loadAvg1m: Number(load.toFixed(2)) } : {})
    })
  }
  if (at - lastPagingAt >= pagingEveryMs) readPaging()
}

sample()
const timer = setInterval(sample, intervalMs)
timer.unref()

parentPort.on('message', (message) => {
  if (!message || message.kind !== 'flush') return
  clearInterval(timer)
  parentPort.postMessage({ kind: 'flushed', samples: samples, paging: paging })
  parentPort.close()
})
`

export const parsePagingCounters = (
  platform: NodeJS.Platform,
  text: string
): PagingCounters | undefined => {
  const read = (pattern: RegExp): number | undefined => {
    const match = pattern.exec(text)
    if (!match) return undefined
    const value = Number(match[1])
    return Number.isFinite(value) ? value : undefined
  }

  let pageouts: number | undefined
  let swapouts: number | undefined
  if (platform === 'darwin') {
    pageouts = read(/^\s*Pageouts:\s+(\d+)\.?\s*$/m)
    swapouts = read(/^\s*Swapouts:\s+(\d+)\.?\s*$/m)
  } else if (platform === 'linux') {
    pageouts = read(/^pgpgout\s+(\d+)$/m)
    swapouts = read(/^pswpout\s+(\d+)$/m)
  } else {
    // Windows and everything else: the counters that matter are not exposed by a file we can read
    // synchronously from a worker. Absent, not zero.
    return undefined
  }

  if (pageouts === undefined && swapouts === undefined) return undefined
  return {
    ...(pageouts !== undefined ? { pageouts } : {}),
    ...(swapouts !== undefined ? { swapouts } : {})
  }
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

const minOf = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : Math.min(...values)

const maxOf = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : Math.max(...values)

const collect = (values: readonly (number | undefined)[]): number[] =>
  values.filter((value): value is number => typeof value === 'number')

// Pure: everything the record needs about the stall window, computed from a timeline another thread took.
export const summarizeHostWindow = (input: {
  samples: readonly HostSample[]
  paging?: readonly PagingReading[]
  fromMs: number
  toMs: number
  intervalMs: number
  platform?: NodeJS.Platform
}): HostStallReading => {
  const stallMs = Math.max(0, input.toMs - input.fromMs)
  const timeline = [...input.samples].sort((left, right) => left.at - right.at)
  const inside = timeline.filter((sample) => sample.at >= input.fromMs && sample.at <= input.toMs)

  // The widest hole that overlaps the stall, including the holes that straddle its two edges: if the whole
  // process was stopped, every sample is on the outside and the straddling pair is the only evidence there is.
  let maxGapMs: number | undefined
  for (let index = 1; index < timeline.length; index += 1) {
    const previous = timeline[index - 1]
    const current = timeline[index]
    if (!previous || !current) continue
    if (current.at < input.fromMs || previous.at > input.toMs) continue
    const gap = current.at - previous.at
    if (maxGapMs === undefined || gap > maxGapMs) maxGapMs = gap
  }

  if (inside.length === 0 && maxGapMs === undefined) return { status: 'no-in-stall-samples' }

  const expectedSamples = Math.max(0, Math.floor(stallMs / input.intervalMs) - 1)
  const continuity =
    maxGapMs === undefined
      ? 'unknown'
      : maxGapMs >= input.intervalMs * GAP_FACTOR
        ? 'gapped'
        : 'kept-sampling'

  const cpuMs = sum(inside.map((sample) => sample.cpuMs))
  const freeMem = collect(inside.map((sample) => sample.freeMemMb))
  const loadAvg = collect(inside.map((sample) => sample.loadAvg1m))
  const rss = collect(inside.map((sample) => sample.rssMb))
  const counters = (input.paging ?? [])
    .filter((reading) => reading.at >= input.fromMs && reading.at <= input.toMs)
    .map((reading) => parsePagingCounters(input.platform ?? process.platform, reading.text))
    .filter((value): value is PagingCounters => value !== undefined)
  const readDelta = (
    pick: (counters: PagingCounters) => number | undefined
  ): number | undefined => {
    const values = collect(counters.map(pick))
    if (values.length < 2) return undefined
    const first = values[0]
    const last = values[values.length - 1]
    if (first === undefined || last === undefined) return undefined
    const delta = last - first
    // A counter that went backwards was reset (or is not the counter we think): report nothing.
    return delta >= 0 ? delta : undefined
  }
  const pageouts = readDelta((entry) => entry.pageouts)
  const swapouts = readDelta((entry) => entry.swapouts)

  return {
    status: 'sampled',
    intervalMs: input.intervalMs,
    stallMs,
    samples: inside.length,
    expectedSamples,
    ...(maxGapMs !== undefined ? { maxGapMs } : {}),
    continuity,
    ...(inside.length > 0
      ? {
          cpuMs,
          cpuShare: stallMs > 0 ? Number(Math.min(1, cpuMs / stallMs).toFixed(3)) : 0,
          ...(minOf(freeMem) !== undefined ? { freeMemMbMin: minOf(freeMem) } : {}),
          ...(maxOf(freeMem) !== undefined ? { freeMemMbMax: maxOf(freeMem) } : {}),
          ...(maxOf(loadAvg) !== undefined ? { loadAvg1mMax: maxOf(loadAvg) } : {}),
          ...(maxOf(rss) !== undefined ? { rssMbMax: maxOf(rss) } : {})
        }
      : {}),
    ...(pageouts !== undefined ? { pageouts } : {}),
    ...(swapouts !== undefined ? { swapouts } : {})
  }
}

type Flushed = { samples: HostSample[]; paging: PagingReading[] }

// A thread of our own, because the main thread is the thing being held: anything it samples is either
// before the stall or after it.
export const createHostStallSampler = (
  input: HostStallSamplerInput = {}
): HostStallSampler | undefined => {
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS
  const platform = input.platform ?? process.platform
  let worker: Worker
  try {
    worker = new Worker(input.workerSource ?? WORKER_SOURCE, {
      eval: true,
      workerData: {
        intervalMs,
        pagingEveryMs: input.pagingEveryMs ?? DEFAULT_PAGING_EVERY_MS,
        pagingSource: PAGING_SOURCE[platform] ?? null,
        maxSamples: MAX_BUFFERED_SAMPLES
      }
    })
  } catch {
    // No worker: the caller records `unavailable` rather than a stall with no machine reading as if the
    // machine had been fine.
    return undefined
  }
  // A diagnostics thread must never hold the process open.
  worker.unref()
  worker.on('error', () => {
    // Errors are surfaced through the flush timeout below; swallowing here keeps them out of the loop.
  })
  let settled = false

  const shutdown = (): void => {
    void worker.terminate().catch(() => undefined)
  }

  const flush = (): Promise<Flushed | undefined> =>
    new Promise<Flushed | undefined>((resolve) => {
      let done = false
      const finish = (value: Flushed | undefined): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => finish(undefined), input.flushTimeoutMs ?? FLUSH_TIMEOUT_MS)
      timer.unref?.()
      worker.once('message', (message: unknown) => {
        const flushed = message as {
          kind?: string
          samples?: HostSample[]
          paging?: PagingReading[]
        }
        if (flushed?.kind !== 'flushed') {
          finish(undefined)
          return
        }
        finish({ samples: flushed.samples ?? [], paging: flushed.paging ?? [] })
      })
      try {
        worker.postMessage({ kind: 'flush' })
      } catch {
        finish(undefined)
      }
    })

  return {
    stop: async (fromMs, toMs) => {
      if (settled) return { status: 'unavailable' }
      settled = true
      const flushed = await flush()
      shutdown()
      if (!flushed) return { status: 'unavailable' }
      return summarizeHostWindow({
        samples: flushed.samples,
        paging: flushed.paging,
        fromMs,
        toMs,
        intervalMs,
        platform
      })
    },
    cancel: () => {
      if (settled) return
      settled = true
      shutdown()
    }
  }
}
