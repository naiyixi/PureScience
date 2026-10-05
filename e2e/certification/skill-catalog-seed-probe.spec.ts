import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// IC50 probe: the skill was seeded at `<storageRoot>/skills/imported/<slug>/SKILL.md`, the panel showed its
// list (1073 characters of it) and the seeded name was NOT in it. This asks the layer in front of the panel —
// the app's own catalog — so "the panel filtered it" and "the catalog never had it" cannot be confused.
test.setTimeout(180_000)

test('the app catalog reports the seeded imported skill, or says why it does not', async ({
  app
}) => {
  await app.completeOnboarding()
  const slug = 'seeded-import'
  const skillDir = join(app.storageRoot, 'skills', 'imported', slug)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: Seeded import',
      'description: Seeded for the catalog probe.',
      '---',
      '',
      '# Seeded import',
      '',
      'Seeded body.'
    ].join('\n'),
    'utf8'
  )
  console.log(`[ic50b] seeded an imported skill at ${skillDir}`)

  const page = await app.restart()
  const listed = (await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { settings: { listSkills: () => Promise<unknown> } }
    }
    return bridge.api.settings.listSkills()
  })) as Array<{ id?: string; name?: string; source?: string }>

  console.log(
    `[ic50b] the app catalog lists ${listed.length} skill(s): ${JSON.stringify(
      listed.map((skill) => ({ id: skill.id, source: skill.source })).slice(0, 14)
    )}`
  )
  expect(listed.some((skill) => (skill.id ?? '').includes(slug))).toBe(true)
})
