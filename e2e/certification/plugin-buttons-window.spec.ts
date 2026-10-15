import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

test.setTimeout(180_000)

// E3 (v2.3.0): the two buttons a READER presses, pressed in a real window.
//
// What the existing certification spec proves is that the plugin operations answer through the window's
// bridge and refuse a token the app never issued. That is the channel, not the act: it calls
// `pluginSourceDeploy({ token, confirmed: true })` directly, so it cannot say anything about what happens
// when a reader clicks. This spec closes exactly that gap, on the same red line the goals panel was held
// to — the button the reader actually presses has to have been pressed.
//
// The source is the retained public fixture repository (read-only, no credentials). The confirm box is the
// whole point: both buttons are disabled until it is ticked, and the window can only ever send
// `confirmed: true` from that tick, so "disabled → enabled" is an executable reading of the promise rather
// than a sentence about it.
test('the deploy and run-once buttons a reader presses answer in a real window', async ({ app }) => {
  const page = await app.completeOnboarding()

  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Specialists', exact: true })
    .click()

  // The plugin creator lives behind the specialists panel's import path. The entry may be the panel's own
  // affordance or a menu item, so open it and take whichever shape is there — the assertion that matters is
  // the source section being on screen, not which click produced it.
  await settings.getByRole('button', { name: 'Add specialist' }).first().click()
  const importEntry = page.getByRole('menuitem', { name: 'Import ZIP' })
  if (await importEntry.count()) await importEntry.first().click()
  const importButton = settings.getByRole('button', { name: 'Import ZIP' })
  if (await importButton.count()) await importButton.first().click()

  await expect(settings.getByText('From a public repository')).toBeVisible({ timeout: 30_000 })

  const reference = settings.getByPlaceholder('github:owner/repo@ref')
  await reference.fill('github:naiyixi/purescience-plugin-fixture')
  await settings.getByRole('button', { name: 'Read it' }).click()

  const confirm = settings.getByTestId('specialist-plugin-operation-confirm')
  await expect(confirm).toBeVisible({ timeout: 60_000 })

  const deploy = settings.getByTestId('specialist-plugin-deploy')
  const runOnce = settings.getByTestId('specialist-plugin-run-once')

  // Red line, first half: nothing is armed before the reader confirms.
  await expect(deploy).toBeDisabled()
  await expect(runOnce).toBeDisabled()
  console.log('[plugin-ops] before-confirm deploy=disabled runOnce=disabled')

  // ...and the tick is what arms them: the window cannot send confirmed: true any other way.
  await confirm.check()
  await expect(deploy).toBeEnabled()
  await expect(runOnce).toBeEnabled()

  // The act itself: deploy, and the panel has to give the real directory and the entry count.
  await deploy.click()
  // Two places carry this sentence on purpose — the act's own outcome and the deployed-plugins catalogue row
  // that now lists it — so read the first and name the second in the log.
  const deployed = settings.getByText(/Deployed .* file\(s\) · /)
  await expect(deployed.first()).toBeVisible({ timeout: 60_000 })
  const deployedText = (await deployed.first().innerText()).slice(0, 200)
  console.log(`[plugin-ops] deployed=${JSON.stringify(deployedText)}`)

  // Run once is a separate act and is judged by the app's own protection policy: under the shipped default
  // the answer is a named refusal, not a vague failure.
  await runOnce.click()
  const refused = settings.getByText(/Refused: approval-required/)
  const ran = settings.getByText(/^Ran /)
  await expect(refused.or(ran).first()).toBeVisible({ timeout: 60_000 })
  const outcome = (await refused.or(ran).first().innerText()).slice(0, 200)
  console.log(`[plugin-ops] run-once=${JSON.stringify(outcome)}`)
})
