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
  const projectId = await createProject(page, 'Literature page selection')
  await sendPrompt(page, 'Create a table PDF fixture.', 'Table PDF ready for session', 90_000)

  // (flake, v2.33.2) The prompt's completion says the agent replied; it does not say the project-file
  // index has taken the PDF yet. `ManagedFile` rows are written by a scan after the bytes land, and the
  // picker reads that projection exactly once, when it opens — so opening it too early renders a
  // truthful-looking "No PDF files in this project." that never grows the row afterwards, and the
  // assertion below reports that empty state as a missing checkbox. Measured on the Windows runner
  // (release run 44918012666, job 136893439936): first attempt `element(s) not found` after 20 s over a
  // snapshot reading "No PDF files in this project.", retry passed 21 s later. Wait for the index through
  // the app's own bridge before opening the picker, mirroring the collection and the .pdf filter the
  // picker itself uses, so a red here names its own cause ("the index never took the file") instead of
  // borrowing the assertion timeout.
  await expect
    .poll(
      async () =>
        page.evaluate(async (id) => {
          const bridge = globalThis as unknown as {
            api: {
              projectFiles: {
                listFiles: (request: {
                  projectId: string
                  collection: { kind: 'all' }
                  limit: number
                }) => Promise<{ items: Array<{ name: string; mimeType?: string }> }>
              }
            }
          }
          const listing = await bridge.api.projectFiles.listFiles({
            projectId: id,
            collection: { kind: 'all' },
            limit: 100
          })
          return listing.items.some(
            (item) =>
              item.name.toLowerCase().endsWith('.pdf') ||
              item.mimeType?.toLowerCase() === 'application/pdf'
          )
        }, projectId),
      {
        timeout: 90_000,
        message:
          'the project-file index never took the fixture PDF, so the picker had nothing to list'
      }
    )
    .toBe(true)

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
  await expect(page.getByTestId('pdf-page-summary')).toContainText(
    'This page: 1 file(s) · 1 selected'
  )
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
