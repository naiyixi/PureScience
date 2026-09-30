import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for 文档标注层 A5 接线: the triage export now carries the ANNOTATION EVIDENCE of the range it
// already knew how to write — on a real window, over the real IPC surface, a real project database, real
// PDFs on disk and a real file at the end.
//
// What it walks, and why each step is here:
//
//   * two PDFs are produced by the fixture agent through the app's own artifact tool. ONE of them
//     (`annotated-evidence.pdf`) carries a highlight of its own, which the app's import channel reads in
//     through the interface — so the included record's citation quotes a passage the FILE marked, not a
//     passage this test typed. The other (`region-evidence.pdf`) is annotated with a real drag on the page,
//     which is what gives the EXCLUDED record a markup of its own to be left out;
//   * both PDFs are attached to records through the library's own PDF picker, and both records are screened
//     in one collection with a human override in each direction — so the exported range is decided the way
//     it is decided in use, and the two records differ in exactly one way: the verdict;
//   * the export writes a real file (the one seam replaced is the native save dialog, because no test can
//     operate one) and the test reads that file BACK FROM DISK and asserts, from its own bytes: the numbered
//     bibliography is unchanged and still `[1] …`; the included record's citation is in the evidence block
//     with the same `[1]`, its version, its checksum, its page, its rectangle and the passage it quotes; the
//     excluded record's markup is NOT there — asserted by its own annotation id, its version, its checksum
//     and its record's title, not by a count;
//   * the excluded annotation is not dropped either: it is named in the block AND in the receipt with the
//     reason the alignment produced (`reference-not-in-export-range`);
//   * the byte-level red line is re-measured here as well: the included PDF is found on disk BY ITS DIGEST,
//     hashed before the export and again after, and the two digests must be equal. The citation block is
//     text appended to a text file; nothing may touch the PDFs it describes.

test.setTimeout(420_000)

const REGION_PROMPT = 'Create a region drawing PDF.'
const ANNOTATED_PROMPT = 'Create an annotated PDF fixture.'
const PROJECT_NAME = 'Screening export citations acceptance project'
const COLLECTION_NAME = 'Screen hits'
const INCLUDED_TITLE = 'Adults with a measured primary endpoint'
const EXCLUDED_TITLE = 'Please exclude me: a systematic review'
// The passage the ANNOTATED fixture marks itself, which the import reads out of the file's own markup.
const IMPORTED_QUOTE = 'Figure 1. Measured response'

/** Where the raw readings are archived, when one is asked for. A CI run leaves no trace behind it. */
const EVIDENCE_DIR = process.env.PURESCIENCE_EVIDENCE_DIR

type AnchorRequest = {
  projectId: string
  sessionId: string
  artifactId: string
  versionId: string
}

type AnnotationView = {
  annotation: {
    id: string
    kind: string
    versionId: string
    checksum: string
    selector: { shape?: string; page?: number; quote?: string; rects?: unknown[] }
  }
}

type ListResult = {
  anchor: { sourceFileId: string; versionId: string; checksum: string }
  annotations: AnnotationView[]
  counts: { current: number; versionChanged: number; checksumMismatch: number }
}

const sha256OfFile = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(new Uint8Array(await readFile(path)))
    .digest('hex')

/** Every file under a root whose name ends in `.pdf`, however deep the layout nests them. */
const pdfFilesUnder = async (root: string): Promise<string[]> => {
  const found: string[] = []
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(path, depth + 1)
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) found.push(path)
    }
  }
  await walk(root, 0)
  return found
}

/** The version, the artifact and the session the fixture's own receipt names for one PDF. */
const receiptIdentity = (
  receipt: string,
  label: string
): { sessionId: string; artifactId: string; versionId: string } => {
  const match = receipt.match(
    new RegExp(`^${label} for session ([^,]+), artifact ([^,]+), version ([^.]+)\\.$`)
  )
  if (!match) throw new Error(`Invalid ${label} receipt: ${receipt}`)
  const [, sessionId, artifactId, versionId] = match
  return { sessionId: sessionId!, artifactId: artifactId!, versionId: versionId! }
}

/**
 * One receipt's text, once it has stopped moving.
 *
 * Read by polling rather than once: the assistant's message is streamed, so a paragraph can be replaced
 * between the moment a locator resolves and the moment its text is read — which is how a receipt that is
 * plainly on screen comes back as an empty string.
 */
const receiptOf = async (page: Page, label: string): Promise<string> => {
  let text = ''
  await expect
    .poll(
      async () => {
        text =
          (await page
            .getByText(new RegExp(`^${label} for session `))
            .first()
            .textContent()) ?? ''
        return new RegExp(`^${label} for session .+, artifact .+, version .+\\.$`).test(text.trim())
      },
      { timeout: 30_000, message: `the ${label} receipt never became readable` }
    )
    .toBe(true)
  return text.trim()
}

const readAnnotations = (page: Page, request: AnchorRequest): Promise<ListResult> =>
  page.evaluate(
    async (anchorRequest) =>
      (
        globalThis as unknown as {
          api: { pdfAnnotations: { list: (input: AnchorRequest) => Promise<ListResult> } }
        }
      ).api.pdfAnnotations.list(anchorRequest),
    request
  )

/** The annotations of one file version once the app has recorded them (a write is a round trip). */
const annotationsEventually = async (
  page: Page,
  request: AnchorRequest,
  expected: number
): Promise<AnnotationView[]> => {
  let annotations: AnnotationView[] = []
  await expect
    .poll(
      async () => {
        annotations = (await readAnnotations(page, request)).annotations
        return annotations.length
      },
      { timeout: 30_000, message: 'the app never recorded the annotation this run made' }
    )
    .toBe(expected)
  return annotations
}

const ensureAnnotationPanel = async (page: Page): Promise<void> => {
  const panel = page.getByTestId('pdf-annotation-panel')
  if (await panel.isVisible().catch(() => false)) return
  await page.locator('[data-slot="pdf-annotation-panel-toggle"]').click()
  await expect(panel).toBeVisible()
}

/**
 * The page's box once two consecutive readings agree. The pane is still finding its width when a preview
 * opens, and a box read mid-animation belongs to a layout the drag no longer lands in.
 */
const stableBox = async (
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> => {
  await expect(locator).toBeVisible()
  let previous = await locator.boundingBox()
  for (let reading = 0; reading < 25; reading += 1) {
    await new Promise((resolve) => setTimeout(resolve, 80))
    const current = await locator.boundingBox()
    const same =
      previous &&
      current &&
      Math.abs(previous.x - current.x) < 0.5 &&
      Math.abs(previous.y - current.y) < 0.5 &&
      Math.abs(previous.width - current.width) < 0.5 &&
      Math.abs(previous.height - current.height) < 0.5
    if (same) return current!
    previous = current
  }
  throw new Error('the PDF page never settled into a box to draw on')
}

const openLibrary = async (page: Page): Promise<ReturnType<Page['getByRole']>> => {
  await page.getByTestId('workspace-references-toggle').click()
  const library = page.getByRole('dialog', { name: 'Reference library' })
  await expect(library).toBeVisible()
  return library
}

const addRecord = async (library: ReturnType<Page['getByRole']>, title: string): Promise<void> => {
  const titleField = library.getByPlaceholder('Title (required)')
  if (!(await titleField.isVisible().catch(() => false))) {
    await library.getByRole('button', { name: 'Manual add' }).click()
  }
  await titleField.fill(title)
  await library.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(library.getByText(title).first()).toBeVisible()
}

/** Attaches one project PDF to one record through the library's own picker. */
const attachPdf = async (
  library: ReturnType<Page['getByRole']>,
  title: string,
  fileName: string
): Promise<void> => {
  const row = library.locator('li', { hasText: title })
  await row.hover()
  await row.getByTitle('Attach PDF').click()
  const picker = library.getByText('Choose the PDF to attach to this record')
  await expect(picker).toBeVisible()
  await library.locator('label', { hasText: fileName }).getByRole('checkbox').check()
  await library.getByRole('button', { name: /^Attach to this record \(1\)$/ }).click()
  // The row shows the attachment once the write landed; the picker closing is the app's own record of it.
  await expect(picker).toHaveCount(0)
  await expect(row.getByText(/^PDF · /)).toBeVisible()
}

test('exports the included records’ annotation citations, leaves an excluded record’s markup out by name, and rewrites no PDF', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, PROJECT_NAME)

  // --- two PDFs, produced by the app's own artifact tool -------------------------------------------------
  await sendPrompt(page, REGION_PROMPT, 'Region PDF ready for session', 120_000)
  const region = receiptIdentity(await receiptOf(page, 'Region PDF ready'), 'Region PDF ready')

  await sendPrompt(page, ANNOTATED_PROMPT, 'Annotated PDF ready for session', 120_000)
  const annotated = receiptIdentity(
    await receiptOf(page, 'Annotated PDF ready'),
    'Annotated PDF ready'
  )

  // --- the EXCLUDED record's markup: a real drag on the page (panel closed, so the toolbar is reachable) --
  await page.getByRole('button', { name: 'Preview generated file region-evidence.pdf' }).click()
  await page.locator('[data-slot="pdf-annotation-mode-area"]').click()
  const overlay = page.locator('[data-slot="pdf-region-overlay"]').first()
  const box = await stableBox(overlay)
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByTestId('pdf-annotation-status')).toHaveText('Annotation saved', {
    timeout: 30_000
  })

  const regionAnchor: AnchorRequest = {
    projectId,
    sessionId: region.sessionId,
    artifactId: region.artifactId,
    versionId: region.versionId
  }
  const [excludedAnnotation] = await annotationsEventually(page, regionAnchor, 1)
  expect(excludedAnnotation!.annotation.kind).toBe('area')
  expect(excludedAnnotation!.annotation.selector.shape).toBe('area')
  expect(excludedAnnotation!.annotation.selector.page).toBe(1)
  expect(region.versionId).toBe(excludedAnnotation!.annotation.versionId)

  // --- the INCLUDED record's markup: the highlight the PDF carries, read in through the import channel ---
  await page.getByRole('button', { name: 'Preview generated file annotated-evidence.pdf' }).click()
  await ensureAnnotationPanel(page)
  await page.locator('[data-slot="pdf-annotation-import"]').click()
  const importStatus = page.getByTestId('pdf-annotation-import-status')
  await expect(importStatus).toHaveAttribute('data-status', 'imported', { timeout: 30_000 })
  await expect(importStatus).toContainText('Imported 1 of 2 annotations from this PDF')

  const annotatedAnchor: AnchorRequest = {
    projectId,
    sessionId: annotated.sessionId,
    artifactId: annotated.artifactId,
    versionId: annotated.versionId
  }
  const [includedAnnotation] = await annotationsEventually(page, annotatedAnchor, 1)
  expect(includedAnnotation!.annotation.kind).toBe('highlight')
  expect(includedAnnotation!.annotation.selector).toMatchObject({
    shape: 'text-range',
    page: 1,
    quote: IMPORTED_QUOTE
  })
  const includedRects = includedAnnotation!.annotation.selector.rects ?? []
  expect(includedRects).toHaveLength(1)
  // The rectangle the citation must print, in the shared formatter's own three-decimal form.
  const firstRect = includedRects[0] as { x: number; y: number; width: number; height: number }
  const printedRect = `${firstRect.x.toFixed(3)} ${firstRect.y.toFixed(3)} ${firstRect.width.toFixed(3)} ${firstRect.height.toFixed(3)}`

  // --- both PDFs attached to their own record, both records in one collection ----------------------------
  const library = await openLibrary(page)
  await addRecord(library, INCLUDED_TITLE)
  await addRecord(library, EXCLUDED_TITLE)
  await attachPdf(library, INCLUDED_TITLE, 'annotated-evidence.pdf')
  await attachPdf(library, EXCLUDED_TITLE, 'region-evidence.pdf')

  const nameField = library.getByPlaceholder('New collection…')
  await nameField.fill(COLLECTION_NAME)
  await nameField.press('Enter')
  const collectionRow = library.getByRole('button', { name: COLLECTION_NAME, exact: true })
  await expect(collectionRow).toBeVisible()
  for (const title of [INCLUDED_TITLE, EXCLUDED_TITLE]) {
    await library.locator('li', { hasText: title }).locator('select').selectOption({
      label: COLLECTION_NAME
    })
  }
  await collectionRow.click()

  // --- a real pass, then one human decision in each direction -------------------------------------------
  await library.getByRole('button', { name: 'Screening', exact: true }).click()
  const panel = library.getByTestId('screening-panel')
  await expect(panel).toBeVisible()

  await panel.getByRole('button', { name: 'Add inclusion criterion' }).click()
  await panel.getByLabel('Inclusion criteria · Criterion ID', { exact: true }).fill('i-1')
  await panel
    .getByLabel('Inclusion criteria · Criterion', { exact: true })
    .fill('Adults with a measured primary endpoint')
  await panel.getByRole('button', { name: 'Add exclusion criterion' }).click()
  await panel.getByLabel('Exclusion criteria · Criterion ID', { exact: true }).fill('e-1')
  await panel
    .getByLabel('Exclusion criteria · Criterion', { exact: true })
    .fill('Systematic reviews and editorials')
  await panel.getByRole('button', { name: 'Save as new revision' }).click()
  await expect(library.getByText('Saved as revision 1.')).toBeVisible()

  await panel.getByRole('button', { name: 'Screen collection' }).click()
  await expect(panel.getByText(/AI decisions 2 · human overrides 0/)).toBeVisible({
    timeout: 90_000
  })

  // Both records carry a PDF, so the pass had full text to read and its answers stood: one record is
  // included on the criterion it cites, the other excluded on the counter-evidence it cites. The range the
  // export will use is stated on screen before the button is pressed.
  const includedRow = panel.locator('[data-testid="screening-row"]', { hasText: INCLUDED_TITLE })
  const excludedRow = panel.locator('[data-testid="screening-row"]', { hasText: EXCLUDED_TITLE })
  await expect(includedRow).toHaveAttribute('data-effective', 'included')
  await expect(excludedRow).toHaveAttribute('data-effective', 'excluded')
  await expect(panel.getByTestId('screening-export-preview')).toContainText(
    'Will export 1 · not exported 1 (needs review 0 · excluded 1 · not evaluated 0)'
  )

  // --- the byte-level red line, measured BEFORE the export writes anything -------------------------------
  const candidates = await pdfFilesUnder(app.storageRoot)
  const includedPaths: string[] = []
  for (const path of candidates) {
    if ((await sha256OfFile(path)) === includedAnnotation!.annotation.checksum)
      includedPaths.push(path)
  }
  expect(
    includedPaths.length,
    'the annotated file version should exist as a managed file on disk'
  ).toBeGreaterThan(0)
  const digestsBefore = await Promise.all(includedPaths.map(sha256OfFile))

  // --- press it: a real file on disk, read back and asserted from its own bytes --------------------------
  const root = await app.createTestDirectory('screening-export-citations')
  const target = join(root, 'screening-export.txt')
  await app.stubSaveDialog(target)
  await panel.getByRole('button', { name: 'Export included' }).click()

  const receipt = panel.getByTestId('screening-export-receipt')
  await expect(receipt).toBeVisible()
  // The evidence side of the receipt: one citation from the one exported record, one annotation left out,
  // and the reason it stayed out — named, not counted into a total.
  await expect(panel.getByTestId('screening-export-receipt-citations')).toContainText(
    'Annotations cited 1 · records with evidence 1 of 1 · left out 1'
  )
  await expect(panel.getByTestId('screening-export-receipt-citation-reasons')).toContainText(
    'its record is not in the export range: 1'
  )
  await expect(panel.getByTestId('screening-export-receipt-path')).toContainText(
    `Saved to ${target}.`
  )

  // The file really is there, and the export rewrote nothing it describes.
  expect((await stat(target)).size).toBeGreaterThan(0)
  const exported = await readFile(target, 'utf8')
  const digestsAfter = await Promise.all(includedPaths.map(sha256OfFile))
  expect(digestsAfter).toEqual(digestsBefore)

  // ① the bibliography is unchanged: one `[1] …` line for the one included record, above the blank line.
  const separator = exported.indexOf('\n\n')
  expect(separator).toBeGreaterThan(0)
  const bibliography = exported.slice(0, separator).split('\n')
  expect(bibliography).toHaveLength(1)
  expect(bibliography[0]).toMatch(/^\[1\] /)
  expect(bibliography[0]).toContain(INCLUDED_TITLE)
  expect(bibliography[0]).not.toContain(EXCLUDED_TITLE)

  // ② the evidence block, read back off the disk: the SAME number, then the citation's own facts.
  const block = exported.slice(separator + 2)
  const numberedLine = block.split('\n').find((line) => line.startsWith('[1] ')) ?? ''
  expect(numberedLine).toContain(INCLUDED_TITLE)
  expect(bibliography[0]).toBe(numberedLine)
  expect(block).toContain(`Evidence annotation: ${includedAnnotation!.annotation.id} (highlight)`)
  expect(block).toContain(`File: ${annotated.artifactId}`)
  expect(block).toContain(`Version: ${annotated.versionId}`)
  expect(block).toContain(`Checksum: sha256:${includedAnnotation!.annotation.checksum}`)
  expect(block).toContain('Anchor: current')
  expect(block).toContain('Page: 1')
  expect(block).toContain(`Region 1: ${printedRect}`)
  expect(block).toContain(`Quoted passage: ${IMPORTED_QUOTE}`)
  expect(block).toContain('Annotations cited 1 · records with evidence 1 of 1')

  // ③ the excluded record's markup is NOT in the file — by its own id, version, checksum, artifact and title.
  expect(exported).not.toContain(EXCLUDED_TITLE)
  expect(exported).not.toContain(region.artifactId)
  expect(exported).not.toContain(region.versionId)
  expect(exported).not.toContain(excludedAnnotation!.annotation.checksum)
  // Its id appears exactly once — in the left-out line, never under an evidence heading.
  expect(exported.split(excludedAnnotation!.annotation.id)).toHaveLength(2)
  expect(block).toContain('Annotations left out: 1')
  expect(block).toContain(
    `  ${excludedAnnotation!.annotation.id}: its record is not in the export range`
  )
  expect(block).not.toContain(`Evidence annotation: ${excludedAnnotation!.annotation.id}`)

  // ④ the range is still the effective verdicts: the model's own answer did not decide what left the window.
  await expect(panel.getByTestId('screening-export-receipt-summary')).toContainText(
    'Exported 1 included citations in GB/T 7714-2015 (numeric) · scope included only.'
  )

  // The raw readings this acceptance is archived from. Written only when asked for, so a CI run leaves no
  // trace behind it.
  if (EVIDENCE_DIR) {
    await mkdir(EVIDENCE_DIR, { recursive: true })
    await writeFile(
      join(EVIDENCE_DIR, '2026-09-30-screening-export-citations.txt'),
      [
        `collected-at: ${new Date().toISOString()}`,
        `project: ${projectId}`,
        `included record: ${INCLUDED_TITLE} (file ${annotated.artifactId}, version ${annotated.versionId})`,
        `excluded record: ${EXCLUDED_TITLE} (file ${region.artifactId}, version ${region.versionId})`,
        '',
        'the included record’s annotation (imported from the PDF’s own markup):',
        `  id: ${includedAnnotation!.annotation.id}`,
        `  kind: ${includedAnnotation!.annotation.kind}`,
        `  quote: ${JSON.stringify(IMPORTED_QUOTE)}`,
        `  checksum: sha256:${includedAnnotation!.annotation.checksum}`,
        `  region 1: ${printedRect}`,
        '',
        'the excluded record’s annotation (drawn on the page):',
        `  id: ${excludedAnnotation!.annotation.id}`,
        `  kind: ${excludedAnnotation!.annotation.kind}`,
        `  checksum: sha256:${excludedAnnotation!.annotation.checksum}`,
        '',
        'the byte-level red line (the PDF the export describes):',
        ...includedPaths.map(
          (path, index) => `  ${path}: ${digestsBefore[index]} (after: ${digestsAfter[index]})`
        ),
        '',
        'the exported file verbatim:',
        exported.trimEnd(),
        ''
      ].join('\n')
    )
  }
})
