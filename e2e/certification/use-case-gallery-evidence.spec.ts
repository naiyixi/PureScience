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
  // The four tool names are copied from the evidence file; if the panel shows anything else, the card and
  // the reading have drifted apart.
  await expect(page.locator('[data-slot="use-case-gallery-readings"]')).toContainText(
    '["list_project_files","list_projects","list_sessions","read_session"]'
  )
  await expect(page.locator('[data-slot="use-case-gallery-readings"]')).toContainText(
    '1 passed (7.8s)'
  )

  const quotes = await page.locator('[data-slot="use-case-gallery-quotes"]').innerText()
  await expect(page.locator('[data-slot="use-case-gallery-quotes"]')).toContainText(
    "external MCP server started { transport: 'tcp', host: '127.0.0.1', port: 63607, tools: 4 }"
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
