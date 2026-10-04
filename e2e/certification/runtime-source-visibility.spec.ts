import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// IC18 real-window acceptance: the window says WHERE the app-managed runtime comes from.
//
// The provisioner resolves this (official release CDN vs an override) and reports it on the provision
// status; the window never rendered it, so a machine pointed at a mirror looked exactly like one fetching
// from the vendor. This points the app at a local override and reads the panel — no download needed,
// because the source is part of the status the panel already loads. (The unit's first attempt found the
// field missing entirely on the no-provisioner fallback path; the fallback now reports it too, which is
// also the moment a user most wants to know: before anything is downloaded.)
process.env.PURESCIENCE_ENV_CDN_BASE = 'http://127.0.0.1:41999'

test.setTimeout(180_000)

test('the Settings card names the runtime source and shows the override URL', async ({ app }) => {
  const page = await app.completeOnboarding()

  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Runtimes' })
    .click()

  const source = settings.getByTestId('runtimes-bundle-source').first()
  await expect(source).toBeVisible({ timeout: 60_000 })
  const line = (await source.innerText()).replace(/\s+/g, ' ')
  console.log(`[ic18] runtime source on the card: ${line}`)

  // The override is named AND its URL is on screen — the whole point: before this unit the panel could not
  // tell a mirror apart from the vendor's CDN.
  expect(line.toLowerCase()).toContain('override')
  expect(line).toContain('http://127.0.0.1:41999')
})
