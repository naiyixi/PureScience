import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for the PDF table panel on a real window: the page the fixture agent writes carries a four
// column table placed by the text matrix, and both sides of the app have to agree about it — the command
// the agent is given (`pdf:tables`) and the panel the user opens from the file's own menu must return the
// same columns, with the values under the headers they belong to. The panel used to derive tables from the
// text layer on its own, so this is the test that would have caught the two disagreeing.

test.setTimeout(180_000)

const EXPECTED_ROWS = [
  ['Sample', 'Value', 'sd', 'n'],
  ['control', '12.4', '1.1', '6'],
  ['treated', '31.8', '2.4', '6'],
  ['vehicle', '9.7', '0.8', '6']
]

test('reads a real table through the command the agent is given, and shows the same columns', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'PDF table extraction')
  await sendPrompt(page, 'Create a table PDF fixture.', 'Table PDF ready for session', 90_000)

  const receipt = await page.getByText(/^Table PDF ready for session /).innerText()
  const identity = receipt.match(
    /^Table PDF ready for session ([^,]+), artifact ([^,]+), version ([^.]+)\.$/
  )
  if (!identity) throw new Error(`Invalid PDF artifact receipt: ${receipt}`)
  const [, sessionId] = identity

  // What the agent is told: the same command the panel calls, on the same file.
  const result = await page.evaluate(
    async ({ projectId, sessionId }) => {
      const bridge = globalThis as unknown as {
        api: {
          sessions: {
            readDocument: (request: {
              projectId: string
              sessionId: string
            }) => Promise<{ artifacts?: Array<{ name?: string; path?: string }> } | undefined>
          }
          pdf: {
            open: (request: {
              projectId: string
              path: string
            }) => Promise<{ doc: { docId: string } }>
            tables: (request: { projectId: string; docId: string; page?: number }) => Promise<{
              scannedPages: number
              candidates: Array<{
                page: number
                method: string
                rows: string[][]
                columnCount: number
                markdown: string
                tsv: string
                html: string
                warnings: string[]
              }>
            }>
          }
        }
      }
      const document = await bridge.api.sessions.readDocument({ projectId, sessionId })
      const artifact = (document?.artifacts ?? []).find(
        (entry) => entry.name === 'table-evidence.pdf'
      )
      if (!artifact?.path)
        throw new Error('the table PDF artifact has no path in the session document')
      const opened = await bridge.api.pdf.open({ projectId, path: artifact.path })
      return bridge.api.pdf.tables({ projectId, docId: opened.doc.docId })
    },
    { projectId, sessionId }
  )

  expect(result.scannedPages).toBeGreaterThan(0)
  expect(result.candidates.length).toBeGreaterThan(0)
  const candidate = result.candidates[0]
  expect(candidate.page).toBe(1)
  // Four columns, found from the page's own positions rather than from spacing: the method name says
  // which of the two clusterings produced them.
  expect(candidate.columnCount).toBe(4)
  expect(candidate.method).toBe('text-layer-row-column-clustering')
  expect(candidate.rows.slice(0, EXPECTED_ROWS.length)).toEqual(EXPECTED_ROWS)
  // The exports the agent receives carry the audit, and so does the HTML the panel copies.
  for (const artifactText of [candidate.markdown, candidate.tsv, candidate.html]) {
    expect(artifactText).toContain('verify-against-source')
  }

  // The panel the user opens, from the file's own menu, must show those same columns: the preview first,
  // then the preview card's context menu, which is where the file's own actions live.
  await page
    .getByRole('button', { name: /^Preview generated file table-evidence\.pdf$/ })
    .first()
    .click()
  const previewCard = page.getByTestId('preview-card')
  await expect(previewCard).toBeVisible()
  await previewCard.click({ button: 'right' })
  await page.getByTestId('preview-pdf-tables').click()

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
  // The reasons it must be checked are on the panel, not only in the copied artifact.
  await expect(panel).toContainText('candidate-extraction')
  await expect(panel).toContainText('verify-against-source')
})
