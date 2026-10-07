import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// IC50 + the skill-fork work order: an imported skill stays the imported copy, the detail says so in words,
// and the same detail offers the way out — duplicating it into a skill of your own. The implementation
// shipped with a render suite and a catalog probe, but no true-machine reading: the earlier attempt searched
// with `getByRole('searchbox').first()`, which reaches the settings panel's OWN search rather than the
// skills grid's, and then never opened the row. This walks the real path: seed an imported skill, restart the
// app, open Settings → Skills, search it in the grid, open its row, read the sentence, and duplicate it —
// checking the copy against the skill root on disk rather than against what the view says about itself.
test.setTimeout(180_000)

test('an imported skill says it is kept as imported and offers to copy itself', async ({ app }) => {
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
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Skills' })
    .click()

  // The skills grid's OWN search. `getByRole('searchbox').first()` is the settings panel's search — that
  // mismatch is exactly why the first attempt could not find the row.
  const gridSearch = settings.locator('input[type="search"][aria-label="Search skills"]')
  await expect(gridSearch).toBeVisible()
  await gridSearch.fill('Seeded import')

  const row = settings
    .locator('[data-slot="settings-list-row"]')
    .filter({ hasText: 'Seeded import' })
    .first()
  await expect(row).toBeVisible()
  // The row's name is the button that opens the detail view. Anchor on the START of the accessible name so
  // the row's favorite button ("Favorite Seeded import" — it contains the skill name too) cannot be the one
  // clicked; the first attempt picked exactly that one and stayed on the list.
  await row
    .getByRole('button', { name: /^Seeded import/ })
    .first()
    .click()

  const kept = settings.locator('[data-slot="skill-imported-kept"]')
  await expect(kept).toBeVisible()
  console.log(`[ic50] the detail says: "${(await kept.innerText()).trim()}"`)
  await expect(kept).toContainText(
    'Kept as imported: this copy is compared against what you imported. Duplicate it to get a skill of your own that you can edit.'
  )

  // The sentence above promises a way out, so the entry it promises has to be there and reachable — a
  // disabled or absent control would make the sentence a lie in the other direction.
  const fork = settings.locator('[data-slot="skill-fork"]')
  await expect(fork).toBeVisible()
  await expect(fork).toBeEnabled()
  console.log(`[ic50] the copy entry reads: "${(await fork.innerText()).trim()}"`)
  await fork.click()

  // The copy is judged on the skill root, not on what the view says afterwards: the fork has to have put a
  // personal skill of that name on disk. (The imported original is left as it was — that half is pinned
  // byte-for-byte by the repository suite.)
  const personalRoot = join(app.storageRoot, 'skills', 'personal')
  await expect
    .poll(async () => {
      try {
        return await readdir(personalRoot)
      } catch {
        return []
      }
    })
    .toContain(slug)
  console.log(`[ic50] the copy landed on disk at ${join(personalRoot, slug)}`)
})
