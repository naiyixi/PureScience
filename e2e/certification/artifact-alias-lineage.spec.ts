import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

test.setTimeout(180_000)

// B2-3 (v2.3.0): the Version's alias-level lineage on the Version's own provenance surface, driven on a real
// window. The Artifact is a real one — written through the app's own artifact tool by a real notebook run —
// so the section has a producing run to scope itself to rather than a fixture object.
//
// What this reading covers, and what it does not: the panel renders the projection the main process built
// (the recipe is on screen, so the answer is not the unavailable branch), with an honest statement when no
// later run changed what the producing run wrote. A window reading with an actual ROW needs a notebook run
// that writes an aliased value and a later run that changes it in place — i.e. a python/R kernel, which this
// harness does not provision (`runtime/envs/default-python/bin/python` is absent), so the row branch is
// covered where it can be: the projection's own cases and the panel's render cases.
test('the provenance panel shows the producing run alias lineage and its recipe', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Artifact alias lineage')
  await sendPrompt(
    page,
    'Create a provenance artifact.',
    'Artifact provenance verified for session',
    90_000
  )

  await page
    .getByRole('button', { name: /^Preview generated file provenance-evidence\.txt$/ })
    .first()
    .click()
  await expect(page.getByTestId('preview-card')).toBeVisible()
  await page
    .getByRole('button', { name: /^File actions for / })
    .first()
    .click()
  await page.getByRole('menuitem', { name: 'Provenance' }).click()
  await expect(page.getByTestId('artifact-provenance')).toBeVisible()

  await page.getByRole('tab', { name: 'Alias lineage' }).click()

  const section = page.getByTestId('artifact-alias-lineage')
  await expect(section).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('artifact-alias-lineage-recipe')).toContainText(
    'notebook-alias-lineage:v1'
  )
  await expect(page.getByTestId('artifact-alias-lineage-unavailable')).toHaveCount(0)

  const empty = page.getByTestId('artifact-alias-lineage-empty')
  const rows = page.getByTestId('artifact-alias-lineage-row')
  await expect(empty.or(rows.first())).toBeVisible()
  console.log(
    `[alias-lineage] empty=${String(await empty.count())} rows=${String(await rows.count())} ` +
      `section=${JSON.stringify((await section.innerText()).slice(0, 300))}`
  )
})
