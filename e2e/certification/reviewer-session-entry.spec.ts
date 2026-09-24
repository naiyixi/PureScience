import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// Acceptance for U18 on a real window: the verification checklist and the folded-context timeline are
// session-scoped and never needed a review row — but the only ways in started from an existing review, so
// a session with no review yet could not be inspected at all. The session information card now carries the
// entry, and the surface explains the missing checks tab instead of looking broken.

test.setTimeout(180_000)

test('reaches the checklist from the session itself, before any review exists', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Reviewer entry')

  // One exchange, so the session exists and has something to verify.
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Summarise the calibration notes')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeEnabled()

  await page.getByTestId('conversation-title-button').click()
  await page.locator('[data-slot="session-info-card"]').waitFor({ state: 'visible' })

  const entry = page.getByTestId('session-info-open-review')
  await expect(entry).toBeVisible()
  await expect(entry).toContainText('Verification checklist')
  await entry.click()

  // Session-scoped tabs are reachable either way; the checks tab is the one that needs a review row.
  const checklistTab = page.getByTestId('reviewer-tab-checklist')
  const contextTab = page.getByTestId('reviewer-tab-context')
  await expect(checklistTab).toBeVisible()
  await expect(contextTab).toBeVisible()

  if ((await page.getByTestId('reviewer-tab-checks').count()) === 0) {
    // No review in this session: the surface has to say so rather than render an empty checks tab.
    await expect(page.getByTestId('reviewer-no-review')).toContainText('No review yet for this session')
  }

  // The folded-context tab works without a review too.
  await contextTab.click()
  await expect(contextTab).toHaveAttribute('aria-pressed', 'true')
  await checklistTab.click()
  await expect(checklistTab).toHaveAttribute('aria-pressed', 'true')
})
