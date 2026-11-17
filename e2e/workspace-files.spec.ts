import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Project files journey'
const FILE_NAME = 'research-notes.md'
const FILE_CONTENT = '# Fixture findings\n\nDeterministic preview content.'

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

test('keeps bookmarks and the reference library under Files, with visible labels', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)

  // The real window, not a render: these two used to be unlabelled icons floating over the preview
  // workbench, where any opened page covered them. They are navigation rows now — in order under Files,
  // each carrying its own text — so a reader can tell what they are and no page can land on them.
  const filesRow = page.getByRole('button', { name: 'Files', exact: true })
  const bookmarksRow = page.getByTestId('workspace-bookmarks-toggle')
  const libraryRow = page.getByTestId('workspace-references-toggle')

  await expect(filesRow).toBeVisible()
  await expect(bookmarksRow).toBeVisible()
  await expect(libraryRow).toBeVisible()
  await expect(bookmarksRow).toHaveText(/\S/)
  await expect(libraryRow).toHaveText(/\S/)

  const filesBox = await filesRow.boundingBox()
  const bookmarksBox = await bookmarksRow.boundingBox()
  const libraryBox = await libraryRow.boundingBox()
  if (!filesBox || !bookmarksBox || !libraryBox) throw new Error('sidebar rows not laid out')
  expect(bookmarksBox.y).toBeGreaterThan(filesBox.y)
  expect(libraryBox.y).toBeGreaterThan(bookmarksBox.y)

  await libraryRow.click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('uploads an attachment and previews it from Project files', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)

  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: FILE_NAME,
    mimeType: 'text/markdown',
    buffer: Buffer.from(FILE_CONTENT)
  })
  await expect(page.getByRole('button', { name: `Remove attachment ${FILE_NAME}` })).toBeVisible()

  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Use the attached research notes.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.getByTestId('files-view')).toBeVisible()
  await page.getByRole('button', { name: `Preview uploaded file ${FILE_NAME}` }).click()

  const preview = page.getByRole('dialog', { name: `Preview ${FILE_NAME}` })
  await expect(preview).toBeVisible()
  await expect(preview.getByText('Fixture findings', { exact: true })).toBeVisible()
  await expect(preview.getByText('Deterministic preview content.', { exact: true })).toBeVisible()
  await preview.getByRole('button', { name: `Close preview of ${FILE_NAME}` }).click()
  await expect(preview).toBeHidden()
})
