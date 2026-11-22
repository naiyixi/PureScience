import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, receiptText, sendPrompt, sessionArtifactPath } from './helpers'

// Acceptance for figure extraction on a real window: the page the fixture agent writes carries a picture
// and a caption under it, and the app's own pdf:figures command must find them — through the same public
// path the agent uses, on the same file, with the caption attached and the counts that keep an empty
// result honest.

test.setTimeout(180_000)

test('extracts the figure and its caption from a real PDF through the app command', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'PDF figure evidence')
  await sendPrompt(page, 'Create a region drawing PDF.', 'Region PDF ready for session', 90_000)

  const receipt = await receiptText(page.getByText(/^Region PDF ready for session /))
  const identity = receipt.match(
    /^Region PDF ready for session ([^,]+), artifact ([^,]+), version ([^.]+)\.$/
  )
  if (!identity) throw new Error(`Invalid PDF artifact receipt: ${receipt}`)
  const [, sessionId] = identity

  // The file on disk is the one the session document records for that artifact: the command reads a path,
  // so the path has to come from the app rather than from a guess about the storage layout. The row is a
  // separate write from the reply above, so wait for it — and if it never comes, the helper says which of
  // the two ways it did not come.
  const path = await sessionArtifactPath(page, {
    projectId,
    sessionId,
    name: 'region-evidence.pdf'
  })

  const result = await page.evaluate(
    async ({ projectId, path }) => {
      const bridge = globalThis as unknown as {
        api: {
          pdf: {
            open: (request: { projectId: string; path: string }) => Promise<{
              doc: { docId: string }
            }>
            figures: (request: { projectId: string; docId: string; page?: number }) => Promise<{
              figures: Array<{
                page: number
                index: number
                bbox: { x: number; y: number; width: number; height: number }
                caption?: string
                captionSource: string
                warnings: string[]
              }>
              skippedSmall: number
              withoutCaption: number
            }>
          }
        }
      }
      const opened = await bridge.api.pdf.open({ projectId, path })
      return bridge.api.pdf.figures({ projectId, docId: opened.doc.docId })
    },
    { projectId, path }
  )

  // The picture the fixture painted: 200x150 points at (100, 500) in the page's own space.
  expect(result.figures.length).toBeGreaterThan(0)
  const figure = result.figures[0]
  expect(figure.page).toBe(1)
  expect(Math.round(figure.bbox.width)).toBe(200)
  expect(Math.round(figure.bbox.height)).toBe(150)

  // And the caption the document wrote under it, attached by proximity and said to be just that.
  expect(figure.caption).toContain('Figure 1.')
  expect(figure.captionSource).toBe('below')
  expect(figure.warnings.join(' ')).toContain('confirm it labels this figure')
  expect(result.withoutCaption).toBe(0)
})
