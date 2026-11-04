import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// A case's name belongs to the case, not to the build.
//
// Until v2.27.0 the home page got titles from `CURATED_CASE_TITLES` — a table keyed by project id inside the
// renderer. That table only holds on the machine whose ids it was copied from, so the same case reads as an
// unnamed thing anywhere else. What has to be true now, and can only be shown in a real window:
//   1. the reader can type a name into the case panel and is told, in words, that it was stored;
//   2. the name shows on the card without a reload;
//   3. it is still there after the app restarts — the claim is that it lives in the project row, and a
//      restart is the cheapest honest test of "in the data, not in this component's state";
//   4. clearing it goes back to a derived name instead of leaving the card blank.
test.setTimeout(240_000)

const home = (
  page: Page
): {
  cards: Locator
  detail: Locator
  editor: Locator
  title: Locator
  summary: Locator
  save: Locator
  saved: Locator
} => ({
  cards: page.locator('[data-slot="case-plaza-card"]'),
  detail: page.locator('[data-slot="case-plaza-detail"]'),
  editor: page.locator('[data-slot="case-name-editor"]'),
  title: page.locator('[data-slot="case-name-title"]'),
  summary: page.locator('[data-slot="case-name-summary"]'),
  save: page.locator('[data-slot="case-name-save"]'),
  saved: page.locator('[data-slot="case-name-saved"]')
})

test('a case name typed in the panel is stored on the project and survives a restart', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()

  const projectName = 'Naming case'
  await createProject(page, projectName)
  page = await app.restart()

  // One real turn, so the project is a case at all.
  await page
    .getByRole('region', { name: 'Projects' })
    .getByRole('button', { name: projectName, exact: true })
    .click()
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeVisible({ timeout: 60_000 })
  await sendPrompt(page, 'Say hello for the naming spec', 'Deterministic reply:')
  page = await app.restart()

  const first = home(page)
  await expect(first.cards).toHaveCount(1)
  const derivedName = ((await first.cards.first().innerText()).split('\n')[0] ?? '').trim()
  console.log(`[naming] derived name before naming: ${JSON.stringify(derivedName)}`)

  await first.cards.first().click()
  await expect(first.editor).toBeVisible()
  // The box starts empty: nothing has been stored for this project yet, so the editor must not pretend the
  // derived name was a stored one.
  await expect(first.title).toHaveValue('')

  const written = 'EGFR 选择性审计：三库交叉'
  const oneLine = '这句话要说清这个案例做了什么'
  await first.title.fill(written)
  await first.summary.fill(oneLine)
  await first.save.click()
  await expect(first.saved).toBeVisible()
  console.log('[naming] panel reports the name was stored on the project')

  // Close the panel (Escape) and read the card: the name is the one just typed, without a reload.
  await page.keyboard.press('Escape')
  await expect(first.detail).toBeHidden()
  await expect(first.cards.first()).toContainText(written)
  await expect(first.cards.first()).toContainText(oneLine)
  console.log(
    `[naming] card after naming: ${(await first.cards.first().innerText()).replace(/\s+/g, ' ')}`
  )

  // The claim under test: the name is a fact in the project row. A restart throws away every piece of
  // renderer state, so a name that survives it cannot have come from a table in this build.
  page = await app.restart()
  const second = home(page)
  await expect(second.cards).toHaveCount(1)
  await expect(second.cards.first()).toContainText(written)
  await expect(second.cards.first()).toContainText(oneLine)
  console.log('[naming] the name survived a restart')

  // And it is editable, not stuck: clearing it returns the card to a derived name.
  await second.cards.first().click()
  await expect(second.title).toHaveValue(written)
  await second.title.fill('')
  await second.summary.fill('')
  await second.save.click()
  await expect(second.saved).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(second.detail).toBeHidden()
  await expect(second.cards.first()).not.toContainText(written)
  console.log(
    `[naming] after clearing: ${(await second.cards.first().innerText()).replace(/\s+/g, ' ')}`
  )
})
