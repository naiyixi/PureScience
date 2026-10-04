import { expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { test } from '../fixtures/electron-app'

// IC22 real-window acceptance: a row that cannot be used says why, and its toggle is inert.
//
// Both states are seeded into the isolated settings document and then re-read by a restart, because neither
// is reachable through the Add form (the form will not accept a URL-less HTTP server): the point of
// `availability` is exactly that an invalid persisted record stays visible but unusable.
test.setTimeout(180_000)

test('rows name why a server is unusable and their toggles are inert', async ({ app }) => {
  await app.completeOnboarding()

  const settingsPath = join(app.storageRoot, 'settings.json')
  const document = JSON.parse(await readFile(settingsPath, 'utf8')) as {
    connectors?: { customMcpServers?: unknown[] }
  }
  const connectors = (document.connectors ??= {})
  // `unavailable` is the route-unsafe state: a record that cannot claim a route because another server
  // already holds it. (The `!server.url` shape is also flagged in main, but such a record never survives a
  // reload — the loader drops it — so the collision is the reachable form.) The third record is an OAuth
  // server that has never been signed in.
  connectors.customMcpServers = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Duplicated Probe',
      description: 'Holds the route',
      transport: 'streamable_http',
      url: 'https://duplicated-probe.test/mcp',
      enabled: false
    },
    {
      id: '11111111-1111-4111-8111-222222222222',
      name: 'Duplicated Probe',
      description: 'Cannot hold the same route',
      transport: 'streamable_http',
      url: 'https://duplicated-probe.test/mcp',
      enabled: false
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Signed-out Probe',
      description: 'OAuth, never signed in',
      transport: 'streamable_http',
      url: 'https://signed-out-probe.test/mcp',
      enabled: false,
      oauth: {}
    }
  ]
  await writeFile(settingsPath, JSON.stringify(document, null, 2))

  const reopened = await app.restart()
  await reopened.getByRole('button', { name: 'Settings' }).first().click()
  const settings = reopened.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Connectors' })
    .click()

  const badges = settings.getByTestId('custom-server-availability')
  // Evidence, not a probe: what main holds after the reload. It is here because the fixture's shape needs
  // justifying — a record missing its url never survives this read (the loader drops it), which is why the
  // reachable `unavailable` form is the route collision below rather than a hole in the configuration.
  const held = await reopened.evaluate(async (): Promise<unknown> => {
    const snapshot = await window.api.settings.listConnectors()
    return (snapshot.customServers ?? []).map((server) => ({
      name: server.name,
      availability: server.availability ?? null,
      transport: server.transport,
      url: server.url ?? null
    }))
  })
  console.log(`[ic22] main holds: ${JSON.stringify(held)}`)
  await expect(badges).toHaveCount(3, { timeout: 60_000 })

  const reading = await settings.evaluate((root) => {
    const rows = Array.from(
      root.querySelectorAll('[data-testid="custom-server-availability"]')
    ).map((node) => {
      // The switch on the SAME row as the badge — that is the claim: this row cannot be used.
      const row = node.closest('li')
      const toggle = row?.querySelector<HTMLButtonElement>('[role="switch"]')
      return {
        state: node.getAttribute('data-availability') ?? '',
        // The app's own words, not a test string.
        text: (node.textContent ?? '').trim(),
        rowToggleDisabled: Boolean(toggle?.disabled)
      }
    })
    const allToggles = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="switch"]')).map(
      (node) => node.disabled
    )
    return { rows, allToggles }
  })
  console.log(`[ic22] badges: ${JSON.stringify(reading.rows)}`)

  // Both sides of a route collision are flagged (not just the later record), so the two duplicated rows
  // are unavailable and the OAuth one is unauthenticated.
  expect(reading.rows.map((row) => row.state).sort()).toEqual([
    'unauthenticated',
    'unavailable',
    'unavailable'
  ])
  expect(reading.rows.some((row) => row.text === 'Unavailable')).toBe(true)
  expect(reading.rows.some((row) => row.text === 'Sign-in required')).toBe(true)
  // Each labelled row is inert, and the app itself says why on hover.
  expect(reading.rows.every((row) => row.rowToggleDisabled)).toBe(true)
  expect(reading.rows.every((row) => row.text.length > 0)).toBe(true)
  const titles = await settings.evaluate((root) =>
    Array.from(root.querySelectorAll<HTMLButtonElement>('[role="switch"]'))
      .filter((node) => node.disabled)
      .map((node) => node.getAttribute('title') ?? '')
  )
  console.log(`[ic22] disabled switches explain themselves as: ${JSON.stringify(titles)}`)
  expect(titles.length).toBeGreaterThan(0)
  expect(titles.every((title) => title.length > 0)).toBe(true)
})
