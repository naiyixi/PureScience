import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

/**
 * The failed-runtime banner used to only describe the remedy. This proves, in a real window, that the
 * button next to that description reaches the repair path for the runtime the banner is about.
 *
 * The run is arranged so the check genuinely fails instead of being stubbed: the fake agent is on PATH as
 * OpenCode, and the active framework is then switched to Codex, which is not installed here. Opening the
 * Agent panel runs the environment check, so the banner is produced by the app's own logic.
 *
 * The click is only asserted up to the state it sets locally ("Reinstalling…"). A repair would download a
 * runtime, and an e2e run has no business performing that download — what needs proving is that the button
 * is wired to the active framework, and that is visible before any network call resolves.
 */
test('offers a one-click reinstall on the runtime whose check failed', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()

  await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { settings: { setAgentFramework: (request: { id: 'codex' }) => Promise<unknown> } }
    }
    await bridge.api.settings.setAgentFramework({ id: 'codex' })
  })
  page = await app.restart()

  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Agent', exact: true })
    .click()

  const repairButton = settings.getByRole('button', { name: 'Reinstall this agent' })
  await expect(repairButton).toBeVisible()
  // The banner says, next to the button, that the app-managed copy is removed first: the part the old
  // dialog never said.
  await expect(
    settings.getByText('Uninstalls the app-managed copy, then installs it again.')
  ).toBeVisible()

  await repairButton.click()
  await expect(settings.getByRole('button', { name: 'Reinstalling…' })).toBeVisible()
})
