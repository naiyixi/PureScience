/**
 * Time the specialist skill catalog read, which `compose runtime steps` reported once at 1,160 ms.
 *
 * The suspicion before measuring: `bundledSkillCompatibility` keeps a ONE-SLOT cache while its key is a
 * per-skill directory, so a call for skill N always evicts skill N-1 — the cache can never hit inside a
 * single `list()`. If that is what costs time, the reading scales with the number of skill directories and
 * disappears when the cache is keyed per directory.
 *
 *   PURESCIENCE_BENCH_SKILL_CATALOG=1 npx vitest run scripts/bench/skill-catalog.bench.test.ts
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SkillRegistry } from '../../src/main/skills/registry'

// The registry resolves its root through electron's `app.getAppPath()`, which does not exist outside the
// app. Point it at the checked-in skills tree instead, so the bench measures the real catalog.
const SKILLS_ROOT = join(process.cwd(), 'resources', 'skills')

const ENABLED = process.env.PURESCIENCE_BENCH_SKILL_CATALOG === '1'
const OUT_FILE = join(process.cwd(), 'docs/bench-runs/2026-10-25-skill-catalog.txt')
const RUNS = 5

describe.runIf(ENABLED)('skill catalog read', () => {
  it('measures one catalog pass, and whether a second pass is cheaper', async () => {
    const registry = new SkillRegistry(SKILLS_ROOT)

    const first: number[] = []
    const second: number[] = []
    const counts: number[] = []

    for (let i = 0; i < RUNS; i += 1) {
      const startedFirst = performance.now()
      const skills = await registry.list()
      first.push(performance.now() - startedFirst)
      counts.push(skills.length)

      const startedSecond = performance.now()
      await registry.list()
      second.push(performance.now() - startedSecond)
    }

    const q = (values: number[], p: number): number => {
      const sorted = [...values].sort((a, b) => a - b)
      return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))]
    }

    const report = [
      '[skill-catalog]',
      `runs=${RUNS} skills=${counts.join(',')}`,
      `first pass:  p50=${q(first, 50).toFixed(1)}ms p90=${q(first, 90).toFixed(1)}ms`,
      `second pass: p50=${q(second, 50).toFixed(1)}ms p90=${q(second, 90).toFixed(1)}ms`,
      `first:  ${first.map((v) => v.toFixed(1)).join(', ')}`,
      `second: ${second.map((v) => v.toFixed(1)).join(', ')}`,
      ''
    ].join('\n')

    await writeFile(OUT_FILE, report, 'utf8')
    console.log(report)
    expect(counts.every((count) => count === counts[0])).toBe(true)
  }, 120_000)
})
