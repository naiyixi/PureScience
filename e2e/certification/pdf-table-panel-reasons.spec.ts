import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for the two things the table panel must SAY about a page rather than leaving blank, read off
// the real window:
//   * a page that yielded no table says WHY, with the counts and floors the decision used (a prose page
//     fails the column floor and must come back as `too-few-columns`, not as an unexplained empty list);
//   * a page whose content stream is rotated says its coordinates were rewritten to upright — and still
//     reports the real table it carries (six rows by four columns), instead of the flat 4x1 page the
//     reader used to measure.
// Both readings are taken from the panel's rendered DOM, through the file's own menu, so the numbers here
// are the ones a user would see.

test.setTimeout(240_000)

const openTablePanel = async (
  page: import('playwright').Page,
  fileName: string
): Promise<import('playwright').Locator> => {
  await page
    .getByRole('button', {
      name: new RegExp(`^Preview generated file ${fileName.replace('.', '\\.')}$`)
    })
    .first()
    .click()
  const previewCard = page.getByTestId('preview-card')
  await expect(previewCard).toBeVisible()
  await previewCard.click({ button: 'right' })
  await page.getByTestId('preview-pdf-tables').click()
  const panel = page.getByTestId('pdf-table-panel')
  await expect(panel).toBeVisible()
  return panel
}

test('says why a prose page is not a table, and names the rotated page that was', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'PDF table panel reasons')

  // 1. A page of prose: no candidate, and a NAMED reason carrying the counts behind it.
  await sendPrompt(page, 'Create a prose PDF fixture.', 'Prose PDF ready for session', 90_000)
  const prosePanel = await openTablePanel(page, 'prose-evidence.pdf')

  const empty = prosePanel.getByTestId('pdf-table-empty')
  await expect(empty).toBeVisible()
  const rejection = prosePanel.getByTestId('pdf-table-rejection-1')
  await expect(rejection).toBeVisible()
  const rejectionText = (await rejection.innerText()).replace(/\s+/g, ' ').trim()
  // The reason is the extractor's own name, and the counts are the ones the measurement produced: five
  // rows of prose in one column, against a two-column floor. If the panel ever prints a reason without the
  // numbers, or numbers that disagree with the prose page, this is where it shows.
  expect(rejectionText).toContain('too-few-columns')
  expect(rejectionText).toContain('rows 5, columns 1')
  expect(rejectionText).toContain('needs 2+ rows and 2+ columns')
  expect(await prosePanel.getByTestId('pdf-table-candidate').count()).toBe(0)
  console.log(`[panel-reading] prose rejection line: ${rejectionText}`)
  console.log(
    `[panel-reading] prose empty line: ${(await empty.innerText()).replace(/\s+/g, ' ').trim()}`
  )

  await prosePanel.getByRole('button', { name: 'Close' }).click()
  await expect(prosePanel).toBeHidden()

  // 2. A rotated table: the panel says the coordinates were rewritten AND still reports the real grid.
  await sendPrompt(
    page,
    'Create a rotated table PDF fixture.',
    'Rotated table PDF ready for session',
    90_000
  )
  const rotatedPanel = await openTablePanel(page, 'rotated-table-evidence.pdf')

  await expect(rotatedPanel.getByTestId('pdf-table-shape')).toContainText('6 rows x 4 columns')
  const rotatedLine = rotatedPanel.getByTestId('pdf-table-rotated-1')
  await expect(rotatedLine).toBeVisible()
  const rotatedText = (await rotatedLine.innerText()).replace(/\s+/g, ' ').trim()
  expect(rotatedText).toContain('rotated 90')
  expect(rotatedText).toContain('normalized to upright')
  expect(rotatedText).toContain('will not line up with the page as displayed')
  // A page that carries a real table must not also be reported as having none.
  expect(await rotatedPanel.getByTestId('pdf-table-rejections').count()).toBe(0)
  expect(await rotatedPanel.getByTestId('pdf-table-empty').count()).toBe(0)
  const headerRow = await rotatedPanel
    .getByTestId('pdf-table-row-0')
    .evaluate((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) => (cell.textContent ?? '').trim())
    )
  expect(headerRow).toEqual(['Gene', 'log2FC', 'p-value', 'adjP'])
  console.log(`[panel-reading] rotated line: ${rotatedText}`)
  console.log(`[panel-reading] rotated header row: ${JSON.stringify(headerRow)}`)

  await rotatedPanel.getByRole('button', { name: 'Close' }).click()
  await expect(rotatedPanel).toBeHidden()
})
