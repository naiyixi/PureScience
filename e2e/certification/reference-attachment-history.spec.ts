import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// IC25 real-window acceptance: a replaced PDF leaves its history on the record, and the window shows it.
//
// The attachment writes are older than this unit (attachPdf has always recorded versions); what is new is that
// the history reaches a reader. So the fixture attaches twice through the app's own path — the second one
// displaces the first, which is exactly the state this unit displays — and the reading is about what the
// window makes of it. (Writing the rows straight into the database was tried first and did not work: Prisma's
// SQLite DateTime mapping is not the text form a raw INSERT produces, so the app's read found nothing. Its own
// write path is both simpler and truer to how the history comes to exist.)
test.setTimeout(180_000)

test('a replaced PDF leaves a readable history on its record', async ({ app }) => {
  const page = await app.completeOnboarding()
  const projectId = await createProject(page, 'Attachment history evidence')

  const referenceId = await page.evaluate(async (projectId: string): Promise<string> => {
    const created = await window.api.references.add({
      projectId,
      title: 'Attachment history probe',
      authors: [{ name: 'A. Author' }],
      year: 2026
    })
    // The result is a discriminated union: a duplicate comes back as a list rather than a new record.
    return created.status === 'created' ? created.reference.id : ''
  }, projectId)
  expect(referenceId).not.toBe('')

  const reading = await page.evaluate(
    async (input: {
      referenceId: string
      projectId: string
    }): Promise<{ count: number; current: string | null; rows: unknown[] }> => {
      await window.api.references.attachPdf(input.referenceId, 'managed-first')
      await window.api.references.attachPdf(input.referenceId, 'managed-second')
      // The read is per project, so the project id is part of the question.
      const listed = await window.api.references.list(input.projectId)
      const record = (
        listed as {
          id: string
          pdfManagedFileId?: string | null
          pdfVersions?: unknown[]
        }[]
      ).find((entry) => entry.id === input.referenceId)
      return {
        count: record?.pdfVersions?.length ?? 0,
        current: record?.pdfManagedFileId ?? null,
        rows: record?.pdfVersions ?? []
      }
    },
    { referenceId, projectId }
  )
  console.log(
    `[ic25] after two attaches: count=${reading.count} current=${reading.current} rows=${JSON.stringify(reading.rows)}`
  )
  // Settled by this reading, not assumed: the newest attachment sits on the record itself and the history
  // holds what it displaced, so two attaches leave exactly one displaced version to show.
  expect(reading.count).toBe(1)
  expect(reading.current).toBe('managed-second')

  const reopened = await app.restart()
  // Geometry belongs to the spec: the workspace toolbar (and the library toggle on it) is hidden below the
  // 768px breakpoint by design, so inheriting the host's window would exercise the mobile layout instead.
  await reopened.setViewportSize({ width: 1280, height: 800 })

  // The workspace toolbar renders only once a project is active, so the reader's first step is the project.
  await reopened.getByRole('button', { name: 'Attachment history evidence' }).first().click()

  // The library is opened the way a reader opens it.
  const toggles = reopened.getByRole('button', { name: 'References' })
  await expect(toggles.first()).toBeVisible({ timeout: 60_000 })
  await toggles.first().click()
  const dialog = reopened.getByRole('dialog', { name: 'Reference library' })
  await expect(dialog).toBeVisible({ timeout: 60_000 })

  const history = dialog.getByTestId('reference-attachment-history').first()
  await expect(history).toBeVisible({ timeout: 30_000 })
  const text = (await history.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[ic25] the history on screen: "${text}"`)

  // One displaced version is named: the day it was replaced, the day it had been attached, and its own file
  // suffix — a reader can tell which file is in force without opening anything, because the chip above names
  // the current one.
  const today = new Date().toISOString().slice(0, 10)
  expect(text).toContain('replaced')
  expect(text).toContain(today)
  expect(text.split('attached').length - 1).toBe(1)
  expect(text).toContain('ed-first')
  // The current attachment is named where it belongs — on the record's chip, not in the history.
  const dialogText = (await dialog.innerText()).replace(/\s+/g, ' ')
  expect(dialogText).toContain('current')
  expect(dialogText).toContain('d-second')
})
