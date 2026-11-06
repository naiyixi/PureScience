import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  KernelIdleSpinMonitor,
  parseCumulativeCpuTime,
  type IdleKernelTarget,
  type IdleSpinReport,
  type IdleSpinUnsampledReason,
  type KernelCpuProbe,
  type KernelCpuReading
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

// -- the decision logic, driven with a fake probe and a fake clock ----------------------------

type Harness = {
  monitor: KernelIdleSpinMonitor
  reports: IdleSpinReport[]
  unsampled: IdleSpinUnsampledReason[]
  setTargets: (targets: IdleKernelTarget[]) => void
  setReading: (reading: KernelCpuReading) => void
  advance: (ms: number) => void
  probeCalls: () => number
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
  let clock = 1_000
  let calls = 0
  const reports: IdleSpinReport[] = []
  const unsampled: IdleSpinUnsampledReason[] = []
  const probe: KernelCpuProbe = async (): Promise<KernelCpuReading> => {
    calls += 1
    return reading
  }
  const monitor = new KernelIdleSpinMonitor({
    listIdleKernels: (): IdleKernelTarget[] => targets,
    onSpin: (report): void => {
      reports.push(report)
    },
    onUnsampled: (reason): void => {
      unsampled.push(reason)
    },
    probe,
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
    setTargets: (next): void => {
      targets = next
    },
    setReading: (next): void => {
      reading = next
    },
    advance: (ms): void => {
      clock += ms
    },
    probeCalls: (): number => calls
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
      }
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
    const executor = new NotebookKernelExecutor({
      replLoopPath: REPL_LOOP,
      platform: 'linux',
      logger: { warn, info: vi.fn() },
      idleSpinIntervalMs: 20,
      idleSpinThresholdPercent: 50,
      idleSpinProbe: async (): Promise<KernelCpuReading> => {
        probes += 1
        return { status: 'observed', cpuMs: probes * 1_000 }
      }
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
