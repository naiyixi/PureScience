import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for U19 on a real window: `pdf:outline` and `pdf:figures` have had no surface at all since the
// PDF reader landed, so a reader could not see that a paper has a contents tree, nor which pages carry
// figures before quoting one. The panel is opened from the preview toolbar and reads the same channels the
// agent's tools do — so what it says has to be what the reader actually parsed, including saying that this
// document declares no bookmarks rather than showing an empty box.

test.setTimeout(180_000)

test('opens the document structure panel from the preview toolbar', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'PDF structure')
  await sendPrompt(page, 'Create a table PDF fixture.', 'Table PDF ready for session', 90_000)

  await page
    .getByRole('button', { name: /^Preview generated file table-evidence\.pdf$/ })
    .first()
    .click()
  await expect(page.getByTestId('preview-card')).toBeVisible()

  // The entry is a button like every other file action — not something only a context menu knows about.
  await page.getByTestId('preview-toolbar-pdfExplore').click()
  const panel = page.getByTestId('pdf-explore-panel')
  await expect(panel).toBeVisible()

  // Real parse, real numbers: the scan line carries the page count the reader returned.
  const scan = panel.getByTestId('pdf-explore-figures-scan')
  await expect(scan).toContainText(/\d+/)

  // The fixture declares no bookmarks: the panel says so instead of leaving the section blank.
  await expect(panel.getByTestId('pdf-explore-outline-empty')).toBeVisible()

  // Figures are either grouped by page, or the panel says it accepted none — never a bare empty list.
  const grouped = await panel.locator('[data-testid^="pdf-explore-figure-page-"]').count()
  if (grouped === 0) {
    await expect(panel.getByTestId('pdf-explore-figures-empty')).toBeVisible()
  } else {
    await expect(panel.locator('[data-testid^="pdf-explore-figure-page-"]').first()).toBeVisible()
  }

  // And it closes like the other panels do.
  await panel.getByRole('button', { name: /close/i }).click()
  await expect(panel).toBeHidden()
})
