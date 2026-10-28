// How much of a session save is serialization? Compares pretty-printed (what the repository writes today)
// against compact output, plus a deep-clone pass, on a real session document.
// Run: PURESCIENCE_BENCH_SERIALIZE=1 PURESCIENCE_BENCH_REAL_SESSION=<file.json> \
//      npx vitest run scripts/bench/session-serialize.bench.test.ts
import { appendFileSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const enabled = process.env.PURESCIENCE_BENCH_SERIALIZE === '1'
const file = process.env.PURESCIENCE_BENCH_REAL_SESSION

describe.skipIf(!enabled || !file)('session serialization cost', () => {
  it('times pretty vs compact stringify and a clone pass', () => {
    const raw = readFileSync(file as string, 'utf8')
    const doc = JSON.parse(raw) as Record<string, unknown>
    const out = process.env.PURESCIENCE_BENCH_OUT ?? '/tmp/session-serialize.txt'

    const time = (run: () => unknown, times = 3): number[] => {
      const values: number[] = []
      for (let index = 0; index < times; index += 1) {
        const started = process.hrtime.bigint()
        run()
        values.push(Number(process.hrtime.bigint() - started) / 1e6)
      }
      return values
    }

    const pretty = time(() => JSON.stringify(doc, null, 2))
    const compact = time(() => JSON.stringify(doc))
    const clone = time(() => structuredClone(doc))

    const median = (values: number[]): number =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

    appendFileSync(
      out,
      `doc_bytes=${raw.length} pretty_p50=${median(pretty).toFixed(1)}ms compact_p50=${median(compact).toFixed(1)}ms ` +
        `clone_p50=${median(clone).toFixed(1)}ms ` +
        `pretty_bytes=${(JSON.stringify(doc, null, 2) as string).length} compact_bytes=${(JSON.stringify(doc) as string).length}\n`
    )
    expect(compact.length).toBe(3)
  }, 180_000)
})
