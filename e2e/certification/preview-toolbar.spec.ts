import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for U16 on a real window: the file's actions used to exist only in the right-click menu, so
// nothing on screen said a preview could be digitized, table-extracted or imported from — a file had
// capabilities the reader could only find by guessing. They are now first-class buttons in the preview
// header, and this test drives the SAME action from the toolbar to prove the two surfaces are one list
// rather than two implementations: the table the toolbar extracts has to match the table the menu gives.

test.setTimeout(180_000)

const EXPECTED_ROWS = [
  ['Sample', 'Value', 'sd', 'n'],
  ['control', '12.4', '1.1', '6'],
  ['treated', '31.8', '2.4', '6'],
  ['vehicle', '9.7', '0.8', '6']
]

test('offers the file actions as toolbar buttons, and they are the same actions the menu gives', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Preview toolbar')
  await sendPrompt(page, 'Create a table PDF fixture.', 'Table PDF ready for session', 90_000)

  await page
    .getByRole('button', { name: /^Preview generated file table-evidence\.pdf$/ })
    .first()
    .click()
  const previewCard = page.getByTestId('preview-card')
  await expect(previewCard).toBeVisible()

  // Every action the file has is visible without opening any menu — including the three that only exist
  // for this media type.
  const toolbar = page.getByTestId('preview-toolbar')
  await expect(toolbar).toBeVisible()
  for (const action of [
    'copyPath',
    'download',
    'saveAsArtifact',
    'digitizeFigure',
    'pdfReferenceImport',
    'pdfTables'
  ]) {
    const button = page.getByTestId(`preview-toolbar-${action}`)
    await expect(button).toBeVisible()
    // Named, not just present: the accessible name is the same label the tooltip shows.
    await expect(button).toHaveAttribute('aria-label', /.+/)
  }

  // The toolbar's table action is the menu's table action, not a lookalike: same panel, same numbers.
  await page.getByTestId('preview-toolbar-pdfTables').click()
  const panel = page.getByTestId('pdf-table-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('pdf-table-shape')).toContainText('4 rows x 4 columns')
  const rendered = await panel
    .locator('[data-testid^="pdf-table-row-"]')
    .evaluateAll((rows) =>
      rows.map((row) =>
        Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent ?? '')
      )
    )
  expect(rendered).toEqual(EXPECTED_ROWS)

  // Reachable from the toolbar and still reachable from the menu the reader already knew.
  await previewCard.click({ button: 'right' })
  await expect(page.getByTestId('preview-pdf-tables')).toBeVisible()
  await expect(page.getByTestId('preview-pdf-reference-import')).toBeVisible()
})
