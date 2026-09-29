import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for the annotation SEARCH + CITATION slice (文档标注层 A5), on a real window, over the real
// IPC surface, a real project database and a real PDF on disk.
//
// What it walks, and why each step is here:
//
//   * a note is written the way a hand writes one: arm the note tool, click the page, type the text, save.
//     The text is a sentinel that exists nowhere else, so every assertion below is about THAT text;
//   * the panel's citation line is read off its data attributes — the version, the checksum, the page and
//     the quoted passage — and cross-checked against the anchor the version authority resolved. 「引文链能
//     看到关联标注」 is then a statement about what a reader can check, not about what the panel says;
//   * the global search is asked for the sentinel with the annotation scope alone. It must find the note,
//     and the hit must carry the SAME version and checksum the panel shows, so the citation a hit produces
//     describes the bytes the store anchored the markup to;
//   * 只读已存文本、不解析 PDF is asserted by NEGATIVE CONTROL rather than by prose: the same search is
//     also asked for a string that IS in the PDF's own text layer and was never stored as an annotation.
//     It returns nothing. Had the corpus been built by parsing the PDF, that string would have matched;
//   * the corpus is then reconciled with the store: the number of annotations the search scanned equals the
//     number the panel's own list reports for the file, so the scope searches the annotation library rather
//     than a subset of convenience;
//   * the panel's declaration that annotations never reach a model's context is asserted ON SCREEN. The
//     executable form of that red line lives beside the two paths that assemble model input
//     (src/main/acp/pdf-annotation-model-input-boundary.test.ts); what this run adds is that the reader is
//     told it on the surface they actually use.

test.setTimeout(240_000)

/** Where the raw readings are archived, when one is asked for. A CI run leaves no trace behind it. */
const EVIDENCE_DIR = process.env.PURESCIENCE_EVIDENCE_DIR

const REGION_PROMPT = 'Create a region drawing PDF.'
const PROJECT_NAME = 'PDF annotation search evidence'
// Written into the note and nowhere else in the project. Every search assertion below is about this string.
const NOTE_TEXT = 'E2E sentinel: the effect is large.'
// Text that IS in the fixture PDF's own text layer (see e2e/fixtures/fake-opencode.mjs) and was never
// stored as an annotation: the negative control for 「不解析 PDF」.
const PDF_TEXT_ONLY = 'Measured response'

type AnchorRequest = {
  projectId: string
  sessionId: string
  artifactId: string
  versionId: string
}

type SearchHit = {
  scope: string
  id: string
  title: string
  matches: Array<{ field: string; snippet: string }>
  annotation?: {
    annotationId: string
    sourceFileId: string
    versionId: string
    checksum: string
    kind: string
    page?: number
    quote?: string
  }
}

type SearchResponse = {
  hits: SearchHit[]
  counts: Record<string, number>
  scan: {
    sessions: number
    messages: number
    files: number
    references: number
    annotations: number
  }
  notes: string[]
}

type ListResult = {
  anchor: { sourceFileId: string; versionId: string; checksum: string }
  annotations: Array<{ annotation: { id: string; kind: string; body: string; versionId: string } }>
  counts: { current: number; versionChanged: number; checksumMismatch: number }
}

const search = (page: Page, request: Record<string, unknown>): Promise<SearchResponse> =>
  page.evaluate(
    async (input) =>
      (
        globalThis as unknown as {
          api: { search: { query: (value: unknown) => Promise<SearchResponse> } }
        }
      ).api.search.query(input),
    request
  )

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
  await page.locator('[data-slot="pdf-annotation-panel-toggle"]').click()
  await expect(panel).toBeVisible()
}

type PageBox = { x: number; y: number; width: number; height: number }

/**
 * What is under a point of the window, named. The only way to tell that a press never arrived: nothing
 * above a page says so, and a press that misses the overlay is silent (no status line, no error).
 */
const hitAt = (page: Page, x: number, y: number): Promise<string> =>
  page.evaluate(
    ([pointX, pointY]: [number, number]) => {
      const element = document.elementFromPoint(pointX, pointY) as HTMLElement | null
      if (!element) return 'nothing'
      if (element.closest('[data-slot="pdf-region-overlay"]')) return 'overlay'
      const slot = element.getAttribute('data-slot')
      const testId = element.getAttribute('data-testid')
      return `${element.tagName.toLowerCase()}${slot ? `[${slot}]` : ''}${testId ? `[${testId}]` : ''}`
    },
    [x, y] as [number, number]
  )

/**
 * The page's box once two consecutive readings agree. The pane is still finding its width when this runs,
 * and a box read mid-animation belongs to a layout the press no longer lands in — the press would then be
 * dropped without a word.
 */
const stablePageBox = async (page: Page): Promise<PageBox> => {
  const overlay = page.locator('[data-slot="pdf-region-overlay"]').first()
  await expect(overlay).toBeVisible()
  const sameBox = (left: PageBox | null, right: PageBox | null): boolean =>
    Boolean(
      left &&
      right &&
      Math.abs(left.x - right.x) < 0.5 &&
      Math.abs(left.y - right.y) < 0.5 &&
      Math.abs(left.width - right.width) < 0.5 &&
      Math.abs(left.height - right.height) < 0.5
    )
  let previous = await overlay.boundingBox()
  for (let reading = 0; reading < 25; reading += 1) {
    await page.waitForTimeout(80)
    const current = await overlay.boundingBox()
    if (sameBox(previous, current)) return current as PageBox
    previous = current
  }
  throw new Error('the PDF page never settled into a box to press on')
}

/**
 * The note mode really on. The app's own button says so (`aria-pressed`) and the hint it puts up while a
 * marking mode is on is visible — a click that lands while the pane is still laying itself out leaves no
 * mode behind, and an unarmed pane drops the whole press.
 */
const armNoteMode = async (page: Page): Promise<void> => {
  const mode = page.locator('[data-slot="pdf-annotation-mode-page-note"]')
  const hint = page.getByTestId('pdf-annotation-hint')
  for (let click = 0; click < 3; click += 1) {
    if ((await mode.getAttribute('aria-pressed')) === 'true') break
    await mode.click()
    await hint.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  }
  await expect(mode).toHaveAttribute('aria-pressed', 'true')
  await expect(hint).toBeVisible()
}

/**
 * A point of the page the reader can actually reach: the annotation panel floats over its right part, and a
 * press that starts there goes to the panel instead of the page.
 */
const reachablePointOn = async (page: Page, box: PageBox): Promise<{ x: number; y: number }> => {
  for (const [fractionX, fractionY] of [
    [0.25, 0.25],
    [0.15, 0.3],
    [0.35, 0.15],
    [0.45, 0.2]
  ] as ReadonlyArray<readonly [number, number]>) {
    const point = { x: box.x + box.width * fractionX, y: box.y + box.height * fractionY }
    if ((await hitAt(page, point.x, point.y)) === 'overlay') return point
  }
  throw new Error('no point of the page reaches the overlay')
}

test('finds a note through the global search, cites its file version, and reads only stored text', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, PROJECT_NAME)
  await sendPrompt(page, REGION_PROMPT, 'Region PDF ready for session', 90_000)

  const receipt = await page.getByText(/^Region PDF ready for session /).innerText()
  const { sessionId, artifactId } = receiptIdentity(receipt, 'Region PDF ready')

  await page.getByRole('button', { name: 'Preview generated file region-evidence.pdf' }).click()
  await ensureAnnotationPanel(page)
  await expect(page.getByTestId('pdf-annotation-empty')).toBeVisible()

  // --- write the note the way a hand does: arm the note tool, click the page, type, save ---------------
  await armNoteMode(page)
  const box = await stablePageBox(page)
  const point = await reachablePointOn(page, box)
  // A press that never moved: the overlay reports the point, and the pane asks for the text.
  await page.mouse.click(point.x, point.y)

  const composer = page.getByTestId('pdf-annotation-note-composer')
  await expect(composer).toBeVisible()
  await page.getByTestId('pdf-annotation-note-input').fill(NOTE_TEXT)
  await page.getByTestId('pdf-annotation-note-save').click()
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
  expect(stored.annotations[0]!.annotation.body).toBe(NOTE_TEXT)

  // --- 引文链能看到关联标注: the panel's citation carries the anchor, the page and the passage ----------
  const citation = page.getByTestId('pdf-annotation-citation')
  await expect(citation).toHaveAttribute('data-status', 'record')
  await expect(citation).toHaveAttribute('data-annotation-id', stored.annotations[0]!.annotation.id)
  await expect(citation).toHaveAttribute('data-source-file-id', artifactId)
  await expect(citation).toHaveAttribute('data-version-id', anchor.versionId)
  await expect(citation).toHaveAttribute('data-checksum', anchor.checksum)
  await expect(citation).toHaveAttribute('data-anchor-state', 'current')
  await expect(citation).toHaveAttribute('data-page', '1')
  await expect(citation).toHaveAttribute('data-rect-count', '1')
  // A page note quotes no passage; the record says so with an empty quote rather than inventing one.
  await expect(citation).toHaveAttribute('data-quote', '')
  await expect(citation).toContainText(NOTE_TEXT)
  await expect(citation).toContainText(anchor.versionId)
  await expect(citation).toContainText(`sha256:${anchor.checksum}`)

  // --- the global search finds the note, from stored text only -----------------------------------------
  const hitResponse = await search(page, {
    query: NOTE_TEXT,
    projectId,
    scopes: ['annotations']
  })

  expect(hitResponse.hits).toHaveLength(1)
  const hit = hitResponse.hits[0]!
  expect(hit.scope).toBe('annotations')
  expect(hit.title).toBe('region-evidence.pdf')
  // The match names the stored field it came from: the reader's own note, not a derived text.
  expect(hit.matches[0]!.field).toBe('body')
  expect(hit.matches[0]!.snippet).toContain(NOTE_TEXT)
  // The anchor travels with the hit, so a citation built from a search result describes the same bytes the
  // panel shows — never a re-read file.
  expect(hit.annotation).toMatchObject({
    annotationId: stored.annotations[0]!.annotation.id,
    sourceFileId: artifactId,
    versionId: anchor.versionId,
    checksum: anchor.checksum,
    kind: 'page-note',
    page: 1
  })
  expect(hit.annotation!.quote).toBeUndefined()

  // The corpus is the annotation library, not a subset of convenience: the search scanned as many
  // annotations as the panel's own list holds for this file.
  expect(hitResponse.scan.annotations).toBe(stored.annotations.length)
  // And it answered alone: nothing in the scan report is a PDF read.
  expect(hitResponse.scan.sessions).toBe(0)
  expect(hitResponse.scan.messages).toBe(0)
  expect(hitResponse.scan.references).toBe(0)

  // --- 不解析 PDF: the PDF's own text is NOT in the annotation corpus -----------------------------------
  // 'Measured response' is in the fixture PDF's text layer (the caption the fixture paints) and was never
  // stored as an annotation. A corpus built by parsing the PDF would match it; this one cannot, because it
  // never opened the file.
  const pdfTextResponse = await search(page, {
    query: PDF_TEXT_ONLY,
    projectId,
    scopes: ['annotations']
  })
  expect(pdfTextResponse.hits).toEqual([])
  // The corpus was not empty — it held this note the whole time — so the miss is about the string.
  expect(pdfTextResponse.scan.annotations).toBe(stored.annotations.length)
  expect(pdfTextResponse.notes).not.toContain('annotations-empty')

  // A phrase from the note that the PDF does not carry matches too, and still only through the stored text.
  const partial = await search(page, { query: 'sentinel', projectId, scopes: ['annotations'] })
  expect(partial.hits.map((entry) => entry.id)).toEqual([stored.annotations[0]!.annotation.id])

  // --- the scope boundary is real: another scope does not answer for it ---------------------------------
  const filesOnly = await search(page, { query: NOTE_TEXT, projectId, scopes: ['files'] })
  expect(filesOnly.counts.annotations).toBe(0)
  expect(filesOnly.hits.every((entry) => entry.scope !== 'annotations')).toBe(true)

  // --- 红线 3 said where the reader is: the panel declares the model-context policy ---------------------
  const policy = page.getByTestId('pdf-annotation-model-context-policy')
  await expect(policy).toBeVisible()
  const policyText = (await policy.innerText()).trim()
  expect(policyText.length).toBeGreaterThan(0)

  // Nothing about the search wrote anything: the store still holds exactly the one annotation, and the
  // file version it is anchored to is unchanged.
  const after = await readAnnotations(page, anchorRequest)
  expect(after.counts).toEqual({ current: 1, versionChanged: 0, checksumMismatch: 0 })
  expect(after.annotations.map((view) => view.annotation.id)).toEqual(
    stored.annotations.map((view) => view.annotation.id)
  )
  expect(after.anchor.checksum).toBe(anchor.checksum)

  // The raw readings this acceptance is archived from (see
  // docs/evidence/2026-09-29-pdf-annotation-search.md). Written only when asked for, so a CI run leaves no
  // trace behind it.
  if (EVIDENCE_DIR) {
    await mkdir(EVIDENCE_DIR, { recursive: true })
    await writeFile(
      join(EVIDENCE_DIR, '2026-09-29-pdf-annotation-search.txt'),
      [
        `collected-at: ${new Date().toISOString()}`,
        `project: ${projectId}`,
        `session: ${sessionId}`,
        `artifact: ${artifactId}`,
        '',
        'the annotation (a page note, written through the panel):',
        `  id: ${stored.annotations[0]!.annotation.id}`,
        `  kind: ${stored.annotations[0]!.annotation.kind}`,
        `  body: ${JSON.stringify(stored.annotations[0]!.annotation.body)}`,
        '',
        'the anchor the version authority resolved (also what the panel shows):',
        `  version-id: ${anchor.versionId}`,
        `  checksum: sha256:${anchor.checksum}`,
        '',
        'the citation line the panel renders (read off its data attributes):',
        `  data-status: ${await citation.getAttribute('data-status')}`,
        `  data-source-file-id: ${await citation.getAttribute('data-source-file-id')}`,
        `  data-version-id: ${await citation.getAttribute('data-version-id')}`,
        `  data-checksum: ${await citation.getAttribute('data-checksum')}`,
        `  data-anchor-state: ${await citation.getAttribute('data-anchor-state')}`,
        `  data-page: ${await citation.getAttribute('data-page')}`,
        `  data-rect-count: ${await citation.getAttribute('data-rect-count')}`,
        `  data-quote: ${JSON.stringify(await citation.getAttribute('data-quote'))}`,
        '',
        'the search, over the annotation scope alone:',
        `  query: ${JSON.stringify(NOTE_TEXT)}`,
        `  hits: ${hitResponse.hits.length}`,
        `  hit scope: ${hit.scope}`,
        `  hit title (the file the markup is on): ${hit.title}`,
        `  hit match field: ${hit.matches[0]!.field}`,
        `  hit anchor version-id: ${hit.annotation!.versionId}`,
        `  hit anchor checksum: sha256:${hit.annotation!.checksum}`,
        `  hit anchors the same bytes the panel shows: ${hit.annotation!.versionId === anchor.versionId && hit.annotation!.checksum === anchor.checksum}`,
        `  scan: sessions=${hitResponse.scan.sessions} messages=${hitResponse.scan.messages} files=${hitResponse.scan.files} references=${hitResponse.scan.references} annotations=${hitResponse.scan.annotations}`,
        `  the corpus equals the store (annotations scanned ${hitResponse.scan.annotations} vs the store holds ${stored.annotations.length}): ${hitResponse.scan.annotations === stored.annotations.length}`,
        '',
        '不解析 PDF — the negative control, and why it is one:',
        `  query: ${JSON.stringify(PDF_TEXT_ONLY)} — this string IS in the fixture PDF's own text layer`,
        `  hits: ${pdfTextResponse.hits.length}`,
        `  annotations scanned on that query: ${pdfTextResponse.scan.annotations} (a corpus built from the PDF would have matched)`,
        `  notes: ${JSON.stringify(pdfTextResponse.notes)}`,
        '',
        'the policy line the panel shows (红线 3 的界面声明):',
        `  ${JSON.stringify(policyText)}`,
        '',
        'the store after the searches (nothing written, nothing re-anchored):',
        `  counts: ${JSON.stringify(after.counts)}`,
        `  anchor unchanged: ${after.anchor.checksum === anchor.checksum}`,
        ''
      ].join('\n')
    )
  }
})
