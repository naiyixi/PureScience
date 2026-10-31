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

  const gallery = page.locator('[data-slot="use-case-gallery"]')
  await expect(gallery).toBeVisible()

  const cards = page.locator('[data-slot^="use-case-gallery-card-"]')
  await expect(cards).toHaveCount(5)

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
    `[gallery] cards=5 opened=external-mcp readings=${readings.replace(/\s+/g, ' ').slice(0, 120)}`
  )
  console.log(`[gallery] quotes=${quotes.replace(/\s+/g, ' ').slice(0, 120)}`)
  console.log(`[gallery] command=${command}`)
  console.log(`[gallery] copy confirmed, focus returned to the card`)
})
