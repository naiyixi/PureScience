import { expect } from '@playwright/test'
import { join } from 'node:path'

import { test } from '../fixtures/electron-app'

// IC19 real-window acceptance: a user-added MCP server has a Settings detail of its own, and its tool list
// is the one the server actually advertises.
//
// Before this unit `getConnectorDetail` looked the id up in the bundled catalog and threw for anything else,
// so the detail of a user-added server was simply unreachable from the window. The decisive evidence here is
// which tools appear: they exist only in the fixture process, so the panel cannot be showing a static list.
const fixture = join(__dirname, '..', 'fixtures', 'fake-mcp-probe.mjs')

test.setTimeout(180_000)

test('a user-added MCP server opens its detail with the tools the server advertises', async ({
  app
}) => {
  const page = await app.completeOnboarding()

  // Setup (not the subject of this reading): add the server through the same bridge the Settings form uses.
  const added = await page.evaluate(
    async ([command, args]): Promise<string> => {
      const snapshot = await window.api.settings.addCustomServer({
        name: 'Probe MCP',
        description: 'Probe server fixture',
        transport: 'stdio',
        command,
        args
      })
      const servers = (snapshot as { customServers: { id: string; name: string }[] }).customServers
      return servers.find((server) => server.name === 'Probe MCP')?.id ?? ''
    },
    [process.execPath, [fixture]] as [string, string[]]
  )
  expect(added).not.toBe('')
  console.log(`[ic19] added custom server id: ${added}`)

  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Connectors' })
    .click()

  // The row's name is the way in — the same interaction a bundled connector has.
  await settings
    .getByRole('button', { name: /Probe MCP/ })
    .first()
    .click()

  // The tool list comes from the fixture process over stdio, so seeing both names here proves the live list
  // reached the detail page (a static or bundled list could not produce them).
  const alpha = settings.getByText('probe_alpha', { exact: true }).first()
  const beta = settings.getByText('probe_beta', { exact: true }).first()
  await expect(alpha).toBeVisible({ timeout: 60_000 })
  await expect(beta).toBeVisible({ timeout: 30_000 })
  console.log('[ic19] detail shows the live tool list: probe_alpha, probe_beta')

  // Per-tool permission, on the custom server, through the UI.
  const control = settings.getByRole('radiogroup', { name: 'Permission for probe_alpha' }).first()
  // The segments inside are `role="radio"` (a radiogroup's children), not plain buttons — asking for
  // buttons returns zero elements and looks like "the control is missing".
  const buttons = control.getByRole('radio')
  const labels = await buttons.evaluateAll((nodes): string[] =>
    nodes.map((node) => node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '')
  )
  console.log(`[ic19] permission control options: ${labels.join(' | ')}`)
  expect(labels.length).toBeGreaterThanOrEqual(3)
  await buttons.nth(labels.length - 1).click() // last = block

  // Read back through the main process: the choice must have been persisted for THIS server's tool.
  const permission = await page.evaluate(async (id: string): Promise<string> => {
    const detail = await window.api.settings.getConnectorDetail(id)
    return detail.tools.find((tool) => tool.method === 'probe_alpha')?.permission ?? ''
  }, added)
  console.log(`[ic19] probe_alpha permission after the click: ${permission}`)
  expect(permission).toBe('block')
})
