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
// Why it runs permanently and reads on demand: the sampler used to be created by the *first* stall and
// killed 15 s later, so that first stall — often the longest of a burst — could only report
// `window-armed`, i.e. a thread that started after the event had seen nothing inside it. A sampler that
// only exists after the fact can never answer the one question it was built for. So the worker now keeps
// a bounded ring of the most recent samples and answers `read` messages without being torn down: every
// stall, including the first, reads a timeline that was already being taken.
//
// Cost is measured, not assumed (2026-10-25, 8-core machine, 10 s of idle running per row):
//   - the sampling loop alone (cpu/load/free/rss at 250 ms): 4.4 ms CPU per 10 s = 0.04 % of one core;
//   - one paging read costs 1.6 ms CPU / 13.3 ms wall (a `vm_stat` child process), so the cadence was
//     widened from 500 ms to 1 s: 20.8 ms CPU per 10 s = 0.21 % of one core (at 500 ms it was 0.48 %).
// The ring is what keeps that permanent: 1,200 samples ≈ 5 min at 250 ms, 120 paging texts ≈ 2 min at 1 s.
//
// The sampler does raw IO only (OS calls inside the worker); interpreting the platform's paging text
// happens back on the main thread in `parsePagingCounters`, so the parsing rules have exactly one home and
// can be tested without a stall.

const DEFAULT_INTERVAL_MS = 250
const DEFAULT_PAGING_EVERY_MS = 1_000
// A read that never gets an answer must not turn a diagnostic into a hang: report "unavailable" instead.
const READ_TIMEOUT_MS = 1_500
// A reply can be late (the worker thread is starved like everything else). One late answer is not a broken
// sampler; three in a row is, and then the thread is closed instead of being asked forever.
const MAX_READ_FAILURES = 3
// A hole is called a hole only when it is wider than a few ordinary ticks (a busy sampler at 250 ms stays
// well under 3x unless something stopped it). Heuristic, named, and reported next to the raw `maxGapMs`.
const GAP_FACTOR = 3
// Ring caps, not a truncation point: when full, the oldest entry is dropped, so a permanent sampler holds a
// fixed amount of memory and always describes the recent past.
const MAX_BUFFERED_SAMPLES = 1_200
const MAX_BUFFERED_PAGING = 120

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
  // How wide the span the paging delta was read across actually is. The counters are cumulative, so two
  // readings are the minimum; when the cadence leaves fewer than two inside the stall, the delta is taken
  // across the nearest reading before it — which makes the span wider than the stall. Naming the width is
  // how a reader can tell "paging during the stall" from "paging in the second around it".
  pagingWindowMs?: number
}

export type HostStallReading =
  | HostStallSlice
  // No thread available, or the thread produced neither an in-stall sample nor a pair straddling the
  // stall. Named so it can never be read as "the machine was fine".
  | { status: 'unavailable' }
  | { status: 'no-in-stall-samples' }

export type HostStallSampler = {
  // Answers what the thread saw inside `[fromMs, toMs]`. Reading does not stop the thread: the next stall
  // gets a timeline too, from a sampler that never had to start after the event.
  read: (fromMs: number, toMs: number) => Promise<HostStallReading>
  stop: () => void
}

export type HostStallSamplerInput = {
  intervalMs?: number
  pagingEveryMs?: number
  // Ring caps. Seams so a test can fill the ring without running for five minutes; production leaves them.
  maxSamples?: number
  maxPaging?: number
  // Seams. Tests replace the worker program; production leaves it alone.
  workerSource?: string
  platform?: NodeJS.Platform
  readTimeoutMs?: number
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
const maxPaging = workerData.maxPaging

const samples = []
const paging = []
let previous = process.cpuUsage()
let lastPagingAt = 0

// Bounded from the oldest end: a permanent sampler must not grow for the life of the process, and the
// recent past is the only part any stall can ask about.
const push = (list, value, cap) => {
  list.push(value)
  if (list.length > cap) list.splice(0, list.length - cap)
}

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
    push(paging, { at: lastPagingAt, text: text }, maxPaging)
  } catch {
    // An unreadable counter stays absent; a missing reading is not a zero.
  }
}

const sample = () => {
  const at = Date.now()
  const cpu = process.cpuUsage(previous)
  previous = process.cpuUsage()
  const load = loadavg()[0]
  push(samples, {
    at: at,
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    freeMemMb: Math.round(freemem() / 1e6),
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
    ...(Number.isFinite(load) ? { loadAvg1m: Number(load.toFixed(2)) } : {})
  }, maxSamples)
  if (at - lastPagingAt >= pagingEveryMs) readPaging()
}

sample()
const timer = setInterval(sample, intervalMs)
timer.unref()

parentPort.on('message', (message) => {
  if (!message) return
  if (message.kind === 'read') {
    // Take one sample *now*, before answering. Without it the snapshot can end before the window the reader
    // asked about does — and a timeline that stops early cannot say whether the sampler was still running at
    // the window's far edge, which is exactly the evidence a freeze needs (measured: a SIGSTOP read answered
    // from a pre-freeze snapshot reported kept-sampling with a 251 ms max gap).
    sample()
    // A snapshot, not a flush: the ring keeps filling, so the next stall is served by the same thread.
    parentPort.postMessage({
      kind: 'read',
      requestId: message.requestId,
      samples: samples,
      paging: paging
    })
    return
  }
  if (message.kind === 'stop') {
    clearInterval(timer)
    parentPort.close()
  }
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
  // Continuity is a claim about what happened *across* the window, and it needs evidence on both sides of it:
  // a sample at or before the start (the thread was running when the stall began) and one at or after the end
  // (it was running when the stall ended). With only one edge the honest answer is `unknown` — measured: a
  // read answered from a snapshot that stopped before the window's end reported `kept-sampling` for a SIGSTOP
  // freeze, because the dense pre-freeze samples were the only pair the gap search could see.
  const hasOpeningSample = timeline.some((sample) => sample.at <= input.fromMs)
  const hasClosingSample = timeline.some((sample) => sample.at >= input.toMs)
  const continuity =
    !hasOpeningSample || !hasClosingSample || maxGapMs === undefined
      ? 'unknown'
      : maxGapMs >= input.intervalMs * GAP_FACTOR
        ? 'gapped'
        : 'kept-sampling'

  const cpuMs = sum(inside.map((sample) => sample.cpuMs))
  const freeMem = collect(inside.map((sample) => sample.freeMemMb))
  const loadAvg = collect(inside.map((sample) => sample.loadAvg1m))
  const rss = collect(inside.map((sample) => sample.rssMb))
  // Paging is cumulative, so a delta needs two readings. Two inside the stall is the tight answer; when the
  // cadence leaves only one (or none), the delta is taken from the nearest reading before the stall, and
  // `pagingWindowMs` reports the wider span that actually got measured.
  const insideReadings = (input.paging ?? [])
    .filter((reading) => reading.at >= input.fromMs && reading.at <= input.toMs)
    .sort((left, right) => left.at - right.at)
  const straddle = (): PagingReading[] => {
    if (insideReadings.length >= 2) return insideReadings
    const before = (input.paging ?? [])
      .filter((reading) => reading.at < input.fromMs)
      .sort((left, right) => left.at - right.at)
      .slice(-1)
    return [...before, ...insideReadings]
  }
  const anchored = straddle()
  const counters = anchored
    .map((reading) => ({
      at: reading.at,
      counters: parsePagingCounters(input.platform ?? process.platform, reading.text)
    }))
    .filter(
      (entry): entry is { at: number; counters: PagingCounters } => entry.counters !== undefined
    )
  const readDelta = (
    pick: (counters: PagingCounters) => number | undefined
  ): number | undefined => {
    const values = collect(counters.map((entry) => pick(entry.counters)))
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
  const firstAnchor = counters[0]
  const lastAnchor = counters[counters.length - 1]
  const pagingWindowMs =
    counters.length >= 2 && firstAnchor && lastAnchor ? lastAnchor.at - firstAnchor.at : undefined

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
    ...(swapouts !== undefined ? { swapouts } : {}),
    ...(pagingWindowMs !== undefined ? { pagingWindowMs } : {})
  }
}

type ReadReply = {
  kind?: string
  requestId?: number
  samples?: HostSample[]
  paging?: PagingReading[]
}

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
        maxSamples: input.maxSamples ?? MAX_BUFFERED_SAMPLES,
        maxPaging: input.maxPaging ?? MAX_BUFFERED_PAGING
      }
    })
  } catch {
    // No worker: the caller records `unavailable` rather than a stall with no machine reading as if the
    // machine had been fine.
    return undefined
  }
  // A diagnostics thread must never hold the process open.
  worker.unref()
  let closed = false
  let nextRequestId = 1
  let consecutiveFailures = 0
  const waiters = new Map<number, (reply: ReadReply | undefined) => void>()

  const close = (): void => {
    if (closed) return
    closed = true
    for (const waiter of [...waiters.values()]) waiter(undefined)
    waiters.clear()
    void worker.terminate().catch(() => undefined)
  }

  worker.on('message', (message: unknown) => {
    const reply = message as ReadReply
    if (reply?.kind !== 'read' || typeof reply.requestId !== 'number') return
    const waiter = waiters.get(reply.requestId)
    // A reply nobody is waiting for any more is dropped: request ids make a late answer harmless.
    if (!waiter) return
    waiters.delete(reply.requestId)
    consecutiveFailures = 0
    waiter(reply)
  })
  worker.on('error', () => {
    // Errors are surfaced as `unavailable` through the pending reads and the close below.
    close()
  })
  worker.on('exit', () => {
    closed = true
    for (const waiter of [...waiters.values()]) waiter(undefined)
    waiters.clear()
  })

  const request = (): Promise<ReadReply | undefined> =>
    new Promise<ReadReply | undefined>((resolve) => {
      if (closed) {
        resolve(undefined)
        return
      }
      const requestId = nextRequestId
      nextRequestId += 1
      const timer = setTimeout(() => {
        // Only the timeout that still owns its slot may answer; a late reply that arrived first already has.
        if (!waiters.delete(requestId)) return
        consecutiveFailures += 1
        // Late can happen while the machine is starved; never-answering cannot be waited on forever.
        if (consecutiveFailures >= MAX_READ_FAILURES) close()
        resolve(undefined)
      }, input.readTimeoutMs ?? READ_TIMEOUT_MS)
      timer.unref?.()
      waiters.set(requestId, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      try {
        worker.postMessage({ kind: 'read', requestId })
      } catch {
        waiters.delete(requestId)
        clearTimeout(timer)
        close()
        resolve(undefined)
      }
    })

  // One read at a time: two stalls can land back to back and each reply has to be matched to its own window.
  let chain: Promise<unknown> = Promise.resolve()

  return {
    read: (fromMs, toMs) => {
      const answer = chain.then(async (): Promise<HostStallReading> => {
        const reply = await request()
        if (!reply) return { status: 'unavailable' }
        return summarizeHostWindow({
          samples: reply.samples ?? [],
          paging: reply.paging ?? [],
          fromMs,
          toMs,
          intervalMs,
          platform
        })
      })
      chain = answer.then(
        () => undefined,
        () => undefined
      )
      return answer
    },
    stop: () => close()
  }
}
