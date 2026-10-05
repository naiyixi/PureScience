import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// IC38 real-window acceptance: the address an earlier session saved is still shown while remote access is off.
// `remoteItPublicUrl` is documented as the "saved browser-access endpoint, including while locally disabled",
// yet the panel rendered only `accessUrl` behind `enabled` — so turning access off also hid the one address a
// reader needs to get back in.
//
// The saved state is planted the way the app itself stores it (`remote-access.json`, version 4) and the app is
// restarted, so this reads a real snapshot of a real store rendered by the real panel.
//
// What is deliberately NOT done here: driving the full public flow (mode `remoteit-public`) through the app.
// That mode starts the local web server on 44100, and this machine's resident instance already holds that port
// (`listen EADDRINUSE … 127.0.0.1:44100`, observed while writing this spec), so the flow cannot complete without
// stopping a service the user is running. Recorded rather than worked around.
test.setTimeout(180_000)

test('the saved browser address is shown while remote access is off', async ({ app }) => {
  await app.completeOnboarding()

  const savedUrl = 'https://fixture.connect.remote.it/'
  // The store keeps the public URL only together with the browser service id it belongs to
  // (`repository.ts`: a saved URL without its service id is dropped by design), so both are planted.
  writeFileSync(
    join(app.storageRoot, 'remote-access.json'),
    JSON.stringify(
      {
        version: 4,
        mode: 'off',
        remoteItBrowserServiceId: 'browser-service',
        remoteItPublicUrl: savedUrl,
        trustedBrowsers: []
      },
      null,
      2
    )
  )

  const page = await app.restart()
  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Remote control', exact: true })
    .click()

  const saved = settings.locator('[data-slot="saved-browser-address"]')
  const section = settings.getByRole('region', { name: 'Saved browser address' })
  await expect(section).toBeVisible({ timeout: 60_000 })
  const text = (await saved.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[ic38] with access off, the panel shows: "${text}"`)
  expect(text).toContain(savedUrl)
  expect(text).toContain('does not answer right now')

  // Read-only, with copy as the only action: the address is text, not a link the panel invites you to open
  // (it does not answer while access is off, so offering "open" would be a control that cannot do its job).
  const buttons = await saved.locator('button').count()
  const links = await saved.locator('a').count()
  console.log(`[ic38] controls inside the block: buttons=${buttons} links=${links}`)
  expect(buttons).toBe(1)
  expect(links).toBe(0)
})
