import { spawn, type ChildProcess } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  KernelIdleSpinMonitor,
  createKernelCpuRing,
  type IdleKernelTarget,
  type KernelCpuReading
} from './kernel-idle-spin'

// The ring is the half of the idle-spin observation that travels (into a support bundle); the monitor's log
// line is the half that does not. These tests drive the monitor with a fake probe and clock — the same seam
// the existing monitor tests use — and then read the ring, so the wiring itself is what is asserted rather
// than "a ring exists somewhere".

const TARGET: IdleKernelTarget = {
  key: 'python:default',
  kind: 'python',
  env: 'default',
  pid: 4242
}

type Harness = {
  ring: ReturnType<typeof createKernelCpuRing>
  monitor: KernelIdleSpinMonitor
  setReading: (reading: KernelCpuReading) => void
  setTargets: (targets: IdleKernelTarget[]) => void
  advance: (ms: number) => void
  clock: () => number
}

const makeHarness = (
  options: { platform?: NodeJS.Platform; ringCapacity?: number } = {}
): Harness => {
  let clock = 1_000
  let reading: KernelCpuReading = { status: 'observed', cpuMs: 0 }
  let targets: IdleKernelTarget[] = [TARGET]
  const ring = createKernelCpuRing({
    now: () => new Date(clock),
    ...(options.ringCapacity === undefined ? {} : { capacity: options.ringCapacity })
  })
  const monitor = new KernelIdleSpinMonitor({
    listIdleKernels: () => targets,
    onSpin: () => undefined,
    probe: async (): Promise<KernelCpuReading> => reading,
    now: () => clock,
    // The interval never fires on its own: every test drives `sampleOnce` so the windows are exact.
    schedule: () => ({ cancel: () => undefined }),
    intervalMs: 15_000,
    thresholdPercent: 50,
    ring,
    ...(options.platform === undefined ? {} : { platform: options.platform })
  })
  return {
    ring,
    monitor,
    setReading: (next) => {
      reading = next
    },
    setTargets: (next) => {
      targets = next
    },
    advance: (ms) => {
      clock += ms
    },
    clock: () => clock
  }
}

// One cpu window needs two samples: the first sighting only takes a baseline.
const sampleWindow = async (harness: Harness, cpuMsInWindow: number): Promise<void> => {
  await harness.monitor.sampleOnce()
  harness.advance(15_000)
  const before = harness.ring.summary().observed
  harness.setReading({ status: 'observed', cpuMs: cpuMsInWindow })
  await harness.monitor.sampleOnce()
  expect(harness.ring.summary().observed).toBeGreaterThan(before)
}

describe('kernel cpu ring', () => {
  it('keeps every completed window, including the quiet ones, so a spin has something to be compared against', async () => {
    const harness = makeHarness()
    await harness.monitor.sampleOnce()
    harness.advance(15_000)
    // 3% of one core: a quiet window that must still be recorded.
    harness.setReading({ status: 'observed', cpuMs: 450 })
    await harness.monitor.sampleOnce()
    harness.advance(15_000)
    // 97% of one core.
    harness.setReading({ status: 'observed', cpuMs: 450 + 14_550 })
    await harness.monitor.sampleOnce()

    const summary = harness.ring.summary()
    expect(summary.status).toBe('samples')
    expect(summary.observed).toBe(2)
    expect(summary.records.map((record) => record.cpuPercent)).toEqual([3, 97])
    expect(summary.records.map((record) => record.spinning)).toEqual([false, true])
    expect(summary.records[0].windowMs).toBe(15_000)
    expect(summary.records[0].thresholdPercent).toBe(50)
    expect(summary.latest).toHaveLength(1)
  })

  it('says how many windows it no longer keeps instead of presenting a short tail as the whole history', async () => {
    const harness = makeHarness({ ringCapacity: 2 })
    await harness.monitor.sampleOnce()
    // Cumulative cpu time: 1.5 s, 4.5 s, 10.5 s over the same 15 s window ⇒ 10%, 20%, 40%.
    for (const cpuMs of [1_500, 4_500, 10_500]) {
      harness.advance(15_000)
      harness.setReading({ status: 'observed', cpuMs })
      await harness.monitor.sampleOnce()
    }

    const summary = harness.ring.summary()
    expect(summary.capacity).toBe(2)
    expect(summary.observed).toBe(3)
    expect(summary.dropped).toBe(1)
    expect(summary.records).toHaveLength(2)
    expect(summary.records.map((record) => record.cpuPercent)).toEqual([20, 40])
  })

  it('keeps the newest window per kernel after the tail has rotated past it', async () => {
    const harness = makeHarness({ ringCapacity: 1 })
    const second: IdleKernelTarget = { key: 'r:default', kind: 'r', env: 'default', pid: 5353 }
    harness.setTargets([TARGET, second])
    await harness.monitor.sampleOnce()
    harness.advance(15_000)
    harness.setReading({ status: 'observed', cpuMs: 1_500 })
    await harness.monitor.sampleOnce()

    // The tail keeps one window while two kernels were measured; `latest` still names both.
    const summary = harness.ring.summary()
    expect(summary.observed).toBe(2)
    expect(summary.records).toHaveLength(1)
    expect(summary.latest.map((record) => record.key).sort()).toEqual([
      'python:default',
      'r:default'
    ])
  })

  it('names a probe that could not read the pid instead of recording 0%', async () => {
    const harness = makeHarness()
    harness.setReading({ status: 'unsampled', reason: 'probe-failed' })
    await harness.monitor.sampleOnce()

    const summary = harness.ring.summary()
    expect(summary.status).toBe('probe-failed')
    expect(summary.records).toEqual([])
    expect(summary.unsampledReasons).toEqual(['probe-failed'])
    // Nothing was measured, so nothing may claim a percentage.
    expect(summary.latest).toEqual([])
  })

  it('says "nothing was ever looked at" before any monitor started, and names the stopped state after', () => {
    const harness = makeHarness()
    expect(harness.ring.summary().status).toBe('monitor-not-started')
    expect(harness.ring.summary().monitor).toBe('never-started')

    harness.monitor.start()
    expect(harness.ring.summary().monitor).toBe('running')
    // Started and no window completed yet is a different answer from "never looked at".
    expect(harness.ring.summary().status).toBe('no-samples')

    harness.monitor.stop()
    expect(harness.ring.summary().monitor).toBe('stopped')
    expect(harness.ring.summary().status).toBe('no-samples')
  })

  it('records the platform with no probe as a named reason, once, and samples nothing', async () => {
    const harness = makeHarness({ platform: 'win32' })
    harness.monitor.start()

    const summary = harness.ring.summary()
    expect(summary.status).toBe('unsupported-platform')
    expect(summary.unsampledReasons).toEqual(['unsupported-platform'])
    expect(summary.records).toEqual([])
  })

  it('drops a window whose percentage is not a number rather than writing a zero', () => {
    const ring = createKernelCpuRing({ now: () => new Date(0) })
    ring.record({
      key: 'python:default',
      kind: 'python',
      env: 'default',
      pid: 4242,
      cpuPercent: Number.NaN,
      windowMs: 15_000,
      thresholdPercent: 50
    })

    const summary = ring.summary()
    expect(summary.observed).toBe(0)
    expect(summary.records).toEqual([])
    expect(summary.status).toBe('monitor-not-started')
  })

  it('hands out copies: a reader of the summary cannot rewrite the history', async () => {
    const harness = makeHarness()
    await sampleWindow(harness, 1_500)
    const summary = harness.ring.summary()
    ;(summary.records[0] as { cpuPercent: number }).cpuPercent = 99
    expect(harness.ring.summary().records[0].cpuPercent).toBe(10)
  })
})

// -- the same ring, driven by the REAL probe against a REAL busy process -----------------------
//
// The stubbed probe above proves the arithmetic; it cannot prove that the platform's cumulative-cpu reading
// lands in the ring as a percentage of one core. This is the half a unit test is allowed to claim only with a
// real child and the real `ps`.

let spinning: ChildProcess | undefined

afterEach(() => {
  spinning?.kill('SIGKILL')
  spinning = undefined
})

describe.skipIf(process.platform === 'win32')('kernel cpu ring (real ps probe)', () => {
  it('keeps a real window from a real spinning process', async () => {
    spinning = spawn(
      process.execPath,
      ['-e', 'const end = Date.now() + 6000; while (Date.now() < end) {}'],
      { stdio: 'ignore' }
    )
    const pid = spinning.pid
    expect(pid).toBeGreaterThan(0)

    const ring = createKernelCpuRing()
    const monitor = new KernelIdleSpinMonitor({
      listIdleKernels: (): IdleKernelTarget[] => [
        { key: 'python:default', kind: 'python', env: 'default', pid: pid as number }
      ],
      onSpin: () => undefined,
      platform: 'darwin',
      intervalMs: 250,
      thresholdPercent: 50,
      consecutiveSamples: 2,
      ring
    })

    try {
      monitor.start()
      await vi.waitFor(
        (): void => {
          expect(ring.summary().records.some((record) => record.spinning)).toBe(true)
        },
        { timeout: 5_000, interval: 50 }
      )
      const summary = ring.summary()
      const window = summary.records.find((record) => record.spinning)
      expect(window?.pid).toBe(pid)
      expect(window?.cpuPercent).toBeGreaterThan(50)
      expect(window?.windowMs).toBeGreaterThan(0)
      expect(summary.status).toBe('samples')
      // The newest window per kernel is the reading a bundle reader goes to first.
      expect(summary.latest).toHaveLength(1)
      expect(summary.latest[0].pid).toBe(pid)
    } finally {
      monitor.stop()
    }
  })
})
