/**
 * What `open-project-db` costs on a launch that changes nothing.
 *
 * `ensureProjectSchema` runs a long serial DDL sequence through the Prisma query engine: ~40
 * `CREATE TABLE IF NOT EXISTS`, ~40 guarded `ALTER TABLE ADD COLUMN` (each of which reads
 * `sqlite_master` and `PRAGMA table_info` first), ~60 `CREATE INDEX IF NOT EXISTS`, plus the six
 * CHECK-constraint migrations. On an existing database every one of those statements is a no-op, so
 * the whole sequence is a per-launch cost paid for an answer the file already knows.
 *
 * This bench measures that number against a **copy of a real database** (never the live one), in the
 * shape a launch actually has: a brand-new Prisma client (which spawns the query engine) followed by
 * one `ensureProjectSchema`.
 *
 *   PURESCIENCE_BENCH_PROJECT_DB=1 npx vitest run scripts/bench/project-db-open.bench.test.ts
 *
 * The app also logs this step (`compose step slow` / `compose runtime steps`, msg `open-project-db`),
 * so the packaged reading can be compared against these numbers.
 */
import { copyFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../../src/main/projects/prisma-client'

const ENABLED = process.env.PURESCIENCE_BENCH_PROJECT_DB === '1'
const LIVE_DB = join(process.env.HOME ?? '', '.purescience', 'purescience.db')
const RUNS = 5
const OUT_FILE = join(process.cwd(), 'docs/bench-runs/2026-10-25-project-db-open.txt')

const timeOnce = async (storageRoot: string): Promise<{ totalMs: number; engineMs: number }> => {
  const startedAt = performance.now()
  const client = createProjectDbClient(storageRoot)
  const createdMs = performance.now()
  try {
    // The first query is what actually boots the engine subprocess, so it belongs to the reading.
    await client.$queryRawUnsafe('SELECT 1')
  } finally {
    await client.$disconnect()
  }
  return { totalMs: performance.now() - startedAt, engineMs: createdMs - startedAt }
}

const timeEnsure = async (storageRoot: string): Promise<number> => {
  const client = createProjectDbClient(storageRoot)
  const startedAt = performance.now()
  try {
    await ensureProjectSchema(client)
  } finally {
    await client.$disconnect()
  }
  return performance.now() - startedAt
}

describe.runIf(ENABLED)('project db open on an unchanged database', () => {
  it('measures the schema sequence that a launch pays for a no-op', async () => {
    const live = await stat(LIVE_DB).catch(() => undefined)
    if (!live) {
      // No live database on this machine: say so instead of reporting a made-up zero.
      throw new Error(
        `No live project database at ${LIVE_DB}; run the app once before benching, or point HOME elsewhere.`
      )
    }

    const dir = await mkdtemp(join(tmpdir(), 'ps-bench-pdb-'))
    const copy = join(dir, 'purescience.db')
    // WAL companions belong with the copy or SQLite recovers from a journal it cannot see.
    await copyFile(LIVE_DB, copy)
    for (const suffix of ['-wal', '-shm']) {
      await copyFile(`${LIVE_DB}${suffix}`, `${copy}${suffix}`).catch(() => undefined)
    }

    const rows: string[] = []
    try {
      const engine: number[] = []
      const ensure: number[] = []

      // Warm the file first (one pass) so the readings below are the steady-state launch cost, not the
      // one-time page-cache fill of a fresh copy.
      await timeEnsure(dir)

      for (let i = 0; i < RUNS; i += 1) {
        const one = await timeOnce(dir)
        engine.push(one.totalMs)
        ensure.push(await timeEnsure(dir))
      }

      const q = (values: number[], p: number): number => {
        const sorted = [...values].sort((a, b) => a - b)
        return sorted[
          Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
        ]
      }

      const total = engine.map((value, index) => value + (ensure[index] ?? 0))
      rows.push(
        `runs=${RUNS}`,
        `client+SELECT 1: p50=${q(engine, 50).toFixed(1)}ms p90=${q(engine, 90).toFixed(1)}ms`,
        `ensureProjectSchema: p50=${q(ensure, 50).toFixed(1)}ms p90=${q(ensure, 90).toFixed(1)}ms`,
        `open step total: p50=${q(total, 50).toFixed(1)}ms p90=${q(total, 90).toFixed(1)}ms`,
        `db bytes=${live.size}`,
        `per-run: ${ensure.map((value) => value.toFixed(1)).join(', ')}`
      )
      // Printed and written, not asserted: a bench reports, it does not pass/fail on a wall-clock
      // threshold. The file survives vitest's console capture, which drops `console.log` in this repo.
      const report = `[project-db-open]\n${rows.join('\n')}\n`
      await writeFile(OUT_FILE, report, 'utf8')
      console.log(report)
      expect(rows.length).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
