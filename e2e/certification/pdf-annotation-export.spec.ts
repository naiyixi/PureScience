import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for the annotation export channels (文档标注层 A4), on a real window, over the real IPC
// surface, a real project database and REAL files on disk.
//
// What it walks, and why each step is here:
//
//   * an annotation is drawn on a PDF the fixture agent wrote through the app's own artifact tool, so the
//     file being exported from is a managed file of the app rather than a file the test handed it;
//   * the version's own file is found ON DISK by its content digest — every PDF under the storage root
//     whose bytes hash to the anchor the app resolved — and hashed BEFORE either channel runs. That is
//     what makes the red line checkable from outside the app rather than from the app's own word;
//   * channel ① (annotated copy) is triggered on its own: the file it wrote is read back, and asserted to
//     be the version's bytes with an update appended — the source's bytes are the first bytes of the copy,
//     and the copy carries markup the source does not;
//   * channel ② (notes) is then triggered on its own, writing a list and NO PDF: the receipt says so, the
//     directory holds no extra PDF, and the copy channel 1 left behind is byte-for-byte unchanged;
//   * after both channels the version's file is hashed AGAIN and must be the same digest. Nothing in the
//     two paths is allowed to have written it;
//   * the notes list is cross-checked against the store: the number of entries it lists equals what
//     `pdfAnnotations.list` answers for that version, and each entry names its kind, page and version.

test.setTimeout(240_000)

const REGION_PROMPT = 'Create a region drawing PDF.'
const PROJECT_NAME = 'PDF annotation export evidence'

/** Where the byte-level readings are archived, when one is asked for. */
const EVIDENCE_DIR = process.env.PURESCIENCE_EVIDENCE_DIR

type AnchorRequest = {
  projectId: string
  sessionId: string
  artifactId: string
  versionId: string
}

type ListResult = {
  anchor: { sourceFileId: string; versionId: string; checksum: string }
  annotations: Array<{
    annotation: { id: string; kind: string; versionId: string; checksum: string }
  }>
  counts: { current: number; versionChanged: number; checksumMismatch: number }
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const sha256OfFile = async (path: string): Promise<string> =>
  sha256Hex(new Uint8Array(await readFile(path)))

const readBytes = async (path: string): Promise<Uint8Array> => new Uint8Array(await readFile(path))

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

const receiptIdentity = (
  receipt: string,
  label: string
): { sessionId: string; artifactId: string } => {
  const match = receipt.match(
    new RegExp(`^${label} for session ([^,]+), artifact ([^,]+), version ([^.]+)\\.$`)
  )
  if (!match) throw new Error(`Invalid ${label} receipt: ${receipt}`)
  const [, sessionId, artifactId] = match
  return { sessionId: sessionId!, artifactId: artifactId! }
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

const readResolvedAnchor = async (page: Page): Promise<{ versionId: string; checksum: string }> => {
  const counts = page.getByTestId('pdf-annotation-counts')
  await expect(counts).toBeVisible()
  const versionId = await counts.getAttribute('data-anchor-version')
  const checksum = await counts.getAttribute('data-anchor-checksum')
  if (!versionId || !checksum) throw new Error('the panel did not name the version it is showing')
  return { versionId, checksum }
}

const ensureAnnotationPanel = async (page: Page): Promise<void> => {
  const panel = page.getByTestId('pdf-annotation-panel')
  if (await panel.isVisible().catch(() => false)) return
  const toggle = page.locator('[data-slot="pdf-annotation-panel-toggle"]')
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(panel).toBeVisible()
}

const openAnnotationPanel = async (page: Page, fileName: string): Promise<void> => {
  await page.getByRole('button', { name: `Preview generated file ${fileName}` }).click()
  await ensureAnnotationPanel(page)
}

test('writes an annotated copy and a notes list, and never touches the version it exports from', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, PROJECT_NAME)
  await sendPrompt(page, REGION_PROMPT, 'Region PDF ready for session', 90_000)

  const receipt = await page.getByText(/^Region PDF ready for session /).innerText()
  const { sessionId, artifactId } = receiptIdentity(receipt, 'Region PDF ready')

  await openAnnotationPanel(page, 'region-evidence.pdf')
  await expect(page.getByTestId('pdf-annotation-empty')).toBeVisible()

  // Draw the way a hand does: arm the region tool, then press, move and release on the page.
  await page.locator('[data-slot="pdf-annotation-mode-area"]').click()
  const overlay = page.locator('[data-slot="pdf-region-overlay"]').first()
  await expect(overlay).toBeVisible()
  const box = await overlay.boundingBox()
  if (!box) throw new Error('the PDF page offers no box to draw on')
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByTestId('pdf-annotation-status')).toHaveText('Annotation saved', {
    timeout: 30_000
  })

  const anchor = await readResolvedAnchor(page)
  const anchorRequest: AnchorRequest = {
    projectId,
    sessionId,
    artifactId,
    versionId: anchor.versionId
  }
  const stored = await readAnnotations(page, anchorRequest)
  expect(stored.anchor.checksum).toBe(anchor.checksum)
  expect(stored.counts.current).toBe(1)

  // --- the version's own file, on disk, BEFORE either channel ran -----------------------------------
  const candidates = await pdfFilesUnder(app.storageRoot)
  const sourcePaths: string[] = []
  for (const path of candidates) {
    if ((await sha256OfFile(path)) === anchor.checksum) sourcePaths.push(path)
  }
  expect(
    sourcePaths.length,
    'the exported version should exist as a managed file on disk'
  ).toBeGreaterThan(0)
  const sourceSizes = await Promise.all(sourcePaths.map(async (path) => (await stat(path)).size))
  const digestsBefore = await Promise.all(sourcePaths.map(sha256OfFile))

  // --- channel ①: the annotated copy ----------------------------------------------------------------
  const exportDir = await app.createTestDirectory('pdf-annotation-export')
  const copyPath = join(exportDir, 'region-evidence (annotated).pdf')
  await app.stubSaveDialog(copyPath)
  await page.locator('[data-slot="pdf-annotation-export-annotated"]').click()

  const status = page.getByTestId('pdf-annotation-export-status')
  await expect(status).toHaveAttribute('data-status', 'exported')
  await expect(status).toHaveAttribute('data-channel', 'annotated-pdf')
  await expect(status).toHaveAttribute('data-anchor-checksum', anchor.checksum)
  await expect(page.getByTestId('pdf-annotation-export-summary')).toContainText(
    'Exported 1 of 1 annotations of version'
  )
  await expect(page.getByTestId('pdf-annotation-export-summary')).toContainText(anchor.versionId)

  const copyLine = page.getByTestId('pdf-annotation-export-copy')
  await expect(copyLine).toHaveAttribute('data-path', copyPath)
  // The channel produced a copy and no list.
  await expect(page.getByTestId('pdf-annotation-export-notes')).toHaveCount(0)
  await expect(page.getByTestId('pdf-annotation-export-no-pdf')).toHaveCount(0)

  // The red line, on the surface, before the test checks it for itself: the digest the source had before
  // the copy was written and the one it had after — the same number, and the version's anchor.
  const sourceLine = page.getByTestId('pdf-annotation-export-source')
  await expect(sourceLine).toHaveAttribute('data-checksum-before', anchor.checksum)
  await expect(sourceLine).toHaveAttribute('data-checksum-after', anchor.checksum)
  await expect(sourceLine).toHaveAttribute('data-anchor-checksum', anchor.checksum)

  const copyBytes = await readBytes(copyPath)
  const sourceBytes = await readBytes(sourcePaths[0]!)
  expect(await copyLine.getAttribute('data-bytes')).toBe(String(copyBytes.length))
  expect(await copyLine.getAttribute('data-source-bytes')).toBe(String(sourceBytes.length))
  expect(Number(await copyLine.getAttribute('data-appended-bytes'))).toBeGreaterThan(0)

  // The copy IS the version's bytes with an update appended: same head, more bytes, and markup the
  // source does not carry.
  expect(copyBytes.length).toBeGreaterThan(sourceBytes.length)
  expect([...copyBytes.subarray(0, sourceBytes.length)]).toEqual([...sourceBytes])
  const copyText = new TextDecoder().decode(copyBytes)
  const sourceText = new TextDecoder().decode(sourceBytes)
  expect(copyText).toContain('/Subtype /Square')
  expect(copyText).toContain('/Annots [')
  expect(sourceText).not.toContain('/Subtype /Square')
  expect(sourceText).not.toContain('/Annots [')
  // And it really is a PDF the app appended to: the new cross-reference section chains back to the
  // file's own, which is what keeps every object the source declared readable.
  expect(copyText).toMatch(/trailer\n<< \/Size \d+ \/Root \d+ \d+ R \/Prev \d+ >>/)

  // The source file(s) on disk are byte-identical after channel ①.
  const digestsAfterCopy = await Promise.all(sourcePaths.map(sha256OfFile))
  expect(digestsAfterCopy).toEqual(digestsBefore)
  for (const [index, path] of sourcePaths.entries()) {
    expect((await stat(path)).size, `${path} changed size`).toBe(sourceSizes[index])
  }
  // Nothing else was written next to the copy: this channel produced one file.
  expect(await readdir(exportDir)).toEqual(['region-evidence (annotated).pdf'])

  // --- channel ②: the notes list, triggered on its own ----------------------------------------------
  const notesPath = join(exportDir, 'region-evidence (annotations).txt')
  await app.stubSaveDialog(notesPath)
  await page.locator('[data-slot="pdf-annotation-export-notes"]').click()

  await expect(status).toHaveAttribute('data-status', 'exported')
  await expect(status).toHaveAttribute('data-channel', 'notes')
  await expect(status).toHaveAttribute('data-anchor-checksum', anchor.checksum)
  // 不产生 PDF 副本: the receipt carries a list and no copy, and the panel says so in words.
  await expect(page.getByTestId('pdf-annotation-export-copy')).toHaveCount(0)
  await expect(page.getByTestId('pdf-annotation-export-no-pdf')).toHaveText(
    'This channel writes no PDF'
  )

  const notesLine = page.getByTestId('pdf-annotation-export-notes')
  await expect(notesLine).toHaveAttribute('data-path', notesPath)
  await expect(notesLine).toHaveAttribute('data-lines', String(stored.annotations.length))

  const notesBytes = await readBytes(notesPath)
  const notesText = new TextDecoder().decode(notesBytes)
  expect(Number(await notesLine.getAttribute('data-lines'))).toBeGreaterThan(0)
  expect(notesText.startsWith('%PDF-')).toBe(false)
  expect(notesText).not.toContain('/Subtype')
  expect(notesText).toContain('PureScience PDF annotation notes')
  expect(notesText).toContain(`version: ${anchor.versionId}`)
  expect(notesText).toContain(`checksum: sha256:${anchor.checksum}`)
  expect(notesText).toContain(`annotations: ${stored.annotations.length}`)
  // 条数与库内一致: one entry line per annotation the store holds, each naming its kind, page and version.
  const entryLines = notesText.split('\n').filter((line) => /^\[\d+\] /.test(line))
  expect(entryLines).toHaveLength(stored.annotations.length)
  expect(entryLines[0]).toContain('[1] area · page 1 · version ' + anchor.versionId + ' · current')

  // The notes channel wrote its own file and no PDF: the export directory holds exactly the copy from
  // channel ① plus this list, and the copy is byte-for-byte what channel ① left.
  expect((await readdir(exportDir)).sort()).toEqual([
    'region-evidence (annotated).pdf',
    'region-evidence (annotations).txt'
  ])
  expect([...copyBytes]).toEqual([...(await readBytes(copyPath))])

  // --- the red line, after BOTH channels --------------------------------------------------------------
  const digestsAfterBoth = await Promise.all(sourcePaths.map(sha256OfFile))
  expect(digestsAfterBoth).toEqual(digestsBefore)
  for (const [index, path] of sourcePaths.entries()) {
    expect(await sha256OfFile(path), `${path} was rewritten by an export`).toBe(
      digestsBefore[index]
    )
  }
  // The store did not change either: an export reads it and writes files; it writes no annotation.
  const afterExport = await readAnnotations(page, anchorRequest)
  expect(afterExport.counts).toEqual({ current: 1, versionChanged: 0, checksumMismatch: 0 })
  expect(afterExport.annotations.map((view) => view.annotation.id)).toEqual(
    stored.annotations.map((view) => view.annotation.id)
  )

  // The raw readings this acceptance is archived from (see docs/evidence/2026-09-29-pdf-annotation-
  // export.md). Written only when asked for, so a CI run leaves no trace behind it.
  if (EVIDENCE_DIR) {
    await mkdir(EVIDENCE_DIR, { recursive: true })
    const copyAfterNotes = await readBytes(copyPath)
    await writeFile(
      join(EVIDENCE_DIR, '2026-09-29-pdf-annotation-export-bytes.txt'),
      [
        `collected-at: ${new Date().toISOString()}`,
        `version-id: ${anchor.versionId}`,
        `anchor-checksum (the store's, resolved by the version authority): ${anchor.checksum}`,
        `annotations-in-store: ${stored.annotations.length}`,
        '',
        'source file(s) on disk (found by content digest under the storage root):',
        ...sourcePaths.map(
          (path, index) =>
            `  ${path}\n    bytes: ${sourceSizes[index]}\n    sha256 before any export: ${digestsBefore[index]}\n    sha256 after both channels: ${digestsAfterBoth[index]}\n    unchanged: ${digestsBefore[index] === digestsAfterBoth[index]}`
        ),
        '',
        'channel 1 - annotated copy:',
        `  path: ${copyPath}`,
        `  bytes: ${copyBytes.length}`,
        `  source bytes carried verbatim at the head: ${sourceBytes.length}`,
        `  appended bytes: ${copyBytes.length - sourceBytes.length}`,
        `  copy sha256: ${sha256Hex(copyBytes)}`,
        `  head is byte-for-byte the source: ${Buffer.from(copyBytes.subarray(0, sourceBytes.length)).equals(Buffer.from(sourceBytes))}`,
        `  copy carries "/Subtype /Square": ${copyText.includes('/Subtype /Square')}`,
        `  copy carries "/Annots [": ${copyText.includes('/Annots [')}`,
        `  source carries "/Subtype /Square": ${sourceText.includes('/Subtype /Square')}`,
        `  source carries "/Annots [": ${sourceText.includes('/Annots [')}`,
        '',
        'channel 2 - notes list:',
        `  path: ${notesPath}`,
        `  bytes: ${notesBytes.length}`,
        `  sha256: ${sha256Hex(notesBytes)}`,
        `  starts with %PDF-: ${notesText.startsWith('%PDF-')}`,
        `  entry lines: ${entryLines.length} (the store holds ${stored.annotations.length})`,
        `  carries "/Subtype": ${notesText.includes('/Subtype')}`,
        '',
        `export directory after both channels: ${(await readdir(exportDir)).sort().join(', ')}`,
        `copy unchanged by channel 2: ${sha256Hex(copyAfterNotes) === sha256Hex(copyBytes)}`,
        ''
      ].join('\n')
    )
  }
})
