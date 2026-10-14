import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// C2 (v2.2.0): the literature library's PDF picker gained a page pair — select every row on the page, and
// clear that page — beside a line that states the page it is acting on.
//
// Everything here is the real window. The candidate is a real PDF artifact written through the app's own
// artifact tool (the fixture's 'Create a table PDF fixture.' prompt), listed by the app's own project-file
// index (the picker asks for collection 'all', which applies no source filter), and the pair is clicked in
// the real UI. Nothing about the picker or the selection is stubbed.
test('the literature library PDF picker selects and clears the page it names', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Literature page selection')
  await sendPrompt(page, 'Create a table PDF fixture.', 'Table PDF ready for session', 90_000)

  // Open the references library the way the window does, then its PDF picker.
  await page.getByRole('button', { name: 'References' }).click()
  await page.getByRole('button', { name: 'Import PDFs' }).click()

  const selectAll = page.getByTestId('pdf-page-select-all')
  const clearPage = page.getByTestId('pdf-page-clear')
  await expect(selectAll).toBeVisible({ timeout: 30_000 })

  // The project's PDF is on the page, so the selecting side has work to do and the clearing side does not.
  // Scoped to the dialog: the same file name also appears in the preview panel behind it.
  await expect(page.getByRole('checkbox', { name: 'table-evidence.pdf' })).toBeVisible()
  await expect(selectAll).toBeEnabled()
  await expect(clearPage).toBeDisabled()

  await selectAll.click()

  // The scope line names the page the selection was taken from, and the pair swaps sides.
  await expect(page.getByTestId('pdf-page-summary')).toContainText('This page: 1 file(s) · 1 selected')
  await expect(page.getByRole('button', { name: 'Import as new records (1)' })).toBeVisible()
  await expect(selectAll).toBeDisabled()
  await expect(clearPage).toBeEnabled()

  await clearPage.click()

  // Clearing the page leaves nothing selected, and no scope line is claimed for an empty selection.
  await expect(page.getByTestId('pdf-page-summary')).toHaveCount(0)
  // The picker's title is text, not a control: the count that matters is on the action button.
  await expect(page.getByText('Import from project PDFs (selected 0)')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import as new records (0)' })).toBeDisabled()
  await expect(clearPage).toBeDisabled()
})
