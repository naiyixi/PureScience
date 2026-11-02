import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// H1's real-window acceptance. The gallery's whole claim is that a card opens onto evidence rather than
// onto marketing copy: the measured values, the words the run itself produced, and a command that
// reproduces them. So this spec drives the product's own entry (the card on the home page), reads what
// the panel renders, and checks that the panel's content is the same string the unit-level guard requires
// to be present in the evidence file — a real window, a real click, a real clipboard bridge.
test.setTimeout(180_000)

test('a gallery card opens onto its readings, its own words, and a rerun command', async ({
  app
}) => {
  const page = await app.completeOnboarding()

  // The samples live behind a disclosure (`data-slot="capability-samples"`): the home page leads with the
  // reader's own cases, and the capability cards are what you open when you want the evidence. The entry is
  // therefore the summary, not an always-on grid — this spec expands it with a real click instead of
  // asserting that something the page deliberately folds away is already on screen (which is how it read
  // as `resolved to <section …> — unexpected value "hidden"` on the certification lane).
  const samples = page.locator('[data-slot="capability-samples"]')
  const summary = samples.locator('summary')
  await expect(summary).toBeVisible()

  const gallery = page.locator('[data-slot="use-case-gallery"]')
  // Folded until asked. Pinning that keeps the disclosure honest: a grid that is always open would mean the
  // home page leads with samples rather than with the work this machine actually did.
  await expect(gallery).toBeHidden()

  await summary.click()
  await expect(gallery).toBeVisible()

  // Eight since v2.21.1 (three cards joined: package-readings, session-density, import-authorization).
  // The count follows the data module rather than a literal, so adding a card does not require editing
  // an assertion that has nothing to say about the new card.
  const cards = page.locator('[data-slot^="use-case-gallery-card-"]')
  await expect(cards).toHaveCount(8)

  const card = page.locator('[data-slot="use-case-gallery-card-external-mcp"]')
  await expect(card).toBeVisible()
  await card.click()

  const dialog = page.locator('[data-slot="use-case-gallery-dialog"]')
  await expect(dialog).toBeVisible()

  const readings = await page.locator('[data-slot="use-case-gallery-readings"]').innerText()
  // The tool names are copied from the evidence file; if the panel shows anything else, the card and
  // the reading have drifted apart. The list grew from four to five when the write tool landed
  // (`archive_session`), so this assertion follows the card rather than the other way round.
  await expect(page.locator('[data-slot="use-case-gallery-readings"]')).toContainText(
    '["archive_session","list_project_files","list_projects","list_sessions","read_session"]'
  )
  await expect(page.locator('[data-slot="use-case-gallery-readings"]')).toContainText(
    '2 passed (18.3s)'
  )

  const quotes = await page.locator('[data-slot="use-case-gallery-quotes"]').innerText()
  await expect(page.locator('[data-slot="use-case-gallery-quotes"]')).toContainText(
    "permission decision { sessionId: 'e2e-session-1', toolCallId: '833308df…', decision: 'card', isMcp: true"
  )

  const command = await page.locator('[data-slot="use-case-gallery-command"]').innerText()
  await expect(page.locator('[data-slot="use-case-gallery-command"]')).toContainText(
    'e2e/certification/external-mcp-client.spec.ts --workers=1'
  )

  // The copy control goes through the app's clipboard bridge (the window denies the web API), so seeing
  // the confirmation means the bridge answered — not that a no-op promise resolved.
  const copy = page.locator('[data-slot="use-case-gallery-copy"]')
  await copy.click()
  await expect(copy).toContainText(/Copied|已复制/)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(card).toBeFocused()

  console.log(
    `[gallery] cards=${await cards.count()} opened=external-mcp readings=${readings.replace(/\s+/g, ' ').slice(0, 120)}`
  )
  console.log(`[gallery] quotes=${quotes.replace(/\s+/g, ' ').slice(0, 120)}`)
  console.log(`[gallery] command=${command}`)
  console.log(`[gallery] copy confirmed, focus returned to the card`)
})
