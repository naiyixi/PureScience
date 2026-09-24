import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for U20 on a real window: `figure:review` — the publication-grade correctness checklist —
// existed only as the agent's tool, so a reader looking at a figure had no way to ask the questions the
// engine already answers. The panel runs the real rule engine over the reader's own declaration, and this
// test drives two declarations whose outcome the engine's rules fix: nine series must be an error (above
// the eight distinguishable hues), and a compliant declaration must come back clean. Both numbers come
// from real data the reader typed, so nothing here is a lookalike of a result.

test.setTimeout(180_000)

test('runs the figure checks over what the reader declares, and reports the engine’s own findings', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Figure review')
  await sendPrompt(page, 'Create a table PDF fixture.', 'Table PDF ready for session', 90_000)

  await page
    .getByRole('button', { name: /^Preview generated file table-evidence\.pdf$/ })
    .first()
    .click()
  await expect(page.getByTestId('preview-card')).toBeVisible()

  // The entry is a first-class file action, and it says up front what it cannot cover.
  await page.getByTestId('preview-toolbar-figureReview').click()
  const panel = page.getByTestId('figure-review-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('figure-review-author-only')).toBeVisible()

  // Nine series: the colour rule fires, with its own rule id and severity.
  await panel.getByTestId('figure-review-series-count').fill('9')
  await panel.getByTestId('figure-review-run').click()
  await expect(panel.getByTestId('figure-review-result')).toBeVisible()
  const finding = panel.locator('[data-rule="color-threading"]').first()
  await expect(finding).toBeVisible()
  await expect(finding).toHaveAttribute('data-severity', 'error')
  await expect(finding).toContainText('9')
  await expect(panel.getByTestId('figure-review-clean')).toBeHidden()

  // Two series and a declared inspection: the same engine comes back clean, so the finding above was the
  // declaration's doing and not a fixed banner.
  await panel.getByTestId('figure-review-series-count').fill('2')
  await panel.getByTestId('figure-review-rendered').check()
  await panel.getByTestId('figure-review-run').click()
  await expect(panel.getByTestId('figure-review-clean')).toBeVisible()

  await panel.getByRole('button', { name: /close/i }).click()
  await expect(panel).toBeHidden()
})
