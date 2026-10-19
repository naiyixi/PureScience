import { describe, expect, it } from 'vitest'

import {
  createHostStallSampler,
  parsePagingCounters,
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
        sample(1_750, 10, 88, 4)
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
})

// The unit cases above are handed timelines. This one runs the real worker, because the whole point of the
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
      // Let the thread take a couple of samples before the stall so the window has an anchor.
      await new Promise((resolve) => setTimeout(resolve, 200))
      const from = Date.now()
      blockLoop(600)
      const to = Date.now()
      const reading = await sampler.stop(from, to)

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
      sampler.cancel()
    }
  }, 15_000)

  it('reports "unavailable" when the thread never answers instead of pretending it saw nothing', async () => {
    const sampler = createHostStallSampler({
      workerSource: 'throw new Error("this sampler cannot start")',
      flushTimeoutMs: 100
    })
    expect(sampler).toBeDefined()
    if (!sampler) throw new Error('expected a host sampler')

    expect(await sampler.stop(0, 1_000)).toEqual({ status: 'unavailable' })
  }, 10_000)
})
