import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// Real-window acceptance: a refused custom-connector name reaches the reader in their own language.
//
// The refusal is composed in the main process ("Connector name \"arxiv\" is reserved by a built-in
// connector") and arrives in the window wrapped in Electron's invoke envelope. Before this unit the
// add-connector form printed that English sentence verbatim, envelope and all, while the rest of the
// panel spoke the interface language. The sentence now maps back to a dictionary key through the shared
// main-message catalog, with the name the reader typed filled in from what main quoted.
//
// The negative half is the decisive one: only asserting that "some text appeared" would also pass if the
// panel still printed English, so the canonical sentence is asserted absent from the window.
// A bundled connector id whose derived ID differs from it ('clinical-genomics' vs 'clinical_genomics'):
// the form's own pre-check compares the derived ID against bundled IDs and therefore lets this name
// through, so main is the one that refuses it — which is exactly the sentence this reading is about.
const NAME = 'clinical_genomics'
const REFUSAL_ZH_HANT = `連接器名稱「${NAME}」與內建連接器保留的名稱衝突`
const REFUSAL_EN = `Connector name "${NAME}" is reserved by a built-in connector`

test.setTimeout(180_000)

test('a refused connector name is printed in the interface language, not in English', async ({
  app
}) => {
  const page = await app.completeOnboarding()

  // The interface language is a preference read when the provider mounts: set it, then reload — the same
  // two steps a reader takes in Settings → General → Language.
  await page.evaluate(() => window.localStorage.setItem('purescience-language', 'zh-Hant'))
  await page.reload()
  await page.waitForLoadState('domcontentloaded')

  const settingsButton = page.getByRole('button', { name: '設定' }).first()
  await expect(settingsButton).toBeVisible({ timeout: 60_000 })
  await settingsButton.click()

  const settings = page.getByRole('dialog', { name: '設定' })
  await settings
    .getByRole('navigation', { name: '設定' })
    .getByRole('button', { name: /連接器/ })
    .click()

  await settings
    .getByRole('button', { name: /新增連接器/ })
    .first()
    .click()
  // The dropdown renders in a portal at the top level, so it is located from the page.
  await page.getByRole('menuitem', { name: /本機指令/ }).click()

  // A name that collides with a bundled connector id: main refuses it, the form shows the refusal.
  await settings.getByLabel('顯示名稱').first().fill(NAME)
  await settings.getByLabel('我信任此連接器').check()
  await settings.getByRole('button', { name: '新增連接器' }).last().click()

  const alert = settings.locator('[role="alert"]')
  await expect(alert).toBeVisible({ timeout: 30_000 })
  await expect(alert).toHaveText(REFUSAL_ZH_HANT)

  // The sentence main composed, and the transport envelope it travelled in, must both be off screen.
  await expect(settings.getByText(REFUSAL_EN, { exact: true })).toHaveCount(0)
  await expect(settings.getByText(/Error invoking remote method/)).toHaveCount(0)

  const shown = (await alert.textContent())?.trim()
  console.log(
    `[connector-refusal-language] alert="${shown}" canonicalEnglishOnScreen=false envelopeOnScreen=false`
  )
})
