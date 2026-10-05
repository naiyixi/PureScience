import { statSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { formatBytes } from '../../src/shared/update'
import { test } from '../fixtures/electron-app'

// IC37 real-window acceptance: the support-bundle export reports what it wrote and how much it stripped.
//
// The main process has always computed `bytes` and `redactions` on the result; the panel showed only the path, so
// a reader had to open the archive to learn either. Now the message carries both.
//
// Only the native save dialog is stubbed (the fixture's one seam) — everything downstream is real: the bundle is
// assembled and written by the app, and the size in the message is cross-checked against the file on disk, so
// the number cannot be a coincidence of two places quoting the same stub.
test.setTimeout(180_000)

test('the support-bundle export reports the size and the redaction count', async ({ app }) => {
  const page = await app.completeOnboarding()
  const bundlePath = join(app.storageRoot, 'support-bundle.zip')
  await app.stubSaveDialog(bundlePath)

  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'General', exact: true })
    .click()
  await settings.getByRole('button', { name: /Export support bundle/i }).click()

  // The message is where the two numbers have to appear…
  const message = settings.getByText(/Support bundle saved to/i).first()
  await expect(message).toBeVisible({ timeout: 60_000 })
  const text = (await message.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[ic37] the panel says: "${text}"`)
  expect(text).toContain(bundlePath)

  // …the size it reports is the size on disk (read independently here, formatted by the same shared helper).
  const onDisk = statSync(bundlePath).size
  console.log(`[ic37] the bundle on disk: ${onDisk} bytes`)
  expect(onDisk).toBeGreaterThan(0)
  const reported = formatBytes(onDisk, 'en')
  console.log(`[ic37] that size as the panel would render it: "${reported}"`)
  expect(text).toContain(reported)

  // …and the redaction count is a number the reader can act on, not a placeholder.
  const redactions = /(\d+)\s+fields redacted/.exec(text)
  console.log(`[ic37] the redaction count it reports: ${redactions?.[1] ?? '(none)'}`)
  expect(redactions).not.toBeNull()
  expect(Number(redactions?.[1] ?? '-1')).toBeGreaterThanOrEqual(0)
})
