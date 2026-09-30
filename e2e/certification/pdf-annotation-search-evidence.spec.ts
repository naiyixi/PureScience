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
//   * a note is written the way a hand writes one: arm the note tool, press the page, type the text, save.
//     The text is a sentinel that exists nowhere else, so every assertion below is about THAT text. The
//     tool is armed while the annotation panel is CLOSED and the panel is opened after the press: the open
//     panel floats over the toolbar on a narrow pane (measured — see `placePageNote`), and arming it from
//     behind the panel is a press the pane never hears. The press itself is checked where it could be
//     dropped, and the loop that writes the note ends on the app's own record of it, never on an attempt
//     count (see `placePageNote`);
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
  const toggle = page.locator('[data-slot="pdf-annotation-panel-toggle"]')
  await expect(toggle).toBeVisible()
  await toggle.click()
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
 *
 * Called while the annotation panel is CLOSED (see `placePageNote` for why the order is not a preference).
 * A press that is swallowed anyway is reported as what stood in the way rather than as a bare 30s timeout:
 * the overlap is the finding, the delay is not.
 */
const armNoteMode = async (page: Page): Promise<void> => {
  const mode = page.locator('[data-slot="pdf-annotation-mode-page-note"]')
  const hint = page.getByTestId('pdf-annotation-hint')
  for (let click = 0; click < 3; click += 1) {
    if ((await mode.getAttribute('aria-pressed')) === 'true') break
    await expect(mode).toBeVisible()
    const pressed = await mode
      .click({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
    await hint.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
    if (!pressed && (await mode.getAttribute('aria-pressed')) !== 'true') {
      const box = await mode.boundingBox()
      throw new Error(
        `the page-note tool is on screen but no press reaches it — the reader cannot arm it (under it: ${
          box ? await hitAt(page, box.x + box.width / 2, box.y + box.height / 2) : 'nothing'
        })`
      )
    }
  }
  await expect(mode).toHaveAttribute('aria-pressed', 'true')
  await expect(hint).toBeVisible()
}

/**
 * A point of the page the reader can actually reach: the annotation panel floats over its right part, and a
 * press that starts there goes to the panel instead of the page.
 *
 * The candidates run from the middle of the page outwards, and every one of them is checked against the
 * element the window reports under it. A pane narrow enough for the panel to reach into the toolbar also
 * leaves only a sliver of page to the left of the panel, which is what the later candidates are for.
 */
const reachablePointOn = async (page: Page, box: PageBox): Promise<{ x: number; y: number }> => {
  const candidates: ReadonlyArray<readonly [number, number]> = [
    [0.25, 0.25],
    [0.15, 0.3],
    [0.35, 0.15],
    [0.45, 0.2],
    [0.08, 0.25],
    [0.05, 0.35],
    [0.12, 0.5],
    [0.2, 0.5],
    [0.3, 0.4]
  ]
  for (const [fractionX, fractionY] of candidates) {
    const point = { x: box.x + box.width * fractionX, y: box.y + box.height * fractionY }
    if ((await hitAt(page, point.x, point.y)) === 'overlay') return point
  }
  throw new Error(
    `no point of the page reaches the overlay (under the first one: ${await hitAt(
      page,
      box.x + box.width * candidates[0]![0],
      box.y + box.height * candidates[0]![1]
    )})`
  )
}

/**
 * Puts a page note on the page in front of the reader — the placement half of writing one — and returns
 * only once the app itself has recorded it.
 *
 * A press that misses is completely silent: nothing above the page says so (no status line, no error), and
 * the reader's next press is the only thing that can make the note land. So the press is not "taken", it is
 * checked at each place it could have been dropped:
 *
 *   * the tool is armed first, and the app's own button says so — a pane that is not armed drops the whole
 *     press;
 *   * the tool is armed while the annotation panel is CLOSED, and the panel is opened after the press.
 *     That order is a measurement, not a preference: the panel is 320 CSS px wide and floats over the right
 *     part of the pane (`absolute right-0 top-0 z-20`), so on a preview pane narrower than ~433 px its left
 *     edge crosses the toolbar and the page-note button sits UNDER it. A click on it then never arrives —
 *     `subtree intercepts pointer events`, 30s, on the macos-arm64 runner; reproduced locally at a
 *     1100px-wide window (preview pane 423px wide, panel from x=776, the button at x=773-797, the element
 *     under its centre the panel's own policy line). With the panel closed nothing overlaps the toolbar,
 *     and nothing overlaps the page either;
 *   * the page's box must have stopped moving (two consecutive readings that agree): the pane animates
 *     open, and every page — and the overlay over it — is sized from a width that is still changing, so a
 *     point read mid-animation belongs to a layout the press no longer lands in;
 *   * the press must land ON the overlay, checked with `elementFromPoint` before the button goes down;
 *   * the press must be LIVE before it is released: the app mounts its rubber band on pointerdown, so a
 *     band is the one signal that survives a re-render replacing the overlay, and a press the app never
 *     saw leaves none. Without a band the button is released at once and nothing is left in flight, which
 *     is what makes the next attempt safe to make;
 *   * the loop's condition is the app's own record of the placement — the composer the app raises for a
 *     page note. Never an attempt count: while the composer is absent nothing was placed, so a retry can
 *     only ever be another press, never a second note.
 */
const placePageNote = async (page: Page): Promise<void> => {
  const composer = page.getByTestId('pdf-annotation-note-composer')
  const band = page.locator('[data-slot="pdf-region-rubber-band"]')

  // The composer is the app's own record of the placement, and it lives in the panel — so the panel is
  // opened first whenever it is not already open.
  const placed = async (): Promise<boolean> => {
    await ensureAnnotationPanel(page)
    return composer
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1 && (await placed())) return
    await armNoteMode(page)
    const box = await stablePageBox(page)
    const point = await reachablePointOn(page, box)
    await page.mouse.move(point.x, point.y)
    await page.waitForTimeout(60)
    await page.mouse.down()
    const live = await band
      .waitFor({ state: 'attached', timeout: 3_000 })
      .then(() => true)
      .catch(() => false)
    await page.mouse.up()
    // No band: the app never saw the pointerdown, so nothing can be in flight behind this press.
    if (!live) continue
    if (await placed()) return
    // A live press the app recorded nothing for: the pane can re-mount mid-gesture and take the placement
    // with it, so the reader's next press is what makes the note land.
  }

  throw new Error(
    `three presses were made on the page and the app recorded none of them (armed=${await page
      .locator('[data-slot="pdf-annotation-mode-page-note"]')
      .getAttribute('aria-pressed')}, composer=${await composer.count()}, panel=${await page
      .getByTestId('pdf-annotation-panel')
      .isVisible()
      .catch(() => false)})`
  )
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

  // --- write the note the way a hand does: arm the note tool, press the page, type, save ----------------
  // The tool is armed, and the page is pressed, while the panel is still closed; the panel is then opened
  // to write the text into the composer the app raises for the placed note. See `placePageNote` for what
  // that order is made of — on a narrow pane the open panel sits over the toolbar, and a press on the note
  // tool there never arrives.
  await placePageNote(page)

  const composer = page.getByTestId('pdf-annotation-note-composer')
  await expect(composer).toBeVisible()
  // Placing the note stored nothing: the panel still reports an empty library, so the citation read below
  // is about the note this run writes.
  await expect(page.getByTestId('pdf-annotation-empty')).toBeVisible()
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
