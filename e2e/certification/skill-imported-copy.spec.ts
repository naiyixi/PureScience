import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// IC50: an imported skill stays the imported copy, and the detail says so in words — so a reader never has
// to discover the missing fork action by looking for it. The implementation shipped with a render suite
// (52 passed) and a catalog probe, but no true-machine reading: the earlier attempt searched with
// `getByRole('searchbox').first()`, which reaches the settings panel's OWN search rather than the skills
// grid's, and then never opened the row. This walks the real path: seed an imported skill, restart the app,
// open Settings → Skills, search it in the grid, open its row, and read the sentence.
test.setTimeout(180_000)

test('an imported skill says it is kept as imported', async ({ app }) => {
  await app.completeOnboarding()
  const slug = 'seeded-import'
  const skillDir = join(app.storageRoot, 'skills', 'imported', slug)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: Seeded import',
      'description: Seeded to read the imported-copy sentence.',
      '---',
      '',
      '# Seeded import',
      '',
      'Seeded body.'
    ].join('\n'),
    'utf8'
  )
  console.log(`[ic50] seeded an imported skill at ${skillDir}`)

  const page = await app.restart()
  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Skills' }).click()

  // The skills grid's OWN search. `getByRole('searchbox').first()` is the settings panel's search — that
  // mismatch is exactly why the first attempt could not find the row.
  const gridSearch = settings.locator('input[type="search"][aria-label="Search skills"]')
  await expect(gridSearch).toBeVisible()
  await gridSearch.fill('Seeded import')

  const row = settings.locator('[data-slot="settings-list-row"]').filter({ hasText: 'Seeded import' }).first()
  await expect(row).toBeVisible()
  // The row's name is the button that opens the detail view. Anchor on the START of the accessible name so
  // the row's favorite button ("Favorite Seeded import" — it contains the skill name too) cannot be the one
  // clicked; the first attempt picked exactly that one and stayed on the list.
  await row.getByRole('button', { name: /^Seeded import/ }).first().click()

  const kept = settings.locator('[data-slot="skill-imported-kept"]')
  await expect(kept).toBeVisible()
  console.log(`[ic50] the detail says: "${(await kept.innerText()).trim()}"`)
  await expect(kept).toContainText(
    'Kept as imported: this copy is compared against what you imported, and there is no way to fork it into a skill of your own yet.'
  )
})
