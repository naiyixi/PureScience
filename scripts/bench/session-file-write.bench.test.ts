// Floor measurement: on this machine, how long does writing and renaming a session-sized file take?
// If a plain 5 MB write+rename already costs ~200 ms, the save path is not what needs optimising.
// Never touches real session files: it writes only dot-prefixed scratch names and removes them.
// Run: PURESCIENCE_BENCH_FILE_WRITE=1 npx vitest run scripts/bench/session-file-write.bench.test.ts
import { appendFileSync, mkdtempSync } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const enabled = process.env.PURESCIENCE_BENCH_FILE_WRITE === '1'

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

describe.skipIf(!enabled)('session file write floor', () => {
  it('times write + rename for a session-sized payload', async () => {
    const bytes = Number(process.env.PURESCIENCE_BENCH_BYTES ?? '5500000')
    const scratch = mkdtempSync(join(tmpdir(), 'ps-write-'))
    const payload = JSON.stringify({ pad: 'x'.repeat(bytes) })
    const out = process.env.PURESCIENCE_BENCH_OUT ?? '/tmp/session-file-write.txt'

    // Two destinations: the OS temp dir, and the same volume as the real data root. Both use scratch
    // names only — nothing here may remove or overwrite anything that already exists.
    const dirs = [scratch, join(homedir(), '.purescience', '.bench-write')]
    const lines: string[] = []

    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      await mkdir(dir, { recursive: true })
      const writePath = join(dir, 'scratch.tmp')
      const finalPath = join(dir, 'scratch.out')

      const writeTimes: number[] = []
      const renameTimes: number[] = []
      for (let index = 0; index < 5; index += 1) {
        const t0 = process.hrtime.bigint()
        await writeFile(writePath, payload, 'utf8')
        const t1 = process.hrtime.bigint()
        await rename(writePath, finalPath)
        const t2 = process.hrtime.bigint()
        writeTimes.push(Number(t1 - t0) / 1e6)
        renameTimes.push(Number(t2 - t1) / 1e6)
      }
      const size = (await stat(finalPath)).size
      lines.push(
        `dir=${dir} bytes=${size} write_p50=${median(writeTimes).toFixed(1)}ms ` +
          `rename_p50=${median(renameTimes).toFixed(1)}ms ` +
          `write_all=${writeTimes.map((v) => v.toFixed(0)).join(',')}`
      )
    }

    appendFileSync(out, `${lines.join('\n')}\n`)
    for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    expect(lines.length).toBe(dirs.length)
  }, 180_000)
})
