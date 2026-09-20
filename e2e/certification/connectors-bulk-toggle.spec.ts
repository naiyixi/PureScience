import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// Acceptance for the bulk connector toggle on a real window: a batch change is applied connector by
// connector, reported connector by connector, and can be read back out of the app's own settings store
// instead of being taken from the summary line the panel prints.
//
// The read-back matters here: the panel updates the list optimistically, so a screenshot or a list that
// looks switched off proves nothing on its own. What has to hold is that the app's own settings store
// says every connector is off.

type ConnectorsSnapshot = { connectors: { id: string; enabled: boolean }[] }

test.setTimeout(180_000)

test('applies a bulk connector change and reports each connector', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()

  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Connectors' })
    .click()

  const before = (await page.evaluate(() =>
    window.api.settings.listConnectors()
  )) as ConnectorsSnapshot
  expect(before.connectors.filter((connector) => connector.enabled).length).toBeGreaterThan(0)

  await settings.getByRole('button', { name: /^Disable all \d+$/ }).click()

  // One line per connector plus the summary: a batch that reported only "done" would hide the connector
  // that was not applied.
  await expect(
    settings.getByText(/^\d+ changed · \d+ already in that state · \d+ not applied$/)
  ).toBeVisible()

  const after = (await page.evaluate(() =>
    window.api.settings.listConnectors()
  )) as ConnectorsSnapshot
  expect(after.connectors.filter((connector) => connector.enabled)).toEqual([])
  expect(after.connectors.map((connector) => connector.id)).toEqual(
    before.connectors.map((connector) => connector.id)
  )
})
