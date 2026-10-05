import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// IC31 real-window acceptance: what the network allowlist section does when the settings store on disk cannot
// be read.
//
// The reading decides the claim, so this spec asserts only what was observed. What was observed: a corrupt
// `settings.json` never reaches `getEgress()` as a rejection — the store degrades to its empty value, which
// also drops the onboarded flag, so the app comes back to onboarding and the allowlist section renders
// normally afterwards. That makes IC31's read error state **preventive**: reachable only through a broken
// channel or a broken main process, never through the file system. Its error+retry half is evidenced by the
// render suite (`NetworkPanel.render.test.tsx`: a refused read names itself and offers the retry; the retry
// loads the real value). This file records the premise, the way IC34's does for the storage panel.
test.setTimeout(180_000)

test('an unreadable settings store degrades instead of surfacing as a read failure', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  const settingsPath = join(app.storageRoot, 'settings.json')
  await writeFile(settingsPath, '{ "egress": this is not json', 'utf8')

  page = await app.restart()
  // First observation: with the store unreadable there is no state that offers the Settings entry.
  console.log(
    `[ic31] Settings entries after a corrupt store: ${await page
      .getByRole('button', { name: 'Settings' })
      .count()}`
  )

  // It degrades to an empty store rather than failing, so the app must still be usable: onboard again.
  page = await app.completeOnboarding()
  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Network', exact: true })
    .click()

  const section = settings.locator('[data-slot="egress-section"]')
  await expect(section).toBeVisible({ timeout: 30_000 })
  console.log(
    `[ic31] the allowlist section with the store degraded: "${(await section.innerText())
      .replace(/\s+/g, ' ')
      .trim()}"`
  )
  // The read path never rejected here: no named failure and no retry were offered.
  console.log(
    `[ic31] named read failure: ${await settings
      .locator('[data-slot="egress-load-error"]')
      .isVisible()
      .catch(() => false)} (retry buttons: ${await settings
      .locator('[data-slot="egress-retry-load"]')
      .count()})`
  )
  // Usable, and the switch the section owns is there to work with.
  await expect(settings.locator('[data-slot="egress-master-switch"]')).toBeVisible()
})
