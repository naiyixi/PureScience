import { expect } from '@playwright/test'
import { join } from 'node:path'

import { test } from '../fixtures/electron-app'

// IC20 real-window acceptance: the "Skip approvals" switch on a user-added server actually holds.
//
// The switch existed, rendered, and called the right main-process channel — but the detail read `autoAllow`
// back as a hardcoded false, so it showed off again the moment the page re-read its state: a control that
// looks live and is a no-op. This drives it through the UI and then asks the main process what is stored,
// because "the switch moved" and "the setting exists" are different facts.
const fixture = join(__dirname, '..', 'fixtures', 'fake-mcp-probe.mjs')

test.setTimeout(180_000)

test('the skip-approvals switch on a user-added server persists and reads back', async ({
  app
}) => {
  const page = await app.completeOnboarding()

  const added = await page.evaluate(
    async ([command, args]): Promise<string> => {
      const snapshot = await window.api.settings.addCustomServer({
        name: 'Probe MCP',
        description: 'Probe server fixture',
        transport: 'stdio',
        command,
        args
      })
      return snapshot.customServers.find((server) => server.name === 'Probe MCP')?.id ?? ''
    },
    [process.execPath, [fixture]] as [string, string[]]
  )
  expect(added).not.toBe('')

  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Connectors' })
    .click()
  await settings
    .getByRole('button', { name: /Probe MCP/ })
    .first()
    .click()

  // The switch's accessible name is the app's own label for this server — it carries the server ID, not the
  // display name (settings.skipApprovalsFor is filled with the id).
  const toggle = settings.getByRole('switch', { name: new RegExp(added) }).first()
  await expect(toggle).toBeVisible({ timeout: 60_000 })
  const before = await toggle.getAttribute('aria-checked')
  console.log(`[ic20] skip-approvals before: aria-checked=${before}`)
  expect(before).toBe('false')

  await toggle.click()

  // Read the setting the same way the panel does — through the detail — and confirm it is the server's id
  // the approval gate matches on (a server's own aliases include its id).
  const persisted = await page.evaluate(async (id: string): Promise<boolean> => {
    const detail = await window.api.settings.getConnectorDetail(id)
    return detail.autoAllow
  }, added)
  console.log(`[ic20] detail.autoAllow after the click: ${persisted}`)
  expect(persisted).toBe(true)

  // And the switch must still read ON after the page re-reads its state — this is what was broken.
  await settings.getByRole('button', { name: 'Back to connectors' }).first().click()
  await settings
    .getByRole('button', { name: /Probe MCP/ })
    .first()
    .click()
  const reopened = settings.getByRole('switch', { name: new RegExp(added) }).first()
  await expect(reopened).toBeVisible({ timeout: 30_000 })
  const after = await reopened.getAttribute('aria-checked')
  console.log(`[ic20] skip-approvals after re-opening the detail: aria-checked=${after}`)
  expect(after).toBe('true')
})
