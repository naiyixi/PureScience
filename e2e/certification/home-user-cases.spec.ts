import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// The home page's user-case section claims to show the work *this machine* did — a project appears because it
// has a session, not because it was declared. Four claims need a real window, and an isolated root gives all
// four:
//   1. a machine that has run nothing says so in words, instead of drawing an empty grid that reads as broken;
//   2. a project that exists but has no session is *not* a case (it is still listed in the project list — the
//      assertion says so, otherwise "left out of the cases" would be indistinguishable from "lost");
//   3. once a session exists, the card appears with a reading of what it produced, and its name is a name —
//      not the project's folder name copied through;
//   4. pressing the card opens the case's own detail panel (what it hands over), and the panel is what opens
//      the project. The card used to jump straight into the workspace; the case market's card is a shelf
//      item first, so the spec drives the two steps a reader actually takes.
// Sample projects being left out is not exercised here: nothing in the product ever marks a project as a
// sample today (`isExample` is read in the section and in the home badge, never written), so this spec does
// not pretend to certify an unreachable state.
test.setTimeout(240_000)

// Locators are bound to the page they were built from, and a restart hands back a **new** page (the fixture
// relaunches the app). Reading a pre-restart locator after the relaunch resolves against the closed page and
// fails with `Received: undefined` — which reads like a missing element. So they are rebuilt per page.
// The `data-slot` names stay `case-plaza*`: the packaged certification lane and this spec are the reason they
// were not renamed with the component, and renaming them now would be a UI change smuggled in as a refactor.
const home = (
  page: Page
): {
  section: Locator
  cards: Locator
  empty: Locator
  detail: Locator
  openCase: Locator
  projects: Locator
} => ({
  section: page.locator('[data-slot="case-plaza"]'),
  cards: page.locator('[data-slot="case-plaza-card"]'),
  empty: page.locator('[data-slot="case-plaza-empty"]'),
  detail: page.locator('[data-slot="case-plaza-detail"]'),
  openCase: page.locator('[data-slot="case-plaza-detail-open"]'),
  projects: page.getByRole('region', { name: 'Projects' })
})

test('the user cases list what this machine ran, and say so when it ran nothing', async ({
  app
}) => {
  let page = await app.completeOnboarding()

  const first = home(page)
  await expect(first.section).toBeVisible()

  // 1. Nothing has run yet on this isolated root.
  await expect(first.empty).toBeVisible()
  await expect(first.empty).toContainText('No project has a session yet')
  await expect(first.cards).toHaveCount(0)
  console.log(`[cases] empty state: ${(await first.empty.innerText()).replace(/\s+/g, ' ')}`)

  page = await app.configureFakeAgent()
  const projectName = 'Plaza case'

  // 2. A project without a single turn is not a case: it is listed as a project, and absent from the section.
  await createProject(page, projectName)
  page = await app.restart()

  const second = home(page)
  await expect(
    second.projects.getByRole('button', { name: projectName, exact: true })
  ).toBeVisible()
  await expect(second.empty).toBeVisible()
  await expect(second.cards).toHaveCount(0)
  console.log('[cases] a project with no session is listed, but is not a case')

  // 3. A case is earned by running something: one real turn through the composer.
  await second.projects.getByRole('button', { name: projectName, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeVisible({ timeout: 60_000 })
  await sendPrompt(page, 'Say hello for the cases', 'Deterministic reply:')

  // The app comes back on the home page, the way the next morning looks.
  page = await app.restart()

  const third = home(page)
  await expect(third.cards).toHaveCount(1)
  const card = third.cards.first()
  await expect(card).toBeVisible()

  // The card carries a reading, not decoration: what the work produced, how many files, how big — and a
  // standing. A single turn with no finalized artifact is "Conversation only", and saying so is the point:
  // the section must not dress a chat log up as a reproducible case.
  await expect(card).toContainText('Conversation only')
  await expect(card).toContainText(/artifacts/)
  await expect(card).toContainText(/Ran here|last active/)
  // The name is derived, never the folder name: a card reading "Plaza case" would mean the naming rule
  // silently fell back to the project name.
  await expect(card).not.toContainText(projectName)
  console.log(`[cases] card: ${(await card.innerText()).replace(/\s+/g, ' ')}`)

  // 4. The card opens the case's own panel, which names what the case hands over and only then offers the
  //    project. Both steps are asserted, because a card that skips the panel is the old behaviour.
  await card.click()
  await expect(third.detail).toBeVisible()
  await expect(third.detail).toContainText('Files this case hands over')
  console.log(
    `[cases] detail: ${(await third.detail.innerText()).replace(/\s+/g, ' ').slice(0, 200)}`
  )

  await third.openCase.click()
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeVisible({ timeout: 60_000 })
  console.log(
    `[cases] after open: case_count=${await page.locator('[data-slot="case-plaza"]').count()}`
  )
  console.log('[cases] the case panel opened the project workspace')
})
