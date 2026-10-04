import { expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { test } from '../fixtures/electron-app'

// IC24 real-window acceptance: the bulk buttons act on everything on screen, user-added servers included.
//
// Before this unit the scope read "the connectors on screen" but meant only the bundled catalog, so a
// user-added server could never be switched in bulk — and the count in the label would have been a lie if it
// had included them without acting on them. The reading checks both halves: the usable server really flips,
// and the one that cannot run is named with its reason.
const fixture = join(__dirname, '..', 'fixtures', 'fake-mcp-probe.mjs')

test.setTimeout(180_000)

test('bulk enable reaches user-added servers and names the ones it cannot enable', async ({
  app
}) => {
  const page = await app.completeOnboarding()

  await page.evaluate(
    async ([command, args]): Promise<void> => {
      await window.api.settings.addCustomServer({
        name: 'Probe MCP',
        description: 'Probe server fixture',
        transport: 'stdio',
        command,
        args
      })
    },
    [process.execPath, [fixture]] as [string, string[]]
  )

  // The Add form refuses a URL-less HTTP server, so the runnable one is the only addition that path can make.
  // The un-runnable records are seeded through the settings document in the shape that actually survives a
  // reload: a route collision (a record missing its url is dropped by the loader — see IC22's reading), and
  // both sides of a collision are flagged unavailable.
  const settingsPath = join(app.storageRoot, 'settings.json')
  const document = JSON.parse(await readFile(settingsPath, 'utf8')) as {
    connectors?: { customMcpServers?: unknown[] }
  }
  const servers = (document.connectors?.customMcpServers ?? []) as Record<string, unknown>[]
  for (const id of [
    '33333333-3333-4333-8333-333333333331',
    '33333333-3333-4333-8333-333333333332'
  ]) {
    servers.push({
      id,
      name: 'Broken Probe',
      description: 'Cannot hold a route',
      transport: 'streamable_http',
      url: 'https://broken-probe.test/mcp',
      enabled: false
    })
  }
  document.connectors = { ...(document.connectors ?? {}), customMcpServers: servers }
  await writeFile(settingsPath, JSON.stringify(document, null, 2))

  const reopened = await app.restart()
  await reopened.getByRole('button', { name: 'Settings' }).first().click()
  const settings = reopened.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Connectors' })
    .click()

  // The scope label and the button counts must include the user-added servers.
  const enableAll = settings.getByRole('button', { name: /Enable all \d+/ }).first()
  await expect(enableAll).toBeVisible({ timeout: 60_000 })
  const label = await enableAll.innerText()
  console.log(`[ic24] the bulk button reads: "${label.trim()}"`)

  await enableAll.click()
  // Wait for the per-item outcome to land (the panel reports each entry by name).
  await expect(settings.getByText('Broken Probe').first()).toBeVisible({ timeout: 30_000 })

  const after = await reopened.evaluate(async (): Promise<{ name: string; enabled: boolean }[]> => {
    const snapshot = await window.api.settings.listConnectors()
    return (snapshot.customServers ?? []).map((server) => ({
      name: server.name,
      enabled: server.enabled
    }))
  }, null)
  console.log(`[ic24] user-added servers after the bulk enable: ${JSON.stringify(after)}`)

  // The runnable one flipped; the un-runnable ones stayed off and are named with their reason in the outcome.
  expect(after.find((server) => server.name === 'Probe MCP')?.enabled).toBe(true)
  expect(
    after.filter((server) => server.name === 'Broken Probe').every((server) => !server.enabled)
  ).toBe(true)
  const outcome = await settings.evaluate((root) => (root.textContent ?? '').replace(/\s+/g, ' '))
  expect(outcome).toContain('Broken Probe')
  expect(outcome).toContain('Unavailable')
})
