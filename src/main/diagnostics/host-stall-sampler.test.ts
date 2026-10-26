import { describe, expect, it, vi } from 'vitest'

import {
  createHostStallSampler,
  parsePagingCounters,
  peekSharedHostTimeline,
  sharedHostStallSampler,
  summarizeHostTimeline,
  summarizeHostWindow
} from './host-stall-sampler'

// Real output from this machine, kept verbatim: the parser's job is to survive the padding and the trailing
// period, and a hand-written sample would have quietly been the shape the parser wants.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     3988.
Pages active:                                  86973.
Pages inactive:                                86074.
Pages speculative:                               165.
Pages throttled:                                   0.
Pages wired down:                             140484.
Pages purgeable:                                   4.
"Translation faults":                    21333567741.
Pages copy-on-write:                       472348831.
Pages zero filled:                        3565406553.
Pages reactivated:                        5237269318.
Pages purged:                               75479932.
File-backed pages:                             63989.
Anonymous pages:                               50932.
Pages stored in compressor:                   127672.
Pages occupied by compressor:                  41849.
Decompressions:                            201500273.
Compressions:                              136292745.
Pageins:                                   679321279.
Pageouts:                                   22538816.
Swapins:                                    95795235.
Swapouts:                                  105951060.
`

// The two lines the Linux path reads, in the file's real `key value` shape.
const PROC_VMSTAT = `nr_free_pages 231884
pgpgin 812391
pgpgout 48123912
pswpin 10293
pswpout 47128
`

type Sample = { at: number; cpuMs: number; freeMemMb?: number; loadAvg1m?: number }

const sample = (at: number, cpuMs: number, freeMemMb?: number, loadAvg1m?: number): Sample => ({
  at,
  cpuMs,
  ...(freeMemMb !== undefined ? { freeMemMb } : {}),
  ...(loadAvg1m !== undefined ? { loadAvg1m } : {})
})

describe('paging counters', () => {
  it('reads the darwin counters out of real vm_stat output', () => {
    expect(parsePagingCounters('darwin', VM_STAT)).toEqual({
      pageouts: 22538816,
      swapouts: 105951060
    })
  })

  it('reads the linux counters out of the vmstat file shape', () => {
    expect(parsePagingCounters('linux', PROC_VMSTAT)).toEqual({
      pageouts: 48123912,
      swapouts: 47128
    })
  })

  it('reports nothing where the platform exposes no counter we can read', () => {
    // Windows has no synchronously readable paging counter here, so the answer is "absent" — not zero.
    expect(parsePagingCounters('win32', VM_STAT)).toBeUndefined()
  })

  it('reports nothing when the text is not what it expects', () => {
    expect(parsePagingCounters('darwin', 'no such counter here')).toBeUndefined()
  })
})

describe('summarizing the stall window', () => {
  it('reports the machine as another thread saw it inside the stall', () => {
    const reading = summarizeHostWindow({
      samples: [
        sample(900, 2, 120, 3),
        sample(1_000, 10, 118, 3.5),
        sample(1_250, 10, 90, 6),
        sample(1_500, 10, 61, 7.5),
        sample(1_750, 10, 88, 4),
        // The sampler was still running when the window closed: without this edge the honest answer about
        // continuity is `unknown`, which the next case pins.
        sample(1_850, 10, 86, 4)
      ],
      fromMs: 1_000,
      toMs: 1_800,
      intervalMs: 250
    })

    expect(reading).toEqual({
      status: 'sampled',
      intervalMs: 250,
      stallMs: 800,
      samples: 4,
      expectedSamples: 2,
      maxGapMs: 250,
      continuity: 'kept-sampling',
      cpuMs: 40,
      cpuShare: 0.05,
      freeMemMbMin: 61,
      freeMemMbMax: 118,
      loadAvg1mMax: 7.5
    })
  })

  // A timeline that ends before the window does cannot say whether the sampler was still running at the far
  // edge. Reporting `kept-sampling` there is how a SIGSTOP freeze was read as a healthy machine once.
  it('says "unknown" when the timeline stops before the window does', () => {
    const reading = summarizeHostWindow({
      samples: [sample(900, 2, 120, 3), sample(1_250, 10, 90, 6), sample(1_750, 10, 88, 4)],
      fromMs: 1_000,
      toMs: 1_800,
      intervalMs: 250
    })

    expect(reading).toMatchObject({ status: 'sampled', continuity: 'unknown', maxGapMs: 500 })
  })

  it('calls a hole exactly as wide as the stall a hole, and keeps "no CPU" out of it', () => {
    // The whole process was stopped for those 2 s: the sampler's own thread stopped too, so every sample
    // sits outside the stall. Summing zero samples would claim "no CPU was used", which nobody measured.
    const reading = summarizeHostWindow({
      samples: [sample(4_800, 5, 40), sample(7_100, 5, 41)],
      fromMs: 5_000,
      toMs: 7_000,
      intervalMs: 250
    })

    expect(reading).toMatchObject({
      status: 'sampled',
      samples: 0,
      expectedSamples: 7,
      maxGapMs: 2_300,
      continuity: 'gapped'
    })
    expect(reading).not.toHaveProperty('cpuMs')
    expect(reading).not.toHaveProperty('cpuShare')
  })

  it('says "unknown" rather than "kept sampling" when there is only one anchor', () => {
    const reading = summarizeHostWindow({
      samples: [sample(5_500, 5, 40)],
      fromMs: 5_000,
      toMs: 7_000,
      intervalMs: 250
    })

    expect(reading).toMatchObject({ status: 'sampled', samples: 1, continuity: 'unknown' })
    expect(reading).not.toHaveProperty('maxGapMs')
  })

  it('names the absence when the sampler produced nothing at all', () => {
    expect(summarizeHostWindow({ samples: [], fromMs: 0, toMs: 1_000, intervalMs: 250 })).toEqual({
      status: 'no-in-stall-samples'
    })
  })

  it('turns two paging readings across the stall into a delta, and reads only readings inside it', () => {
    const withCounters = (pageouts: number, swapouts: number): string =>
      VM_STAT.replace(/^Pageouts:\s+\d+\.$/m, `Pageouts:   ${pageouts}.`).replace(
        /^Swapouts:\s+\d+\.$/m,
        `Swapouts:   ${swapouts}.`
      )

    const reading = summarizeHostWindow({
      samples: [sample(1_100, 1, 40), sample(1_900, 1, 40)],
      paging: [
        // Outside the window on both sides: neither may move the delta.
        { at: 900, text: withCounters(1, 1) },
        { at: 1_100, text: withCounters(22_538_816, 105_951_060) },
        { at: 1_900, text: withCounters(22_539_816, 105_961_060) },
        { at: 2_500, text: withCounters(9_999_999, 9_999_999) }
      ],
      fromMs: 1_000,
      toMs: 2_000,
      intervalMs: 250,
      platform: 'darwin'
    })

    expect(reading).toMatchObject({ status: 'sampled', pageouts: 1_000, swapouts: 10_000 })
    // The two in-stall readings are 800 ms apart; that is the span the delta was read across.
    expect(reading).toMatchObject({ pagingWindowMs: 800 })

    const unchanged = summarizeHostWindow({
      samples: [sample(1_100, 1, 40), sample(1_900, 1, 40)],
      paging: [
        { at: 1_100, text: VM_STAT },
        { at: 1_900, text: VM_STAT }
      ],
      fromMs: 1_000,
      toMs: 2_000,
      intervalMs: 250,
      platform: 'darwin'
    })
    expect(unchanged).toMatchObject({ pageouts: 0, swapouts: 0 })
  })

  // A 1 s paging cadence leaves a short stall with at most one reading inside it, and one reading is not a
  // delta. Falling forward to the nearest reading *before* the stall is what keeps the counters available —
  // and the span it covers is named, so "pages were thrown out around the stall" cannot be read as "during".
  it('takes the paging delta across the nearest reading before the stall, and names the wider span', () => {
    const withCounters = (pageouts: number): string =>
      VM_STAT.replace(/^Pageouts:\s+\d+\.$/m, `Pageouts:   ${pageouts}.`).replace(
        /^Swapouts:\s+\d+\.$/m,
        `Swapouts:   ${pageouts}.`
      )

    const reading = summarizeHostWindow({
      samples: [sample(1_100, 1, 40), sample(1_500, 1, 40)],
      paging: [
        { at: 400, text: withCounters(22_500_000) },
        { at: 1_450, text: withCounters(22_500_400) }
      ],
      fromMs: 1_000,
      toMs: 1_600,
      intervalMs: 250,
      platform: 'darwin'
    })

    expect(reading).toMatchObject({ status: 'sampled', pageouts: 400, swapouts: 400 })
    // 400 ms → 1 450 ms: the delta covers the quiet second before the stall as well, and says so.
    expect(reading).toMatchObject({ pagingWindowMs: 1_050 })

    // One reading alone is still not a delta, however it is anchored.
    const single = summarizeHostWindow({
      samples: [sample(1_100, 1, 40)],
      paging: [{ at: 1_450, text: withCounters(22_500_400) }],
      fromMs: 1_000,
      toMs: 1_600,
      intervalMs: 250,
      platform: 'darwin'
    })
    expect(single).not.toHaveProperty('pageouts')
    expect(single).not.toHaveProperty('pagingWindowMs')
  })
})

// The unit cases above are handed timelines. These run the real worker, because the whole point of the
// module is a timeline the main thread cannot take: if the thread does not survive a blocked loop, every
// case above passes on synthetic data while production records nothing.
describe('host sampler on its own thread', () => {
  const blockLoop = (ms: number): void => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      // Busy-wait: the stall we are measuring.
    }
  }

  it('keeps sampling while the main thread is held, and reports the stall from inside', async () => {
    const sampler = createHostStallSampler({ intervalMs: 50, pagingEveryMs: 1_000 })
    expect(sampler).toBeDefined()
    if (!sampler) throw new Error('expected a host sampler')

    try {
      // Wait until the thread has actually taken a sample, instead of sleeping a fixed time: on a thrashing
      // machine the worker can be starved for hundreds of milliseconds, and then `from` would land before the
      // first sample and the window would have no left edge at all.
      const warmupFrom = Date.now()
      let ready = await sampler.read(warmupFrom, Date.now())
      for (
        let attempt = 0;
        attempt < 40 && (ready.status !== 'sampled' || ready.samples < 1);
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        ready = await sampler.read(warmupFrom, Date.now())
      }
      expect(ready.status).toBe('sampled')

      const from = Date.now()
      // Long enough that even a badly starved sampler thread lands more than one sample inside it.
      blockLoop(1_200)
      const to = Date.now()
      const reading = await sampler.read(from, to)

      expect(reading.status).toBe('sampled')
      if (reading.status !== 'sampled') throw new Error('expected a sampled reading')
      // Fewer than two in-stall samples would mean the thread did not run while we were blocked.
      expect(reading.samples).toBeGreaterThanOrEqual(2)
      expect(reading.cpuMs).toBeGreaterThan(0)
      expect(reading.freeMemMbMin).toBeTypeOf('number')
      // Continuity is *evidence*, not a contract: on a loaded machine the worker's own ticks stretch, so it
      // is asserted only where the timeline is synthetic.
      expect(['kept-sampling', 'gapped']).toContain(reading.continuity)
    } finally {
      sampler.stop()
    }
  }, 30_000)

  // The reason the sampler is permanent: a read must not end the recording, or the next stall (and the one
  // after it) would again be described by a thread that started after the event.
  it('answers a second read from the same uninterrupted timeline', async () => {
    const sampler = createHostStallSampler({ intervalMs: 50, pagingEveryMs: 1_000 })
    if (!sampler) throw new Error('expected a host sampler')

    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      const firstFrom = Date.now()
      blockLoop(200)
      const first = await sampler.read(firstFrom, Date.now())

      await new Promise((resolve) => setTimeout(resolve, 150))
      const secondFrom = Date.now()
      blockLoop(200)
      const second = await sampler.read(secondFrom, Date.now())

      expect(first.status).toBe('sampled')
      expect(second.status).toBe('sampled')
      if (first.status !== 'sampled' || second.status !== 'sampled') return
      expect(second.samples).toBeGreaterThanOrEqual(2)
    } finally {
      sampler.stop()
    }
  }, 15_000)

  // A permanent sampler has to hold a fixed amount of memory: the ring drops the oldest sample instead of
  // growing. With the cap driven down to 10 and a 5 ms cadence, a window wider than the whole run can only
  // report the cap — anything more would mean the ring never dropped anything.
  it('drops the oldest samples when the ring is full, and still reports the recent past', async () => {
    const sampler = createHostStallSampler({ intervalMs: 5, pagingEveryMs: 1_000, maxSamples: 10 })
    if (!sampler) throw new Error('expected a host sampler')

    try {
      const from = Date.now()
      // Wait for the ring to fill instead of sleeping a fixed time: a loaded machine can stretch the
      // worker's own ticks, and a fixed sleep would then assert on the load rather than on the ring.
      let reading = await sampler.read(from, Date.now())
      for (
        let attempt = 0;
        attempt < 40 && (reading.status !== 'sampled' || reading.samples < 10);
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        reading = await sampler.read(from, Date.now())
      }

      expect(reading.status).toBe('sampled')
      if (reading.status !== 'sampled') return
      // A window wider than the whole run can only report the cap: anything more would mean the ring never
      // dropped anything, anything less would mean it dropped the samples the stall needs.
      expect(reading.samples).toBe(10)
      expect(reading.freeMemMbMin).toBeTypeOf('number')
    } finally {
      sampler.stop()
    }
  }, 15_000)

  it('reports "unavailable" when the thread never answers instead of pretending it saw nothing', async () => {
    const sampler = createHostStallSampler({
      workerSource: 'throw new Error("this sampler cannot start")',
      readTimeoutMs: 100
    })
    expect(sampler).toBeDefined()
    if (!sampler) throw new Error('expected a host sampler')

    expect(await sampler.read(0, 1_000)).toEqual({ status: 'unavailable' })
    sampler.stop()
  }, 10_000)

  it('reports "unavailable" after stop() rather than reading a closed thread', async () => {
    const sampler = createHostStallSampler({ intervalMs: 50 })
    if (!sampler) throw new Error('expected a host sampler')

    await new Promise((resolve) => setTimeout(resolve, 100))
    sampler.stop()
    expect(await sampler.read(0, Date.now())).toEqual({ status: 'unavailable' })
  }, 10_000)
})

// What the bundle carries: the ring as a whole, not a stall window. Pure cases first, because the section's
// value is entirely in its named states — an empty list that could mean "calm machine", "just started" or
// "never started" is worse than no section at all.
describe('the timeline a bundle carries', () => {
  const sample = (at: number, cpuMs: number): { at: number; cpuMs: number; freeMemMb: number } => ({
    at,
    cpuMs,
    freeMemMb: 120
  })

  it('keeps the whole ring, in order, with the window and the drop counters it was read from', () => {
    const timeline = summarizeHostTimeline({
      snapshot: {
        samples: [sample(3_000, 3), sample(1_000, 1), sample(2_000, 2)],
        paging: [
          { at: 1_000, text: VM_STAT.replace(/^Pageouts:\s+\d+\.$/m, 'Pageouts:   900.') },
          { at: 2_000, text: VM_STAT.replace(/^Pageouts:\s+\d+\.$/m, 'Pageouts:   950.') }
        ],
        sampleCapacity: 1_200,
        pagingCapacity: 120,
        samplesDropped: 4_800,
        pagingDropped: 300
      },
      intervalMs: 250,
      platform: 'darwin',
      nowMs: Date.parse('2026-10-26T10:00:00.000Z')
    })

    expect(timeline.status).toBe('timeline')
    if (timeline.status !== 'timeline') throw new Error('expected a timeline')
    expect(timeline.capturedAt).toBe('2026-10-26T10:00:00.000Z')
    // Ordered by time, and every reading is present: a bundle that dropped the middle of a timeline would
    // still report a plausible `sampleCount`.
    expect(timeline.samples.map((entry) => entry.cpuMs)).toEqual([1, 2, 3])
    expect(timeline.sampleCount).toBe(3)
    expect(timeline.oldestAt).toBe(new Date(1_000).toISOString())
    expect(timeline.newestAt).toBe(new Date(3_000).toISOString())
    expect(timeline.spanMs).toBe(2_000)
    // The two numbers that separate "five minutes of history" from "started a minute ago".
    expect(timeline.sampleCapacity).toBe(1_200)
    expect(timeline.samplesDropped).toBe(4_800)
    expect(timeline.paging.status).toBe('readings')
    if (timeline.paging.status !== 'readings') throw new Error('expected paging readings')
    expect(timeline.paging.readings.map((entry) => entry.pageouts)).toEqual([900, 950])
    expect(timeline.paging.dropped).toBe(300)
  })

  it('names "no samples yet" instead of shipping an empty list', () => {
    const timeline = summarizeHostTimeline({
      snapshot: { samples: [], paging: [], sampleCapacity: 1_200 },
      intervalMs: 250,
      platform: 'darwin',
      nowMs: 0
    })

    expect(timeline.status).toBe('no-samples')
    if (timeline.status !== 'no-samples') throw new Error('expected a named empty state')
    expect(timeline.sampleCapacity).toBe(1_200)
    // Nothing parsed is its own reason, distinct from a platform that exposes no such counters at all.
    expect(timeline.paging).toEqual({ status: 'unavailable', reason: 'no-counters-parsed' })
  })

  it('says the platform exposes no paging counters rather than reporting zero paging', () => {
    const timeline = summarizeHostTimeline({
      snapshot: { samples: [sample(1_000, 1)], paging: [] },
      intervalMs: 250,
      platform: 'win32',
      nowMs: 0
    })

    expect(timeline.status).toBe('timeline')
    if (timeline.status !== 'timeline') throw new Error('expected a timeline')
    expect(timeline.paging).toEqual({
      status: 'unavailable',
      reason: 'platform-exposes-no-counters'
    })
    // Absent, not zero: a machine whose counters cannot be read must not look like one that never paged.
    expect(timeline.sampleCapacity).toBeUndefined()
    expect(timeline.samplesDropped).toBeUndefined()
  })

  it('snapshots the live ring with its cap and how much the cap already discarded', async () => {
    const sampler = createHostStallSampler({ intervalMs: 10, maxSamples: 3 })
    if (!sampler) throw new Error('expected a host sampler')

    try {
      // Wait for the cap to bite: three samples arrive in ~30 ms, but a starved worker can take longer.
      let snapshot = await sampler.snapshot()
      for (let attempt = 0; attempt < 40 && (snapshot?.samplesDropped ?? 0) === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        snapshot = await sampler.snapshot()
      }

      expect(snapshot?.sampleCapacity).toBe(3)
      expect(snapshot?.samples).toHaveLength(3)
      expect(snapshot?.samplesDropped).toBeGreaterThan(0)
      // Oldest-first ring: the kept samples must be the newest ones, or the timeline would describe the past
      // the sampler no longer has.
      const times = (snapshot?.samples ?? []).map((entry) => entry.at)
      expect([...times].sort((left, right) => left - right)).toEqual(times)
    } finally {
      sampler.stop()
    }
  }, 20_000)

  it('reads the timeline from the sampler the watchdog started, through the shared accessor', async () => {
    const shared = sharedHostStallSampler()
    if (!shared) throw new Error('expected the shared sampler to start on this platform')

    try {
      const timeline = await peekSharedHostTimeline({
        nowMs: Date.parse('2026-10-26T10:00:00.000Z')
      })
      expect(timeline.status).toBe('timeline')
      if (timeline.status !== 'timeline') throw new Error('expected a timeline')
      expect(timeline.capturedAt).toBe('2026-10-26T10:00:00.000Z')
      // The worker samples once before answering, so a fresh sampler still has a reading to hand over.
      expect(timeline.sampleCount).toBeGreaterThanOrEqual(1)
      expect(timeline.sampleCapacity).toBeGreaterThan(0)
    } finally {
      shared.stop()
    }
  }, 20_000)

  it('says "sampler-not-started" when a bundle is exported before the watchdog exists', async () => {
    // A fresh module registry: the accessor above already started the shared instance in this one.
    vi.resetModules()
    const fresh = await import('./host-stall-sampler')
    const timeline = await fresh.peekSharedHostTimeline({ nowMs: 0 })

    expect(timeline).toEqual({
      status: 'unavailable',
      capturedAt: '1970-01-01T00:00:00.000Z',
      reason: 'sampler-not-started'
    })
  })
})
