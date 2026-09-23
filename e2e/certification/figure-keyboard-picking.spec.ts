import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for keyboard picking on a real window: the whole digitisation — calibrating both axes, placing
// data points and exporting the CSV — is done with the keyboard, and the export is checked by reading back
// what actually left the panel rather than by trusting a click that reported nothing.
//
// The exported header is one stable English text whatever the UI language is, because the file is read
// outside the app. This is the test that fails if that header goes back to following the interface.

test.setTimeout(180_000)

test('digitises a figure with the keyboard alone and exports the CSV it produced', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Keyboard picking')
  await sendPrompt(page, 'Create a table PDF fixture.', 'Table PDF ready for session', 90_000)

  // The file's own menu is how a person reaches the panel; the preview has to be open for it to exist.
  await page.getByRole('button', { name: /^Preview generated file table-evidence\.pdf$/ }).click()
  await page.getByTestId('preview-card').click({ button: 'right' })
  await page.getByTestId('preview-digitize-figure').click()

  const surface = page.getByTestId('figure-pick-surface')
  const tickValue = page.getByLabel('Tick value')
  await expect(surface).toBeVisible()

  // A PDF page is not implied: the panel asks which page was digitised, and pre-fills 1. Typing into that
  // pre-filled field would append (the first run of this spec asked for page 11 that way).
  const pageNumber = page.getByTestId('digitize-page')
  await pageNumber.fill('')
  await pageNumber.pressSequentially('1')

  /** Places one point at the caret after moving it, entirely from the keyboard. */
  const place = async (
    key: 'ArrowRight' | 'ArrowDown',
    steps: number,
    tick?: string
  ): Promise<void> => {
    if (tick !== undefined) await tickValue.pressSequentially(tick)
    for (let index = 0; index < steps; index += 1) await surface.press(`Shift+${key}`)
    await surface.press('Enter')
  }

  await place('ArrowRight', 2, '0')
  await place('ArrowRight', 2, '40')
  await expect(page.getByTestId('figure-pick-phase')).toContainText('Calibrate the y axis')

  await place('ArrowDown', 2, '0')
  await place('ArrowDown', 2, '10')
  await expect(page.getByTestId('figure-pick-phase')).toContainText('Start clicking data points')

  await place('ArrowRight', 1)
  await place('ArrowDown', 1)
  await expect(page.getByTestId('figure-pick-progress')).toContainText('data points 2')

  // Export by keyboard, and check the outcome the panel reports.
  await page.getByRole('button', { name: /Export CSV/ }).press('Enter')
  await expect(page.getByTestId('figure-pick-export-status')).toContainText(
    'CSV copied · 2 data rows'
  )

  // What left the panel, read from the OS clipboard through the main process: the window itself is not
  // allowed to touch the clipboard at all, which is why copying goes through main in the first place.
  const csv = await app.readClipboardText()
  expect(csv).toContain('# status: estimated · needs review')
  expect(csv).toContain('# audit: passed (still needs review before use)')
  expect(csv).toContain('x,y,pixel_x,pixel_y')
  // The source line carries the Version identity (what the file is) and the name the user knows it by.
  expect(csv).toMatch(/# source: .+ page 1 table-evidence\.pdf/)
  expect(csv).toContain('figure regression estimate, not a raw measurement')

  const rows = csv
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .slice(1)
  expect(rows).toHaveLength(2)
  for (const row of rows) {
    expect(row.split(',')).toHaveLength(4)
  }
})
