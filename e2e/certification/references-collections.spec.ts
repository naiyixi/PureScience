import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'

// Acceptance for the reference collections lifecycle, on a real window with the real IPC surface.
//
// Before this change the library could create a collection and add records to it, and that was the end
// of the road: `references:delete-collection` and `references:remove-from-collection` existed in the
// main process and in preload, but nothing in the renderer reached them, so a collection could only
// ever grow. This walks the whole loop a researcher needs — create, file a record, take it out again,
// delete the collection — and then reuses the deleted name, which is the part that silently breaks
// when a delete only hides the row.

const PROJECT_NAME = 'Collections acceptance project'
const COLLECTION_NAME = 'Screen hits'
const RECORD_TITLE = 'A record to file'

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

const openLibrary = async (page: Page): Promise<ReturnType<Page['getByRole']>> => {
  await page.getByTestId('workspace-references-toggle').click()
  const library = page.getByRole('dialog', { name: 'Reference library' })
  await expect(library).toBeVisible()

  return library
}

test('a collection can be filled, emptied, deleted — and its name reused', async ({ app }) => {
  const page = await app.completeOnboarding()
  await createProject(page)
  const library = await openLibrary(page)

  // One record to sort into a collection.
  await library.getByRole('button', { name: 'Manual add' }).click()
  await library.getByPlaceholder('Title (required)').fill(RECORD_TITLE)
  await library.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(library.getByText(RECORD_TITLE).first()).toBeVisible()

  // Create the collection.
  const nameField = library.getByPlaceholder('New collection…')
  await nameField.fill(COLLECTION_NAME)
  await nameField.press('Enter')
  const collectionRow = library.getByRole('button', { name: COLLECTION_NAME, exact: true })
  await expect(collectionRow).toBeVisible()

  // File the record into it with the per-item collection menu, then confirm it shows up inside.
  const item = library.locator('li', { hasText: RECORD_TITLE })
  await item.locator('select').selectOption({ label: COLLECTION_NAME })
  await collectionRow.click()
  await expect(library.getByText(RECORD_TITLE).first()).toBeVisible()

  // Take it out again — the row offers this only while a collection is open.
  const filed = library.locator('li', { hasText: RECORD_TITLE })
  await filed.hover()
  await filed.getByTitle(`Remove from ${COLLECTION_NAME}`).click()
  await expect(library.getByText(`Removed from “${COLLECTION_NAME}”`)).toBeVisible()
  await expect(library.getByText('No references in this collection yet.')).toBeVisible()
  await expect(
    library.getByText('Open All items and use the collection menu on a reference to put it here.')
  ).toBeVisible()

  // Delete the collection: the confirmation names it and promises the records survive.
  await library.getByRole('button', { name: `Delete collection ${COLLECTION_NAME}` }).click()
  await expect(
    library.getByText(`Delete “${COLLECTION_NAME}”? Its references stay in the library.`)
  ).toBeVisible()
  await library.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(library.getByText(`Collection “${COLLECTION_NAME}” deleted`)).toBeVisible()
  await expect(collectionRow).toHaveCount(0)

  // The record survived, and the name is free again.
  await library.getByRole('button', { name: /^All items/ }).click()
  await expect(library.getByText(RECORD_TITLE).first()).toBeVisible()
  await nameField.fill(COLLECTION_NAME)
  await nameField.press('Enter')
  await expect(library.getByRole('button', { name: COLLECTION_NAME, exact: true })).toBeVisible()
})
