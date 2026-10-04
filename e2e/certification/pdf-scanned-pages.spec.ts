import { existsSync, statSync } from 'node:fs'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// Real-machine reading for the PDF empty-page notice: the two panels (explore / tables) now display
// `emptyPageCount`, which they previously dropped. What has to be true off a render fixture is that the
// app's own reader MEASURES a text-free document as text-free — a scanned page carries no text layer, and
// that number is the reason an outline, figure list or table scan comes back empty on a document that
// plainly has pages.
//
// The fixture is a real image-only PDF made on this machine (`sips -s format pdf` over a PNG): no /Font,
// no /Text, two pages. The assertion is on the app's own measurement, not on a mock.
const SCAN_PDF = '/tmp/pdfscan/scan.pdf'

test.setTimeout(180_000)

test('the reader measures a text-free document as having no extractable text', async ({ app }) => {
  test.skip(!existsSync(SCAN_PDF), 'no scanned fixture on this machine')
  console.log(`[pdf-scan] fixture ${SCAN_PDF} (${statSync(SCAN_PDF).size} bytes)`)

  const page = await app.completeOnboarding()
  const projectId = await createProject(page, 'Scanned pdf')

  const reading = await page.evaluate(
    async ({ projectId, path }) => {
      const bridge = globalThis as unknown as {
        api: {
          pdf: {
            open: (request: { projectId: string; path: string }) => Promise<{
              doc: { pageCount: number }
              textPageCount: number
              emptyPageCount: number
            }>
          }
        }
      }
      try {
        const opened = await bridge.api.pdf.open({ projectId, path })
        return {
          ok: true as const,
          pageCount: opened.doc.pageCount,
          textPageCount: opened.textPageCount,
          emptyPageCount: opened.emptyPageCount
        }
      } catch (error) {
        return { ok: false as const, detail: String(error).replace(/^Error: /, '') }
      }
    },
    { projectId, path: SCAN_PDF }
  )

  console.log(`[pdf-scan] ${JSON.stringify(reading)}`)
  if (!reading.ok) throw new Error(`the reader refused the fixture: ${reading.detail}`)

  // Every page is image-only, so nothing is extractable — the invariant is "no page carried text", not a
  // page count guessed from the file's bytes (which is how this expectation was first written, and the
  // reader was right while the guess was wrong: the fixture is one page, not two).
  expect(reading.pageCount).toBeGreaterThan(0)
  expect(reading.textPageCount).toBe(0)
  expect(reading.emptyPageCount).toBe(reading.pageCount)
})
