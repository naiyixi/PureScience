import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for IC9 on a real window: a managed artifact/upload preview could be DOWNLOADED but not
// opened. `artifacts:open-file` (resolve through the repository, then hand the OS a managed path, refusing
// anything outside artifact storage by name) and `localFs:reveal` both already existed and both already
// answered on this bus — probed directly and recorded in the evidence note — but no reader-facing control
// called them: the capability existed and the surface did not.
//
// This test therefore clicks the two real controls on a real generated artifact's preview and asserts the
// action is NOT refused — the badge that carries a named refusal stays absent. That is the real OS handoff
// (this run does open the file and reveal it in the file manager on the machine verifying it); the half that
// cannot be reached this way — a refusal actually rendered — is pinned in the jsdom render test beside the
// component, where the bridge can be made to fail on purpose.

test.setTimeout(180_000)

test('a managed artifact preview opens with the system app and shows in the folder', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Artifact open actions')
  await sendPrompt(page, 'Create a table PDF fixture.', 'Table PDF ready for session', 90_000)

  await page
    .getByRole('button', { name: /^Preview generated file table-evidence\.pdf$/ })
    .first()
    .click()
  await expect(page.getByTestId('preview-card')).toBeVisible()

  // Both controls are first-class buttons in the preview header rather than a hidden menu: the reader with
  // the file in front of them is exactly who needs them.
  const openWithSystem = page.getByTestId('artifact-open-with-system')
  const showInFolder = page.getByTestId('artifact-show-in-folder')
  await expect(openWithSystem).toBeVisible()
  await expect(showInFolder).toBeVisible()
  console.log(`[ic9] open-with-system label: ${await openWithSystem.getAttribute('aria-label')}`)
  console.log(`[ic9] show-in-folder label: ${await showInFolder.getAttribute('aria-label')}`)

  await showInFolder.click()
  await expect(page.getByTestId('artifact-open-failure')).toHaveCount(0)

  await openWithSystem.click()
  await expect(page.getByTestId('artifact-open-failure')).toHaveCount(0)
  console.log('[ic9] both controls answered with no refusal')
})
