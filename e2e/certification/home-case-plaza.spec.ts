import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// The home page's centrepiece claims to show the work *this machine* did — a project appears because it has a
// session, not because it was declared. Three claims need a real window, and an isolated root gives all three:
//   1. a machine that has run nothing says so in words, instead of drawing an empty grid that reads as broken;
//   2. a project that exists but has no session is *not* a case (it is still listed in the project list — the
//      assertion says so, otherwise "left out of the plaza" would be indistinguishable from "lost");
//   3. once a session exists, the card appears with a real reading and pressing it opens that project.
// Sample projects being left out is not exercised here: nothing in the product ever marks a project as a
// sample today (`isExample` is read in the plaza and in the home badge, never written), so this spec does not
// pretend to certify an unreachable state.
test.setTimeout(240_000)

// Locators are bound to the page they were built from, and a restart hands back a **new** page (the fixture
// relaunches the app). Reading a pre-restart locator after the relaunch resolves against the closed page and
// fails with `Received: undefined` — which reads like a missing element. So they are rebuilt per page.
const home = (
  page: Page
): { plaza: Locator; cards: Locator; empty: Locator; projects: Locator } => ({
  plaza: page.locator('[data-slot="case-plaza"]'),
  cards: page.locator('[data-slot="case-plaza-card"]'),
  empty: page.locator('[data-slot="case-plaza-empty"]'),
  projects: page.getByRole('region', { name: 'Projects' })
})

test('the plaza lists the cases this machine ran, and says so when it ran none', async ({
  app
}) => {
  let page = await app.completeOnboarding()

  const first = home(page)
  await expect(first.plaza).toBeVisible()

  // 1. Nothing has run yet on this isolated root.
  await expect(first.empty).toBeVisible()
  await expect(first.empty).toContainText('No project has a session yet')
  await expect(first.cards).toHaveCount(0)
  console.log(`[plaza] empty state: ${(await first.empty.innerText()).replace(/\s+/g, ' ')}`)

  page = await app.configureFakeAgent()
  const projectName = 'Plaza case'

  // 2. A project without a single turn is not a demo: it is listed as a project, and absent from the plaza.
  await createProject(page, projectName)
  page = await app.restart()

  const second = home(page)
  await expect(
    second.projects.getByRole('button', { name: projectName, exact: true })
  ).toBeVisible()
  await expect(second.empty).toBeVisible()
  await expect(second.cards).toHaveCount(0)
  console.log('[plaza] a project with no session is listed, but is not a case')

  // 3. A case is earned by running something: one real turn through the composer.
  await second.projects.getByRole('button', { name: projectName, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeVisible({ timeout: 60_000 })
  await sendPrompt(page, 'Say hello for the plaza', 'Deterministic reply:')

  // The app comes back on the home page, the way the next morning looks.
  page = await app.restart()

  const third = home(page)
  await expect(third.cards).toHaveCount(1)
  const card = third.cards.filter({ hasText: projectName })
  await expect(card).toBeVisible()

  // The card carries a reading, not decoration: when the work last moved (or that it ran here). It
  // deliberately does not print a session count — the home page's own rule is that a partially loaded
  // catalogue must not present a count as authoritative.
  await expect(card).toContainText(/Ran here|last active/)
  console.log(`[plaza] card: ${(await card.innerText()).replace(/\s+/g, ' ')}`)

  await card.click()

  // Pressing the card opens the project itself, not a detail panel about the card: the home page is
  // replaced by the workspace, and the composer of that project is what the reader lands on.
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeVisible({ timeout: 60_000 })
  console.log(
    `[plaza] after click: plaza_count=${await page.locator('[data-slot="case-plaza"]').count()}`
  )
  console.log('[plaza] card opened the project workspace')
})
