import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// IC26 real-window acceptance: a record's notes are editable from the library and the edit persists.
//
// The column, the create path and the list projection all existed — a reader could set notes only by creating
// the record — so what this reading has to prove is the write from the window and that it survives a restart
// (a document field that only reaches memory is the classic half-delivered shape).
test.setTimeout(180_000)

test('notes written in the library persist across a restart', async ({ app }) => {
  const page = await app.completeOnboarding()
  const projectId = await createProject(page, 'Reference notes evidence')

  await page.evaluate(async (projectId: string): Promise<void> => {
    await window.api.references.add({
      projectId,
      title: 'Notes probe',
      authors: [{ name: 'A. Author' }],
      year: 2026
    })
  }, projectId)

  const openLibrary = async (target: typeof page): Promise<void> => {
    // Geometry belongs to the spec: the workspace toolbar is hidden below the 768px breakpoint.
    await target.setViewportSize({ width: 1280, height: 800 })
    // The toolbar renders once a project is active, and the instance can be in either state: with none active
    // the sidebar shows a "Projects" list whose rows are buttons named after the project; with one active that
    // list is replaced by a "Switch project" control and the project's own row disappears. Wait for whichever
    // marker this state has before acting on it — asking too early is a race that reads as a missing feature.
    const projectRow = target.getByRole('button', { name: 'Reference notes evidence' })
    const toggles = target.getByRole('button', { name: 'References' })
    await expect(async () => {
      const ready = (await toggles.count()) > 0 || (await projectRow.count()) > 0
      expect(ready).toBe(true)
    }).toPass({ timeout: 60_000 })
    if ((await toggles.count()) === 0) {
      await projectRow.first().click()
    }
    await expect(toggles.first()).toBeVisible({ timeout: 60_000 })
    await toggles.first().click()
    await expect(target.getByRole('dialog', { name: 'Reference library' })).toBeVisible({
      timeout: 60_000
    })
  }

  await openLibrary(page)
  const dialog = page.getByRole('dialog', { name: 'Reference library' })

  // Write through the window: the row's notes control, the field, then save.
  await dialog.getByRole('button', { name: 'Notes' }).first().click()
  const field = dialog.getByRole('textbox', { name: 'Notes' }).first()
  await expect(field).toBeVisible({ timeout: 30_000 })
  await field.fill('Recheck the supplement section before citing it.')
  await dialog.getByRole('button', { name: 'Save notes' }).first().click()

  // Read back through main — the same question the window asks when it renders the row.
  const notes = await page.evaluate(async (projectId: string): Promise<string> => {
    const listed = await window.api.references.list(projectId)
    const record = (listed as { title: string; notes?: string }[]).find(
      (entry) => entry.title === 'Notes probe'
    )
    return record?.notes ?? ''
  }, projectId)
  console.log(`[ic26] notes read back through main: "${notes}"`)
  expect(notes).toBe('Recheck the supplement section before citing it.')

  // Shown on the record itself once the editor is closed.
  await expect(dialog.getByText('Recheck the supplement section before citing it.')).toBeVisible({
    timeout: 30_000
  })

  // And it is durable: a fresh instance still shows it.
  const reopened = await app.restart()
  await openLibrary(reopened)
  const dialogAgain = reopened.getByRole('dialog', { name: 'Reference library' })
  await expect(
    dialogAgain.getByText('Recheck the supplement section before citing it.')
  ).toBeVisible({ timeout: 60_000 })
  console.log('[ic26] the notes are still on the record after a restart')
})
