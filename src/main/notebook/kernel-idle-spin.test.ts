import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  KernelIdleSpinMonitor,
  createKernelMemoryRing,
  parseCumulativeCpuTime,
  parseResidentBytes,
  type IdleKernelTarget,
  type IdleSpinReport,
  type IdleSpinUnsampledReason,
  type KernelCpuProbe,
  type KernelCpuReading,
  type KernelMemoryProbe,
  type KernelMemoryReading,
  type KernelMemoryRing
} from './kernel-idle-spin'
import { NotebookKernelExecutor } from './kernel-executor'

const REPL_LOOP = join(__dirname, '../../../resources/notebook/repl_loop.js')

// -- ps's cumulative cpu text ----------------------------------------------------------------

describe('parseCumulativeCpuTime', () => {
  it('reads the three forms ps prints, short form first', () => {
    // Exactly the strings this machine's `ps -o time=` produced for a real process (see the module
    // header): minutes:seconds until an hour is reached, then hours, then a day prefix.
    expect(parseCumulativeCpuTime('  0:01.58\n')).toBe(1_580)
    expect(parseCumulativeCpuTime('3:38.61')).toBe(218_610)
    expect(parseCumulativeCpuTime('12:03:04.50')).toBe(43_384_500)
    expect(parseCumulativeCpuTime('1-02:03:04')).toBe(93_784_000)
  })

  it('returns undefined for anything it cannot read, never 0', () => {
    // A dead pid makes ps exit non-zero with empty output; reading that as 0 ms would look like a
    // perfectly idle kernel forever, which is the one conclusion this observation must not invent.
    expect(parseCumulativeCpuTime('')).toBeUndefined()
    expect(parseCumulativeCpuTime('   ')).toBeUndefined()
    expect(parseCumulativeCpuTime('??')).toBeUndefined()
    expect(parseCumulativeCpuTime('1:2:3:4:5')).toBeUndefined()
  })
})

// -- ps's resident-set text ------------------------------------------------------------------

describe('parseResidentBytes', () => {
  it('reads the bare kilobyte count ps prints and converts it to bytes', () => {
    // Exactly the shape `ps -o rss=` produced on this machine for a real kernel (see the module header):
    // one number, sometimes padded, sometimes with a trailing newline.
    expect(parseResidentBytes('  204800\n')).toBe(209_715_200)
    expect(parseResidentBytes('4096')).toBe(4_194_304)
  })

  it('returns undefined for anything it cannot read, and never 0', () => {
    // A dead pid makes ps exit non-zero with empty output. Reading that as 0 bytes would look like a
    // kernel holding nothing, which is the one conclusion this observation must not invent.
    expect(parseResidentBytes('')).toBeUndefined()
    expect(parseResidentBytes('   ')).toBeUndefined()
    expect(parseResidentBytes('0')).toBeUndefined()
    expect(parseResidentBytes('1234K')).toBeUndefined()
    expect(parseResidentBytes('1.5')).toBeUndefined()
  })
})

// -- the decision logic, driven with a fake probe and a fake clock ----------------------------

type Harness = {
  monitor: KernelIdleSpinMonitor
  reports: IdleSpinReport[]
  unsampled: IdleSpinUnsampledReason[]
  memoryRing: KernelMemoryRing
  setTargets: (targets: IdleKernelTarget[]) => void
  setReading: (reading: KernelCpuReading) => void
  setMemoryReading: (reading: KernelMemoryReading) => void
  advance: (ms: number) => void
  probeCalls: () => number
  memoryProbeCalls: () => number
}

const TARGET: IdleKernelTarget = {
  key: 'python:default',
  kind: 'python',
  env: 'default',
  pid: 4242
}

const makeHarness = (options: { platform?: NodeJS.Platform; threshold?: number } = {}): Harness => {
  let targets: IdleKernelTarget[] = [TARGET]
  let reading: KernelCpuReading = { status: 'observed', cpuMs: 0 }
  let memoryReading: KernelMemoryReading = { status: 'observed', residentBytes: 8_000_000 }
  let clock = 1_000
  let calls = 0
  let memoryCalls = 0
  const reports: IdleSpinReport[] = []
  const unsampled: IdleSpinUnsampledReason[] = []
  const probe: KernelCpuProbe = async (): Promise<KernelCpuReading> => {
    calls += 1
    return reading
  }
  const memoryProbe: KernelMemoryProbe = async (): Promise<KernelMemoryReading> => {
    memoryCalls += 1
    return memoryReading
  }
  // Its own ring, never the process-wide one: a unit test's readings must not land in the ledger the
  // support bundle of a running process reads.
  const memoryRing = createKernelMemoryRing()
  const monitor = new KernelIdleSpinMonitor({
    listIdleKernels: (): IdleKernelTarget[] => targets,
    onSpin: (report): void => {
      reports.push(report)
    },
    onUnsampled: (reason): void => {
      unsampled.push(reason)
    },
    probe,
    memoryProbe,
    memoryRing,
    platform: options.platform ?? 'darwin',
    thresholdPercent: options.threshold ?? 50,
    now: (): number => clock,
    // The interval is never used: sampleOnce() is driven by hand so every window is exact.
    schedule: (): { cancel: () => void } => ({ cancel: (): void => {} })
  })
  return {
    monitor,
    reports,
    unsampled,
    memoryRing,
    setTargets: (next): void => {
      targets = next
    },
    setReading: (next): void => {
      reading = next
    },
    setMemoryReading: (next): void => {
      memoryReading = next
    },
    advance: (ms): void => {
      clock += ms
    },
    probeCalls: (): number => calls,
    memoryProbeCalls: (): number => memoryCalls
  }
}

const sample = async (harness: Harness, cpuMs: number, windowMs = 1_000): Promise<void> => {
  harness.setReading({ status: 'observed', cpuMs })
  harness.advance(windowMs)
  await harness.monitor.sampleOnce()
}

describe('KernelIdleSpinMonitor', () => {
  it('reports once after two consecutive samples above the threshold, then stays quiet', async () => {
    const harness = makeHarness()
    await sample(harness, 0) // baseline only: a single sample is not a window
    expect(harness.reports).toHaveLength(0)

    await sample(harness, 900) // 90% over 1 s — first spinning window
    expect(harness.reports).toHaveLength(0)

    await sample(harness, 1_800) // second: now it is a streak
    expect(harness.reports).toHaveLength(1)
    expect(harness.reports[0]).toMatchObject({
      key: 'python:default',
      kind: 'python',
      env: 'default',
      pid: 4242,
      cpuPercent: 90,
      windowMs: 1_000,
      thresholdPercent: 50,
      consecutiveSamples: 2
    })

    // One line per spin episode: a kernel that keeps spinning must not fill the log every tick.
    await sample(harness, 2_700)
    await sample(harness, 3_600)
    expect(harness.reports).toHaveLength(1)
  })

  it('re-arms after a quiet window, so a kernel that spins again is reported again', async () => {
    const harness = makeHarness()
    await sample(harness, 0)
    await sample(harness, 900)
    await sample(harness, 1_800)
    expect(harness.reports).toHaveLength(1)

    await sample(harness, 1_810) // 1% — quiet again
    await sample(harness, 2_710) // 90%
    await sample(harness, 3_610) // 90% — a new episode
    expect(harness.reports).toHaveLength(2)
  })

  it('stays silent when the kernel is really idle', async () => {
    const harness = makeHarness()
    for (let index = 0; index < 5; index += 1) await sample(harness, index * 2)
    expect(harness.reports).toHaveLength(0)
    expect(harness.probeCalls()).toBe(5)
  })

  it('does not sample a kernel that stopped being idle, and drops its baseline', async () => {
    const harness = makeHarness()
    await sample(harness, 0)
    // A request started: nothing is idle, so nothing is probed.
    harness.setTargets([])
    harness.advance(1_000)
    await harness.monitor.sampleOnce()
    expect(harness.probeCalls()).toBe(1)

    // Back to idle with far more cumulative cpu time: this must be a new baseline, not a 10 s window.
    harness.setTargets([TARGET])
    await sample(harness, 30_000, 60_000)
    expect(harness.reports).toHaveLength(0)
    await sample(harness, 30_900) // 90% — first window of the new episode
    expect(harness.reports).toHaveLength(0)
    await sample(harness, 31_800) // second consecutive window
    expect(harness.reports).toHaveLength(1)
    expect(harness.reports[0].windowMs).toBe(1_000)
  })

  it('takes a fresh baseline when the kernel was respawned under the same key', async () => {
    const harness = makeHarness()
    await sample(harness, 5_000)
    harness.setTargets([{ ...TARGET, pid: 5151 }])
    await sample(harness, 10) // new pid: cpu time legitimately starts over
    expect(harness.reports).toHaveLength(0)
    await sample(harness, 910)
    expect(harness.reports).toHaveLength(0)
    await sample(harness, 1_810)
    expect(harness.reports).toHaveLength(1)
    expect(harness.reports[0].pid).toBe(5151)
  })

  it('names a failed probe instead of counting it as idle, once', async () => {
    const harness = makeHarness()
    harness.setReading({ status: 'unsampled', reason: 'probe-failed' })
    await harness.monitor.sampleOnce()
    await harness.monitor.sampleOnce()
    expect(harness.unsampled).toEqual(['probe-failed'])
    expect(harness.reports).toHaveLength(0)
  })

  it('reports the platform without a probe as unsupported and never samples', () => {
    const harness = makeHarness({ platform: 'win32' })
    harness.monitor.start()
    expect(harness.monitor.running).toBe(false)
    expect(harness.unsampled).toEqual(['unsupported-platform'])
    expect(harness.probeCalls()).toBe(0)
  })
})

// -- the memory ledger -----------------------------------------------------------------------

describe('createKernelMemoryRing', () => {
  it('keeps one reading per idle kernel per round, and a total that says how many it covers', () => {
    const ring = createKernelMemoryRing()
    ring.noteMonitorStarted()
    ring.recordRound({
      at: '2026-11-17T13:00:00.000Z',
      entries: [
        {
          key: 'python:default',
          kind: 'python',
          env: 'default',
          pid: 4201,
          reading: { status: 'observed', residentBytes: 470_000_000 }
        },
        {
          key: 'python:chem',
          kind: 'python',
          env: 'chem',
          pid: 4202,
          reading: { status: 'observed', residentBytes: 130_000_000 }
        },
        {
          key: 'r:default',
          kind: 'r',
          env: 'default',
          pid: 4203,
          reading: { status: 'unmeasured', reason: 'probe-failed' }
        }
      ]
    })

    const summary = ring.summary()
    expect(summary.status).toBe('samples')
    expect(summary.monitor).toBe('running')
    expect(summary.rounds).toBe(1)
    expect(summary.dropped).toBe(0)
    expect(summary.latest.map((sample) => sample.key)).toEqual(['python:default', 'python:chem'])
    expect(summary.records.map((sample) => sample.residentBytes)).toEqual([
      470_000_000, 130_000_000
    ])
    // The round counts are the reason the total is readable: 600 MB is what the two measured kernels hold,
    // and the third one is named as unmeasured rather than folded in as zero.
    expect(summary.last).toEqual({
      at: '2026-11-17T13:00:00.000Z',
      kernels: 3,
      measured: 2,
      unmeasured: 1,
      totalResidentBytes: 600_000_000
    })
    expect(summary.unmeasuredReasons).toEqual(['probe-failed'])
  })

  it('keeps a round whose probes all failed as a named reason, with no total at all', () => {
    const ring = createKernelMemoryRing()
    ring.noteMonitorStarted()
    ring.recordRound({
      at: '2026-11-17T13:00:15.000Z',
      entries: [
        {
          key: 'python:default',
          kind: 'python',
          env: 'default',
          pid: 4201,
          reading: { status: 'unmeasured', reason: 'parse-failed' }
        }
      ]
    })

    const summary = ring.summary()
    // No invented zeros: an empty `latest` beside a `parse-failed` status is the honest answer.
    expect(summary.latest).toEqual([])
    expect(summary.records).toEqual([])
    expect(summary.status).toBe('parse-failed')
    expect(summary.last).toEqual({
      at: '2026-11-17T13:00:15.000Z',
      kernels: 1,
      measured: 0,
      unmeasured: 1
    })
    expect(summary.last && 'totalResidentBytes' in summary.last).toBe(false)
  })

  it('does not count a round in which no kernel was idle', () => {
    const ring = createKernelMemoryRing()
    ring.noteMonitorStarted()
    ring.recordRound({ at: '2026-11-17T13:00:00.000Z', entries: [] })

    const summary = ring.summary()
    expect(summary.rounds).toBe(0)
    expect(summary.last).toBeUndefined()
    // The monitor ran and there was nothing to look at: that is `no-samples`, not "holding nothing" and not
    // "nobody was watching".
    expect(summary.status).toBe('no-samples')
    expect(summary.monitor).toBe('running')
  })

  it('names the monitor state instead of leaving an empty list to be read as a quiet machine', () => {
    const untouched = createKernelMemoryRing()
    expect(untouched.summary().status).toBe('monitor-not-started')
    expect(untouched.summary().monitor).toBe('never-started')

    const stopped = createKernelMemoryRing()
    stopped.noteMonitorStarted()
    stopped.noteMonitorStopped()
    expect(stopped.summary().monitor).toBe('stopped')

    const unsupported = createKernelMemoryRing()
    unsupported.noteUnsampled('unsupported-platform')
    expect(unsupported.summary().status).toBe('unsupported-platform')
  })

  it('rotates the timeline but keeps the newest reading per kernel', () => {
    const ring = createKernelMemoryRing({ capacity: 2, roundCapacity: 2 })
    ring.noteMonitorStarted()
    for (const [index, bytes] of [10, 20, 30].entries()) {
      ring.recordRound({
        at: `2026-11-17T13:00:0${index}.000Z`,
        entries: [
          {
            key: 'python:default',
            kind: 'python',
            env: 'default',
            pid: 4201,
            reading: { status: 'observed', residentBytes: bytes }
          }
        ]
      })
    }

    const summary = ring.summary()
    expect(summary.records.map((sample) => sample.residentBytes)).toEqual([20, 30])
    expect(summary.dropped).toBe(1)
    expect(summary.latest.map((sample) => sample.residentBytes)).toEqual([30])
  })
})

describe('KernelIdleSpinMonitor memory rounds', () => {
  it('records one round per tick, over the same kernels it measured for cpu', async () => {
    const harness = makeHarness()
    await sample(harness, 0)
    await sample(harness, 10)

    const summary = harness.memoryRing.summary()
    expect(summary.rounds).toBe(2)
    expect(summary.records.map((sample) => sample.pid)).toEqual([4242, 4242])
    expect(summary.latest[0]).toMatchObject({ key: 'python:default', residentBytes: 8_000_000 })
    expect(summary.last).toMatchObject({ kernels: 1, measured: 1, unmeasured: 0 })
  })

  it('keeps measuring cpu when the memory probe fails — the two readings are independent', async () => {
    const harness = makeHarness()
    await sample(harness, 0)
    harness.setMemoryReading({ status: 'unmeasured', reason: 'probe-failed' })
    await sample(harness, 900)
    await sample(harness, 1_800)

    // The spin was still detected from cpu windows...
    expect(harness.reports).toHaveLength(1)
    // ...and the memory round says it could not measure, without inventing a level.
    const summary = harness.memoryRing.summary()
    expect(summary.status).toBe('samples') // the first tick did measure
    expect(summary.unmeasuredReasons).toEqual(['probe-failed'])
    expect(summary.last).toMatchObject({ kernels: 1, measured: 0, unmeasured: 1 })
  })

  it('does not sample memory on a platform without a probe', async () => {
    const harness = makeHarness({ platform: 'win32' })
    harness.monitor.start()
    expect(harness.memoryProbeCalls()).toBe(0)
    expect(harness.memoryRing.summary().status).toBe('unsupported-platform')
  })
})

// -- the real probe against a real spinning process ------------------------------------------

let spinning: ChildProcess | undefined

afterEach(() => {
  spinning?.kill('SIGKILL')
  spinning = undefined
})

describe.skipIf(process.platform === 'win32')('KernelIdleSpinMonitor (real ps probe)', () => {
  it('measures a real spinning process above the threshold', async () => {
    // A real child that does nothing but burn cpu, sampled by the REAL `ps -o time=` probe. This is the
    // half a stubbed probe cannot prove: that the platform's cumulative-cpu reading is what the module
    // thinks it is.
    spinning = spawn(
      process.execPath,
      ['-e', 'const end = Date.now() + 6000; while (Date.now() < end) {}'],
      {
        stdio: 'ignore'
      }
    )
    const pid = spinning.pid
    expect(pid).toBeGreaterThan(0)

    const reports: IdleSpinReport[] = []
    const monitor = new KernelIdleSpinMonitor({
      listIdleKernels: (): IdleKernelTarget[] => [
        { key: 'python:default', kind: 'python', env: 'default', pid: pid as number }
      ],
      onSpin: (report): void => {
        reports.push(report)
      },
      platform: 'darwin',
      intervalMs: 250,
      thresholdPercent: 50,
      consecutiveSamples: 2
    })

    try {
      monitor.start()
      await vi.waitFor(
        (): void => {
          expect(reports.length).toBeGreaterThan(0)
        },
        { timeout: 5_000, interval: 50 }
      )
      expect(reports[0].cpuPercent).toBeGreaterThan(50)
      expect(reports[0].pid).toBe(pid)
      expect(reports[0].windowMs).toBeGreaterThan(0)
    } finally {
      monitor.stop()
    }
  })

  it('measures a real process’s resident size with the REAL ps probe', async () => {
    // A real child holding a real amount of memory, read by the REAL `ps -o rss=` probe through the
    // monitor. This is the half a stubbed probe cannot prove: that the platform's resident-set reading is
    // bytes (not kilobytes, not pages) and that it actually finds a kernel's footprint. 150 MB allocated
    // and touched, so the pages are resident rather than promised.
    const holder = spawn(
      process.execPath,
      ['-e', 'globalThis.held = Buffer.alloc(150 * 1024 * 1024, 1); setTimeout(() => {}, 20000)'],
      { stdio: 'ignore' }
    )
    const pid = holder.pid
    expect(pid).toBeGreaterThan(0)
    const ring = createKernelMemoryRing()
    const monitor = new KernelIdleSpinMonitor({
      listIdleKernels: (): IdleKernelTarget[] => [
        { key: 'python:default', kind: 'python', env: 'default', pid: pid as number }
      ],
      onSpin: (): void => {},
      platform: 'darwin',
      memoryRing: ring,
      schedule: (): { cancel: () => void } => ({ cancel: (): void => {} })
    })

    try {
      monitor.start()
      // The child needs a moment to boot node and touch its pages: sample until its footprint shows up,
      // rather than reading the 1 MB baseline of a process that has not allocated yet.
      await vi.waitFor(
        async (): Promise<void> => {
          await monitor.sampleOnce()
          const resident = ring.summary().latest[0]?.residentBytes ?? 0
          expect(resident).toBeGreaterThan(60 * 1024 * 1024)
        },
        { timeout: 15_000, interval: 100 }
      )
      const summary = ring.summary()
      expect(summary.status, JSON.stringify(summary.unmeasuredReasons)).toBe('samples')
      const residentBytes = summary.latest[0]?.residentBytes ?? 0
      // A reading in kilobytes or in pages would land far outside this range.
      expect(residentBytes).toBeLessThan(2 * 1024 * 1024 * 1024)
      expect(summary.last).toMatchObject({ kernels: 1, measured: 1, unmeasured: 0 })
    } finally {
      monitor.stop()
      holder.kill('SIGKILL')
    }
  })
})

// -- the executor actually wires it ----------------------------------------------------------

const baseRequest = (
  cwd: string
): { cwd: string; notebookSessionRoot: string; dataRoot: string; runtimeRoot: string } => ({
  cwd,
  notebookSessionRoot: join(cwd, 'nb'),
  dataRoot: join(cwd, 'nb', 'data'),
  runtimeRoot: join(cwd, 'runtime')
})

describe('NotebookKernelExecutor idle-cpu observation', () => {
  let cwdDir: string | undefined

  afterEach(async () => {
    if (cwdDir) {
      await rm(cwdDir, { recursive: true, force: true })
      cwdDir = undefined
    }
  })

  it('logs one named warning for an idle kernel whose cpu time keeps climbing', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'ps-kernel-idle-spin-'))
    const warn = vi.fn()
    const info = vi.fn()
    let cpuMs = 0
    const memoryRing = createKernelMemoryRing()
    const executor = new NotebookKernelExecutor({
      replLoopPath: REPL_LOOP,
      platform: 'linux',
      logger: { warn, info },
      idleSpinIntervalMs: 20,
      idleSpinThresholdPercent: 50,
      // 1 s of cpu charged against a 20 ms window: unmistakably a spin, whatever the real timing is.
      idleSpinProbe: async (): Promise<KernelCpuReading> => {
        cpuMs += 1_000
        return { status: 'observed', cpuMs }
      },
      // The memory half is injected too: a unit test's readings must not land in the process-wide ledger,
      // and the stub keeps the executor's own wiring (probe → ring) under test without spawning ps.
      idleSpinMemoryProbe: async (): Promise<KernelMemoryReading> => ({
        status: 'observed',
        residentBytes: 96_000_000
      }),
      idleSpinMemoryRing: memoryRing
    })
    try {
      const result = await executor.execute({
        ...baseRequest(cwdDir),
        code: 'return 1 + 1',
        kind: 'repl'
      })
      expect(result.status, result.traceback).toBe('completed')

      await vi.waitFor(
        (): void => {
          expect(warn).toHaveBeenCalled()
        },
        { timeout: 3_000, interval: 20 }
      )
      const [message, fields] = warn.mock.calls[0] as [string, Record<string, unknown>]
      expect(message).toBe('notebook kernel idle spin detected')
      expect(fields).toMatchObject({
        key: 'repl',
        kind: 'repl',
        env: '',
        action: 'observed-only'
      })
      expect(fields.pid).toBeGreaterThan(0)
      expect(fields.cpuPercent).toBeGreaterThan(50)
      // The memory round rode the same tick and the same "idle" decision: the executor's own list is what
      // both readings are keyed on, so a kernel it measured for cpu is a kernel it measured for memory.
      const memory = memoryRing.summary()
      expect(memory.status).toBe('samples')
      expect(memory.latest[0]).toMatchObject({
        key: 'repl',
        pid: fields.pid,
        residentBytes: 96_000_000
      })
      // The observation never punishes the kernel: the same executor still answers after the report.
      const after = await executor.execute({
        ...baseRequest(cwdDir),
        code: 'return 2 + 2',
        kind: 'repl'
      })
      expect(after.status, after.traceback).toBe('completed')
    } finally {
      await executor.shutdown()
    }
  })

  it('does not probe or report while the kernel has a request in flight', async () => {
    cwdDir = await mkdtemp(join(tmpdir(), 'ps-kernel-idle-busy-'))
    const warn = vi.fn()
    let probes = 0
    const memoryRing = createKernelMemoryRing()
    const executor = new NotebookKernelExecutor({
      replLoopPath: REPL_LOOP,
      platform: 'linux',
      logger: { warn, info: vi.fn() },
      idleSpinIntervalMs: 20,
      idleSpinThresholdPercent: 50,
      idleSpinProbe: async (): Promise<KernelCpuReading> => {
        probes += 1
        return { status: 'observed', cpuMs: probes * 1_000 }
      },
      idleSpinMemoryProbe: async (): Promise<KernelMemoryReading> => ({
        status: 'observed',
        residentBytes: 96_000_000
      }),
      idleSpinMemoryRing: memoryRing
    })
    try {
      const running = executor.execute({
        ...baseRequest(cwdDir),
        code: 'await new Promise((resolve) => setTimeout(resolve, 400)); return 1',
        kind: 'repl'
      })
      await new Promise((resolve): void => {
        setTimeout(resolve, 250)
      })
      // What "idle" means is the executor's own `pending` record: with a request in flight the kernel is
      // not offered to the monitor at all, so a long cell is never reported as a spin.
      expect(probes).toBe(0)
      expect(warn).not.toHaveBeenCalled()
      const result = await running
      expect(result.status, result.traceback).toBe('completed')
    } finally {
      await executor.shutdown()
    }
  })
})

// -- the whole chain against a real kernel -----------------------------------------------------
//
// The stubs above prove the wiring; this one proves the chain end to end on a real machine: a real REPL
// kernel process, the REAL `ps -o rss=` probe, the ring the support bundle reads. Skipped on Windows,
// where the probe is a named `unsupported-platform` rather than a reading.

describe.skipIf(process.platform === 'win32')(
  'NotebookKernelExecutor memory observation (real ps probe)',
  () => {
    let cwdDir: string | undefined

    afterEach(async () => {
      if (cwdDir) {
        await rm(cwdDir, { recursive: true, force: true })
        cwdDir = undefined
      }
    })

    it('records the real resident size of a live kernel through the real probe', async () => {
      cwdDir = await mkdtemp(join(tmpdir(), 'ps-kernel-memory-real-'))
      const ring = createKernelMemoryRing()
      const executor = new NotebookKernelExecutor({
        replLoopPath: REPL_LOOP,
        platform: process.platform,
        logger: { warn: vi.fn(), info: vi.fn() },
        idleSpinIntervalMs: 100,
        // A high threshold keeps this test about memory only: no cpu spin is expected from a quiet kernel.
        idleSpinThresholdPercent: 99,
        idleSpinMemoryRing: ring
        // No `idleSpinMemoryProbe`: the real `ps -o rss=` probe is the thing under test.
      })
      try {
        const result = await executor.execute({
          ...baseRequest(cwdDir),
          code: 'return 1 + 1',
          kind: 'repl'
        })
        expect(result.status, result.traceback).toBe('completed')

        await vi.waitFor(
          (): void => {
            const summary = ring.summary()
            expect(summary.status).toBe('samples')
            expect(summary.latest[0]?.residentBytes ?? 0).toBeGreaterThan(0)
          },
          { timeout: 10_000, interval: 100 }
        )
        const summary = ring.summary()
        // The repl kernel is a node process: a few tens of MB, certainly not kilobytes-of-bytes confusion.
        expect(summary.latest[0].key).toBe('repl')
        expect(summary.latest[0].residentBytes).toBeGreaterThan(5 * 1024 * 1024)
        expect(summary.last).toMatchObject({ kernels: 1, measured: 1, unmeasured: 0 })
      } finally {
        await executor.shutdown()
      }
    })
  }
)
