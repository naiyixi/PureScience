import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// IC32 real-window acceptance: while the notebook network allowlist owns the child-process route, the manual
// proxy below it is the inactive one. The section said so only in a source comment — the controls stayed fully
// editable and a saved value simply did not take effect, with nothing on screen to explain it.
//
// This drives the real switch: off → the manual proxy is live and nothing claims otherwise; on → the sentence
// appears and neither mode can be chosen; off again → both come back.
test.setTimeout(180_000)

test('the manual proxy names itself inactive while the network allowlist owns the route', async ({
  app
}) => {
  const page = await app.completeOnboarding()

  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Network', exact: true })
    .click()

  const master = settings.locator('[data-slot="egress-master-switch"]')
  await expect(master).toBeVisible({ timeout: 60_000 })
  const modes = settings.locator('input[name="proxy-mode"]')
  const note = settings.locator('[data-slot="proxy-inactive-while-egress"]')
  await expect(modes.first()).toBeAttached({ timeout: 30_000 })

  // Off: the manual proxy is the live route and nothing says otherwise.
  console.log(
    `[ic32] with the allowlist off: sentences=${await note.count()} modesDisabled=${await modes.first().isDisabled()}`
  )
  expect(await note.count()).toBe(0)
  expect(await modes.first().isDisabled()).toBe(false)

  // Turn the allowlist on through its own switch.
  await master.click()
  await expect(note).toBeVisible({ timeout: 30_000 })
  const noteText = (await note.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[ic32] with the allowlist on, the proxy section says: "${noteText}"`)
  const disabled = await modes.evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLInputElement).disabled)
  )
  console.log(`[ic32] mode inputs disabled while the allowlist is on: ${JSON.stringify(disabled)}`)
  expect(disabled.length).toBeGreaterThan(0)
  expect(disabled.every(Boolean)).toBe(true)

  // Turn it back off: the controls are live again and the sentence is gone.
  await master.click()
  await expect(note).toHaveCount(0, { timeout: 30_000 })
  expect(await modes.first().isDisabled()).toBe(false)
  console.log('[ic32] with the allowlist off again, the manual proxy is live and the sentence is gone')
})
