import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './helpers'

// Acceptance for the annotation layer (文档标注层 A3) on a real window, over the real IPC surface and a real
// project database.
//
// What it walks, and why each step is here:
//
//   * an annotation is drawn on a REAL PDF the fixture agent wrote through the app's own artifact tool,
//     and stored through the window's own surface — so the anchor below is the product's, not the test's;
//   * the anchor is read back OUT of the app: the panel's own data attributes carry the version and the
//     checksum the version authority resolved, and `pdfAnnotations.list` is then asked for that version.
//     A checksum the window typed would not match what the store holds;
//   * the annotation survives an Electron RELAUNCH — the file version it belongs to outlives the session,
//     so the second launch lists the same annotation id and still paints it on the page;
//   * deleting it really removes it, and says so;
//   * the import path runs against a PDF that carries its own markup: imported 1 of 2, the one kind this
//     build cannot place named with its reason and count, the same payload imported twice reads nothing
//     again, and a file that carries no annotations says exactly that.

test.setTimeout(240_000)

const REGION_PROMPT = 'Create a region drawing PDF.'
const ANNOTATED_PROMPT = 'Create an annotated PDF fixture.'

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
    selector: Record<string, unknown>
    body: string
  }
  anchorState: string
}

type ListResult = {
  anchor: { sourceFileId: string; versionId: string; checksum: string }
  annotations: AnnotationView[]
  counts: { current: number; versionChanged: number; checksumMismatch: number }
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

/**
 * The version and checksum the app resolved for the version on screen, read off the panel itself.
 *
 * Tolerant of the panel being closed, because it is: a second version of the file replacing the one on
 * screen remounts the preview pane, and the panel starts closed again. While polling, "nothing to read
 * yet" is a transient state rather than a failure.
 */
const readResolvedAnchorIfOpen = async (
  page: Page
): Promise<{ versionId: string; checksum: string } | undefined> => {
  const counts = page.getByTestId('pdf-annotation-counts')
  if ((await counts.count()) === 0) return undefined
  const versionId = await counts.getAttribute('data-anchor-version')
  const checksum = await counts.getAttribute('data-anchor-checksum')
  return versionId && checksum ? { versionId, checksum } : undefined
}

const readResolvedAnchor = async (page: Page): Promise<{ versionId: string; checksum: string }> => {
  const resolved = await readResolvedAnchorIfOpen(page)
  if (!resolved) throw new Error('the panel did not name the version it is showing')
  return resolved
}

/**
 * Opens the panel if it is not open already.
 *
 * Conditional on purpose: switching the previewed file keeps the pane mounted, so the panel can still be
 * open from an earlier step — and a blind toggle would close it.
 */
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

test('keeps a drawn annotation on its own file version, across an Electron relaunch', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'PDF annotation evidence')
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

  // A slow runner can take well over the default 5s for the draw -> persist -> status round trip; the
  // assertion itself is unchanged, only the wait is explicit (measured: this step timed out on a macos
  // runner while passing in 10s locally).
  await expect(page.getByTestId('pdf-annotation-status')).toHaveText('Annotation saved', {
    timeout: 30_000
  })

  // 列表可见: it is listed, anchored to the version on screen, and painted on the page it was drawn on.
  const item = page.getByTestId('pdf-annotation-item')
  await expect(item).toHaveCount(1)
  await expect(item).toHaveAttribute('data-kind', 'area')
  await expect(item).toHaveAttribute('data-anchor-state', 'current')
  await expect(page.locator('[data-slot="pdf-annotation-mark"]')).toHaveCount(1)

  const resolved = await readResolvedAnchor(page)
  expect(resolved.checksum).toMatch(/^[0-9a-f]{64}$/)

  const anchorRequest: AnchorRequest = {
    projectId,
    sessionId,
    artifactId,
    versionId: resolved.versionId
  }
  const stored = await readAnnotations(page, anchorRequest)
  expect(stored.anchor.checksum).toBe(resolved.checksum)
  expect(stored.counts).toEqual({ current: 1, versionChanged: 0, checksumMismatch: 0 })
  const drawn = stored.annotations[0]!
  expect(drawn.anchorState).toBe('current')
  expect(drawn.annotation.kind).toBe('area')
  expect(drawn.annotation.versionId).toBe(resolved.versionId)
  const rect = drawn.annotation.selector.rect as {
    x: number
    y: number
    width: number
    height: number
  }
  expect(rect.width).toBeGreaterThan(0.3)
  expect(rect.height).toBeGreaterThan(0.2)

  // 重启后仍在: the anchor is the file VERSION, so a relaunch does not lose it.
  page = await app.restart()
  await openRecentSession(page, REGION_PROMPT)
  await openAnnotationPanel(page, 'region-evidence.pdf')

  const afterRelaunch = page.getByTestId('pdf-annotation-item')
  await expect(afterRelaunch).toHaveCount(1)
  await expect(afterRelaunch).toHaveAttribute('data-anchor-state', 'current')
  await expect(page.locator('[data-slot="pdf-annotation-mark"]')).toHaveCount(1)

  const resolvedAgain = await readResolvedAnchor(page)
  const reread = await readAnnotations(page, {
    ...anchorRequest,
    versionId: resolvedAgain.versionId
  })
  expect(reread.annotations.map((view) => view.annotation.id)).toEqual([drawn.annotation.id])
  expect(reread.anchor.checksum).toBe(resolvedAgain.checksum)

  // 能删除: and the deletion is reported, not assumed.
  await page.getByTestId('pdf-annotation-delete').first().click()
  await expect(page.getByTestId('pdf-annotation-status')).toHaveText('Annotation deleted', {
    timeout: 30_000
  })
  await expect(page.getByTestId('pdf-annotation-empty')).toBeVisible()
  expect((await readAnnotations(page, anchorRequest)).annotations).toHaveLength(0)
})

test('imports the markup a PDF carries, names what it skipped, and never claims an import that wrote nothing', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'PDF annotation import evidence')
  await sendPrompt(page, ANNOTATED_PROMPT, 'Annotated PDF ready for session', 90_000)
  await sendPrompt(page, REGION_PROMPT, 'Region PDF ready for session', 90_000)

  const receipt = await page.getByText(/^Annotated PDF ready for session /).innerText()
  const { sessionId, artifactId } = receiptIdentity(receipt, 'Annotated PDF ready')

  await openAnnotationPanel(page, 'annotated-evidence.pdf')
  await page.locator('[data-slot="pdf-annotation-import"]').click()

  // 导入 N 条 / 跳过 M 条并列出原因类别与计数: the report is the import's own.
  const status = page.getByTestId('pdf-annotation-import-status')
  await expect(status).toHaveAttribute('data-status', 'imported')
  // The report lines live inside the status block, so the count line is asserted as content, not as the
  // block's whole text.
  await expect(status).toContainText('Imported 1 of 2 annotations from this PDF')
  await expect(page.getByTestId('pdf-annotation-import-kinds')).toHaveText('Highlight ×1')
  await expect(page.getByTestId('pdf-annotation-import-skipped-total')).toHaveText('Skipped 1')

  const skipped = page.getByTestId('pdf-annotation-import-skip')
  await expect(skipped).toHaveCount(1)
  await expect(skipped).toHaveAttribute('data-reason', 'unsupported-subtype')
  await expect(skipped).toHaveAttribute('data-count', '1')
  await expect(skipped).toHaveText('kind this build does not import: Ink ×1')

  // The imported highlight is a real annotation of this version, quoting the passage the file marked.
  const item = page.getByTestId('pdf-annotation-item')
  await expect(item).toHaveCount(1)
  await expect(item).toHaveAttribute('data-kind', 'highlight')
  await expect(item).toHaveAttribute('data-anchor-state', 'current')
  await expect(item).toContainText('Figure 1. Measured response')
  await expect(page.locator('[data-slot="pdf-annotation-mark"]')).toHaveCount(1)

  // 幂等: the same bytes imported into the same version again reads nothing a second time.
  await page.locator('[data-slot="pdf-annotation-import"]').click()
  await expect(status).toContainText(
    'These bytes were already imported on this version; nothing was read again'
  )
  await expect(page.getByTestId('pdf-annotation-item')).toHaveCount(1)

  // Read back through the window's own surface: one annotation, anchored to the version on screen, and
  // carrying the quote the file's own markup covered.
  const resolved = await readResolvedAnchor(page)
  const stored = await readAnnotations(page, {
    projectId,
    sessionId,
    artifactId,
    versionId: resolved.versionId
  })
  expect(stored.anchor.checksum).toBe(resolved.checksum)
  expect(stored.counts).toEqual({ current: 1, versionChanged: 0, checksumMismatch: 0 })
  const imported = stored.annotations[0]!
  expect(imported.annotation.kind).toBe('highlight')
  expect(imported.annotation.selector).toMatchObject({
    shape: 'text-range',
    page: 1,
    quote: 'Figure 1. Measured response'
  })

  // 无标注时明说: a PDF that carries none says so instead of reporting a silent success.
  await openAnnotationPanel(page, 'region-evidence.pdf')
  await page.locator('[data-slot="pdf-annotation-import"]').click()
  await expect(page.getByTestId('pdf-annotation-import-status')).toHaveAttribute(
    'data-status',
    'no-annotations'
  )
  await expect(page.getByTestId('pdf-annotation-import-status')).toHaveText(
    'This PDF carries no annotations'
  )
  await expect(page.getByTestId('pdf-annotation-empty')).toBeVisible()
})

test('keeps an annotation on the bytes it was drawn on when the file moves on, and re-anchors only on demand', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'PDF annotation version evidence')
  await sendPrompt(page, REGION_PROMPT, 'Region PDF ready for session', 90_000)

  const receipt = await page.getByText(/^Region PDF ready for session /).innerText()
  const { sessionId, artifactId } = receiptIdentity(receipt, 'Region PDF ready')

  await openAnnotationPanel(page, 'region-evidence.pdf')
  await page.locator('[data-slot="pdf-annotation-mode-area"]').click()
  const overlay = page.locator('[data-slot="pdf-region-overlay"]').first()
  await expect(overlay).toBeVisible()
  const box = await overlay.boundingBox()
  if (!box) throw new Error('the PDF page offers no box to draw on')
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.55, { steps: 8 })
  await page.mouse.up()
  // A slow runner can take well over the default 5s for the draw -> persist -> status round trip; the
  // assertion itself is unchanged, only the wait is explicit (measured: this step timed out on a macos
  // runner while passing in 10s locally).
  await expect(page.getByTestId('pdf-annotation-status')).toHaveText('Annotation saved', {
    timeout: 30_000
  })

  const drawnOn = await readResolvedAnchor(page)
  const bounds: AnchorRequest = {
    projectId,
    sessionId,
    artifactId,
    versionId: drawnOn.versionId
  }

  // The same file is written again: the artifact gains a second version. The reader then moves the preview
  // to that other version through the pane's OWN version control — the same control a person uses, and the
  // one that decides which version the annotation layer is addressed to.
  await sendPrompt(page, REGION_PROMPT, 'Region PDF ready for session', 90_000)
  // This turn answers with the same receipt line as the first, so the helper above cannot tell the two
  // apart: wait for THIS turn's own reply, otherwise the step below is taken against a file that still has a
  // single version — at a control that then moves nothing.
  await expect(page.getByText(/^Region PDF ready for session /)).toHaveCount(2, { timeout: 90_000 })
  await ensureAnnotationPanel(page)
  const nextVersion = page.getByRole('button', { name: 'Next Artifact version' })
  const previousVersion = page.getByRole('button', { name: 'Previous Artifact version' })
  // The control is enabled by the pane's own lineage refetch, which is a separate read from the turn's reply.
  await expect
    .poll(async () => (await nextVersion.isEnabled()) || (await previousVersion.isEnabled()), {
      timeout: 30_000
    })
    .toBe(true)
  // Stepped forward only. A preview that is already open moves onto the version the file moved on to by
  // itself, and stepping back from there would put the pane — and the layer with it — on the very bytes the
  // annotation was drawn on, which is the state this test exists to rule out.
  if (await nextVersion.isEnabled()) await nextVersion.click()

  // The layer follows the previewed version: the version this panel resolves becomes the other one.
  await expect
    .poll(async () => (await readResolvedAnchorIfOpen(page))?.versionId, { timeout: 20_000 })
    .not.toBe(drawnOn.versionId)
  await ensureAnnotationPanel(page)
  await expect(page.getByTestId('pdf-annotation-panel')).toBeVisible()

  // 具名显示: the annotation of the earlier version is LISTED and NAMED, not dropped and not repainted on
  // bytes it was never drawn on.
  const item = page.getByTestId('pdf-annotation-item')
  await expect(item).toHaveCount(1)
  await expect(item).toHaveAttribute('data-anchor-state', 'version-changed')
  const movedOn = await readResolvedAnchor(page)
  expect(movedOn.versionId).not.toBe(drawnOn.versionId)
  await expect(item).toContainText(drawnOn.versionId)
  await expect(item).toContainText('not the version on screen')
  await expect(page.getByTestId('pdf-annotation-version-notice')).toBeVisible()
  await expect(page.locator('[data-slot="pdf-annotation-mark"]')).toHaveCount(0)

  // Nothing migrated on its own: the record is still anchored to the version it was drawn on.
  const untouched = await readAnnotations(page, bounds)
  expect(untouched.counts).toEqual({ current: 1, versionChanged: 0, checksumMismatch: 0 })
  const onTheNewVersion = await readAnnotations(page, { ...bounds, versionId: movedOn.versionId })
  expect(onTheNewVersion.counts).toEqual({ current: 0, versionChanged: 1, checksumMismatch: 0 })

  // 可重锚: the one path across versions, taken by the reader on purpose.
  await page.getByTestId('pdf-annotation-reattach').click()
  await expect(page.getByTestId('pdf-annotation-status')).toHaveText(
    'Annotation re-anchored on this version',
    { timeout: 30_000 }
  )
  await expect(page.getByTestId('pdf-annotation-item')).toHaveCount(2)

  const afterReattach = await readAnnotations(page, { ...bounds, versionId: movedOn.versionId })
  expect(afterReattach.counts).toEqual({ current: 1, versionChanged: 1, checksumMismatch: 0 })
  // A copy, not a move: the file carries two annotations now, and they really are two — one still on the
  // bytes it was drawn on and one on the version it was re-anchored to. Read either version as the reference
  // and exactly one of them is current; the drawn annotation never left its own version.
  const original = await readAnnotations(page, bounds)
  expect(original.counts).toEqual({ current: 1, versionChanged: 1, checksumMismatch: 0 })
  const ids = original.annotations.map((view) => view.annotation.id)
  expect(new Set(ids).size).toBe(2)
  expect(
    original.annotations.filter((view) => view.annotation.versionId === drawnOn.versionId)
  ).toHaveLength(1)
  expect(
    original.annotations.filter((view) => view.annotation.versionId === movedOn.versionId)
  ).toHaveLength(1)
})
