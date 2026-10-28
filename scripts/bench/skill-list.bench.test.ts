// Times the real `settings:list-skills` path (registry + user skills + settings merge) against real dirs.
// Run: PURESCIENCE_BENCH_SKILL_LIST=1 npx vitest run scripts/bench/skill-list.bench.test.ts
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SkillRegistry } from '../../src/main/skills/registry'
import { UserSkillRepository } from '../../src/main/skills/user-skill-repository'
import { SkillCatalogModule } from '../../src/main/settings/skill-catalog'

const enabled = process.env.PURESCIENCE_BENCH_SKILL_LIST === '1'

describe.skipIf(!enabled)('skill listing cost', () => {
  it('reports cold vs warm cost for the full listSkills path', async () => {
    const storageRoot =
      process.env.PURESCIENCE_BENCH_STORAGE_ROOT ?? join(homedir(), '.purescience')
    const bundledRoot =
      process.env.PURESCIENCE_BENCH_BUNDLED_ROOT ?? join(process.cwd(), 'resources', 'skills')

    const settingsPath = join(storageRoot, 'settings.json')
    let settings: Record<string, unknown> = {}
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    } catch {
      console.log('[skill-list] no settings.json, using defaults')
    }

    const catalog = new SkillCatalogModule({
      // Only getSettings is exercised by listSkills.
      repository: { getSettings: async () => settings } as never,
      storageRoot,
      skillRegistry: new SkillRegistry(bundledRoot),
      userSkills: new UserSkillRepository(storageRoot)
    })

    const durations: number[] = []
    let count = 0
    for (let index = 0; index < 6; index += 1) {
      const started = process.hrtime.bigint()
      const views = await catalog.listSkills()
      durations.push(Number(process.hrtime.bigint() - started) / 1e6)
      count = views.length
    }

    const warm = durations.slice(1).sort((a, b) => a - b)
    console.log(
      `[skill-list] views=${count} cold=${durations[0].toFixed(1)}ms ` +
        `warm_p50=${warm[Math.floor(warm.length / 2)].toFixed(1)}ms ` +
        `warm_max=${warm[warm.length - 1].toFixed(1)}ms ` +
        `all=${durations.map((d) => d.toFixed(1)).join(',')}`
    )
    expect(count).toBeGreaterThan(0)
  }, 180_000)
})
