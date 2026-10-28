// Do the two instruments behind `cause` actually read something on this machine? Both answer `unavailable`
// when they cannot, so a passing unit test with stubbed seams proves the wiring and nothing about the
// instruments. This bench takes the production ones:
//
//   1. `createGcPauseMonitor()` with its real `PerformanceObserver`, and a heap grown until V8 collects — the
//      monitor has to report a pause, with a duration.
//   2. `startCanaryRead()` twice: once on an idle thread pool, once while the pool is saturated. A canary that
//      cannot get slower is not a discriminator, and the whole `fs-queue-saturated` verdict rests on it.
//
// Run: PURESCIENCE_BENCH_STALL=1 NODE_OPTIONS=--max-old-space-size=4096 npx vitest run scripts/bench/stall-cause-instruments.bench.test.ts
import { appendFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { startCanaryRead } from '../../src/main/diagnostics/fs-queue-probe'
import { createGcPauseMonitor } from '../../src/main/diagnostics/gc-pause-monitor'

const enabled = process.env.PURESCIENCE_BENCH_STALL === '1'
const out = process.env.PURESCIENCE_BENCH_OUT ?? '/tmp/stall-cause-instruments.txt'

const say = (line: string): void => {
  appendFileSync(out, `${line}\n`)
  console.log(line)
}

describe.skipIf(!enabled)('stall cause instruments', () => {
  it('reports the pauses V8 actually took', async () => {
    const monitor = createGcPauseMonitor()
    const startedAt = performance.now()
    // Grow and drop the heap until the collector runs: young-generation scavenges land within a few dozen
    // megabytes, which is what most stalls of this size are made of.
    for (let round = 0; round < 40; round += 1) {
      const churn: Array<Buffer | undefined> = []
      for (let index = 0; index < 400; index += 1) churn.push(Buffer.alloc(64 * 1024, 1))
      churn.length = 0
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    // A pause is reported by the observer asynchronously; give the loop a moment to deliver.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const reading = monitor.pauseMsWithin(startedAt, performance.now())
    monitor.stop()
    say(
      `GC status=${reading.status} ${reading.status === 'measured' ? `pauseMs=${reading.pauseMs} pauses=${reading.pauses}` : ''}`
    )
    expect(reading.status).toBe('measured')
  }, 60_000)

  it('gets slower when the thread pool is saturated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ps-stall-bench-'))
    const file = join(directory, 'payload.bin')
    await writeFile(file, Buffer.alloc(512 * 1024, 3))

    // The first read of the process also creates the canary file, so it measures mkdtemp + write + read. Warm
    // it first, or the "idle" number is setup cost and every later reading looks like saturation.
    await startCanaryRead()
    const idle = await startCanaryRead()

    // More reads than libuv has slots (4 by default), each of a file large enough to occupy its slot for
    // real: this is the shape the acquire path produces when a preview fans out.
    const busy = Array.from({ length: 96 }, () => readFile(file))
    const saturated = await startCanaryRead()
    await Promise.all(busy)

    await rm(directory, { recursive: true, force: true })
    const recovered = await startCanaryRead()
    say(`FS idleMs=${idle} saturatedMs=${saturated} recoveredMs=${recovered}`)
    // The claim the verdict rests on: the canary can tell a busy pool from an idle one.
    expect(saturated).toBeGreaterThan(idle)
  }, 120_000)
})
