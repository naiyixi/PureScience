import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for the three gestures that used to leave nothing behind at all (issue #16).
//
// The app answered none of them: no shape, no status line, no error. A reader who pressed the wrong
// place, clicked instead of dragging, or lost a drag when the pane re-rendered could not tell "I missed"
// from "the tool is broken" from "this file is read-only", and the only downstream evidence was a CI lane
// timing out on a status element that was never going to appear.
//
// What this spec holds the app to, on a real window, over the real annotation surface:
//
//   ① a press that reaches no page — the annotation panel floating over the page on the narrowest pane the
//     app allows (the state the issue was measured in), and the pane's own padding beside the page;
//   ② a press that never moved, which draws a region with no extent and is refused everywhere else;
//   ③ a drag that is dropped mid-gesture: the tool is taken away under it, the layer holding the pointer
//     state is replaced, and the release that ends the drag has nothing left to finish.
//
// Each one has to put up its OWN sentence in the pane's status line (the surface the layer already uses
// for "Annotation saved"), and the sentences are asserted as text: an element that appears is not
// evidence, and the three refusals must not be interchangeable. The last section draws a real region and
// reads it back out of the app, so the spec ends on the app's own record of a write — that both proves
// the ordinary gesture still works and proves none of the three refusals stored anything.
//
// The sentences are the dictionary's own (en): the same words every locale renders in its own language.
// Nothing here widens a timeout or retries to make a gesture land: a press that misses is supposed to say
// so, which is the whole point of the change.

test.setTimeout(240_000)

const REGION_PROMPT = 'Create a region drawing PDF.'
// The app's own minimum width (src/main/windows.ts), i.e. the narrowest window a user can reach — the pane
// the issue measured, where the annotation panel covers most of the page.
const NARROW_WINDOW = { width: 1100, height: 800 }

const MISSED_PRESS = 'That press was not on a page — nothing was started'
const EMPTY_GESTURE = 'No area was dragged — nothing was drawn'
const INTERRUPTED = 'The gesture was interrupted — nothing was saved; draw again'

// The pane's own controls, named once for the point searches below: a press that reaches one of them is
// the reader operating the pane, and the app must not answer it as a missed gesture.
const PANE_CONTROL_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [role="textbox"], [contenteditable="true"]'

type Box = { x: number; y: number; width: number; height: number }
type PressTarget = { x: number; y: number; hit: string }

/** What is under a point of the window, named — 'overlay' is the page's own drawing surface. */
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
 * A point that the annotation panel covers AND that is over the page: the state the issue is about, where
 * a reader aiming at the page presses the panel instead. Found by asking the window itself
 * (`elementFromPoint`) over the panel's own box, skipping anything that belongs to a control — pressing
 * the panel's controls is the reader using the panel, which is not this case.
 *
 * Returns null when no such point exists, which is reported by name rather than as a missing element
 * later: the case is only meaningful while the panel really does cover the page.
 */
const pointUnderPanelOverPage = (page: Page): Promise<PressTarget | null> =>
  page.evaluate((controls) => {
    const name = (element: Element): string => {
      const slot = element.getAttribute('data-slot')
      const testId = element.getAttribute('data-testid')
      return `${element.tagName.toLowerCase()}${slot ? `[${slot}]` : ''}${testId ? `[${testId}]` : ''}`
    }
    const panel = document.querySelector('[data-testid="pdf-annotation-panel"]')
    const pageElement = document.querySelector('[data-page-number="1"]')
    if (!panel || !pageElement) return null
    const panelBox = panel.getBoundingClientRect()
    const pageBox = pageElement.getBoundingClientRect()
    for (let y = panelBox.top + 6; y < panelBox.bottom - 6; y += 10) {
      for (let x = panelBox.left + 6; x < panelBox.right - 6; x += 10) {
        const overPage =
          x >= pageBox.left && x <= pageBox.right && y >= pageBox.top && y <= pageBox.bottom
        if (!overPage) continue
        const element = document.elementFromPoint(x, y)
        if (!element || !panel.contains(element)) continue
        if (element.closest(controls)) continue
        return { x, y, hit: name(element) }
      }
    }
    return null
  }, PANE_CONTROL_SELECTOR)

/**
 * A point INSIDE the pane that reaches no page at all: the padding the scroller keeps beside the pages.
 * The reader gets there by aiming just outside the page — the same silent path as pressing the panel,
 * with the page leaving no box under the point to normalize a drag against. Nothing but the pane's own
 * box is asked for, and every candidate is checked against `elementFromPoint` before it is used.
 */
const pointOffEveryPage = (page: Page): Promise<PressTarget | null> =>
  page.evaluate((controls) => {
    const name = (element: Element): string => {
      const slot = element.getAttribute('data-slot')
      const testId = element.getAttribute('data-testid')
      return `${element.tagName.toLowerCase()}${slot ? `[${slot}]` : ''}${testId ? `[${testId}]` : ''}`
    }
    // The previewed PDF's own scroller, named by the label it carries ('<file> scrollable preview'): a
    // bare role lookup finds the workspace's first region instead, whose box is a different panel
    // entirely — which is how a "missing" press can look like an app that ignored it.
    const scroller = document.querySelector('[role="region"][aria-label$="scrollable preview"]')
    const pane = scroller?.parentElement
    if (!pane) return null
    const box = pane.getBoundingClientRect()
    for (let y = box.top + 4; y < box.bottom - 4; y += 8) {
      for (let x = box.left + 2; x < box.right - 2; x += 8) {
        const element = document.elementFromPoint(x, y)
        if (!element) continue
        if (element.closest(controls)) continue
        if (element.closest('[data-page-number]')) continue
        if (element.closest('[data-slot="pdf-region-overlay"]')) continue
        if (element.closest('[data-testid="pdf-annotation-panel"]')) continue
        return { x, y, hit: name(element) }
      }
    }
    return null
  }, PANE_CONTROL_SELECTOR)

test('names the three gestures that used to be dropped without a word', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'PDF annotation silent paths')
  await sendPrompt(page, REGION_PROMPT, 'Region PDF ready for session', 90_000)

  const receipt = await page.getByText(/^Region PDF ready for session /).innerText()
  const identity = receipt.match(
    /^Region PDF ready for session ([^,]+), artifact ([^,]+), version ([^.]+)\.$/
  )
  if (!identity) throw new Error(`Invalid PDF artifact receipt: ${receipt}`)
  const [, sessionId, artifactId] = identity

  await page.getByRole('button', { name: 'Preview generated file region-evidence.pdf' }).click()

  // The pane the issue was measured on. Opened at the minimum width on purpose: the annotation panel is
  // 320 CSS px against the pane's right edge, and on a 423px pane it covers most of the page — which is
  // how a reader aiming at the page ends up pressing the panel.
  await app.setMainWindowSize(NARROW_WINDOW)
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: 10_000 })
    .toBe(NARROW_WINDOW.width)

  const panel = page.getByTestId('pdf-annotation-panel')
  const panelToggle = page.locator('[data-slot="pdf-annotation-panel-toggle"]')
  await expect(panelToggle).toBeVisible()
  await panelToggle.click()
  await expect(panel).toBeVisible()

  const status = page.getByTestId('pdf-annotation-status')
  const band = page.locator('[data-slot="pdf-region-rubber-band"]')
  const areaTool = page.locator('[data-slot="pdf-annotation-mode-area"]')

  // Arming a tool clears the status line (the app's own button does that). The two presses of ① use that
  // so each one starts from an empty line and the sentence an assertion reads can only be the answer to
  // THAT press; in ② and ③ the sentence asserted is a different one from the section before, so a stale
  // line cannot pass for an answer either.
  const armAreaTool = async (): Promise<void> => {
    if ((await areaTool.getAttribute('aria-pressed')) === 'true') return
    await areaTool.click()
    await expect(areaTool).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('pdf-annotation-hint')).toBeVisible()
  }

  const reachablePointOnPage = async (box: Box): Promise<{ x: number; y: number }> => {
    const candidates: ReadonlyArray<readonly [number, number]> = [
      [0.04, 0.2],
      [0.08, 0.3],
      [0.12, 0.5],
      [0.16, 0.25],
      [0.2, 0.6],
      [0.3, 0.35]
    ]
    for (const [fractionX, fractionY] of candidates) {
      const point = { x: box.x + box.width * fractionX, y: box.y + box.height * fractionY }
      if ((await hitAt(page, point.x, point.y)) === 'overlay') return point
    }
    const first = candidates[0]!
    throw new Error(
      `no point of the page reaches the overlay (under ${first[0]}/${first[1]}: ${await hitAt(
        page,
        box.x + box.width * first[0],
        box.y + box.height * first[1]
      )})`
    )
  }

  // --- ① the press reaches no page: the panel covers the point ---------------------------------------
  await armAreaTool()
  const onPanel = await pointUnderPanelOverPage(page)
  expect(
    onPanel,
    'the annotation panel covers no control-free point of the page on this pane'
  ).not.toBeNull()
  expect(onPanel!.hit, 'the point under the panel is the page itself').not.toContain('overlay')

  await page.mouse.click(onPanel!.x, onPanel!.y)
  // The reader aimed at the page; the app says which point it never heard about, instead of nothing.
  await expect(status).toHaveText(MISSED_PRESS)

  // --- ① again, aiming just outside the page: the pane's own padding ----------------------------------
  // Taken from the toolbar rather than from the keyboard, so the status line is cleared between the two
  // presses and each one has to produce the sentence by itself.
  await areaTool.click()
  await expect(areaTool).toHaveAttribute('aria-pressed', 'false')
  await armAreaTool()
  const offPage = await pointOffEveryPage(page)
  expect(offPage, 'the pane offers no point outside every page').not.toBeNull()

  await page.mouse.click(offPage!.x, offPage!.y)
  await expect(status).toHaveText(MISSED_PRESS)

  // --- ② a press that never moved: a region with no extent --------------------------------------------
  // The panel is closed from here on: the page is fully reachable and the two remaining paths are about
  // the page's own overlay, not about anything standing over it.
  await panelToggle.click()
  await expect(panel).toBeHidden()
  await armAreaTool()
  const overlay = page.locator('[data-slot="pdf-region-overlay"]').first()
  await expect(overlay).toBeVisible()
  const overlayBox = (await overlay.boundingBox()) as Box | null
  if (!overlayBox) throw new Error('the PDF page offers no box to draw on')

  const still = await reachablePointOnPage(overlayBox)
  await page.mouse.move(still.x, still.y)
  await page.mouse.down()
  await page.mouse.up()
  await expect(status).toHaveText(EMPTY_GESTURE)

  // --- ③ the drag is dropped mid-gesture: the tool is taken away under it ------------------------------
  await areaTool.click()
  await expect(areaTool).toHaveAttribute('aria-pressed', 'false')
  await armAreaTool()
  const from = await reachablePointOnPage(overlayBox)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  // Live before the tool changes: a drag the app really saw, with a real extent.
  await expect(band).toBeVisible({ timeout: 5_000 })
  await page.mouse.move(from.x + overlayBox.width * 0.25, from.y + overlayBox.height * 0.2, {
    steps: 6
  })
  const extent = await band.boundingBox()
  expect(extent?.width ?? 0).toBeGreaterThan(2)
  expect(extent?.height ?? 0).toBeGreaterThan(2)

  // The tool is taken away from the KEYBOARD, which is the one activation a reader has for a control
  // while a drag is held down: the pane re-renders, and the layer that was holding the gesture — the
  // rubber band with it — is replaced. The release that follows reaches a fresh instance whose refs are
  // empty, which is exactly the half-finished region that used to evaporate in silence.
  const highlightTool = page.locator('[data-slot="pdf-annotation-mode-highlight"]')
  await highlightTool.focus()
  await expect(
    highlightTool,
    'the tool could not take the keyboard while the drag was held'
  ).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(highlightTool).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-slot="pdf-region-overlay"]')).toHaveCount(0)
  // The shape could not be carried over (its instance is gone), so the app says what happened to it.
  await expect(band).toHaveCount(0)
  await expect(status).toHaveText(INTERRUPTED)
  await page.mouse.up()

  // --- the ordinary gesture, on the same pane: a real region, read back out of the app -----------------
  await panelToggle.click()
  await expect(panel).toBeVisible()
  await armAreaTool()
  const drawBox = (await overlay.boundingBox()) as Box | null
  if (!drawBox) throw new Error('the PDF page offers no box to draw on')
  const start = await reachablePointOnPage(drawBox)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await expect(band).toBeVisible({ timeout: 5_000 })
  await page.mouse.move(start.x + drawBox.width * 0.2, start.y + drawBox.height * 0.25, {
    steps: 8
  })
  await page.mouse.up()

  // The app reports the write, and the store is read back to prove it: exactly ONE annotation, of the
  // version on screen. None of the three refusals above stored anything, and none of them cost the
  // ordinary gesture anything.
  await expect(status).toHaveText('Annotation saved')
  const versionId = await page
    .getByTestId('pdf-annotation-counts')
    .getAttribute('data-anchor-version')
  expect(versionId, 'the panel did not name the version it is showing').toBeTruthy()

  const stored = await page.evaluate(
    async (request) =>
      (
        globalThis as unknown as {
          api: {
            pdfAnnotations: {
              list: (input: typeof request) => Promise<{
                annotations: Array<{
                  annotation: { kind: string; versionId: string; selector: Record<string, unknown> }
                }>
              }>
            }
          }
        }
      ).api.pdfAnnotations.list(request),
    { projectId, sessionId, artifactId, versionId }
  )
  expect(stored.annotations).toHaveLength(1)
  expect(stored.annotations[0]!.annotation.kind).toBe('area')
  expect(stored.annotations[0]!.annotation.versionId).toBe(versionId)
  const rect = stored.annotations[0]!.annotation.selector.rect as Box
  expect(rect.width).toBeGreaterThan(0.1)
  expect(rect.height).toBeGreaterThan(0.1)
  await expect(page.getByTestId('pdf-annotation-item')).toHaveCount(1)
})
