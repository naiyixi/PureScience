import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for the annotation toolbar on the narrowest pane a reader can reach.
//
// Measured before this spec existed (window at the app's own minimum, 1100): the preview pane is 423px wide,
// the annotation panel is 320px against its right edge (left edge at x=776) and the toolbar sits on the
// pane's lower left (x=684.8 to 858.8). The panel used to run the pane's FULL height above a toolbar that
// sits below it in the stacking order, so the last three of its six buttons — the note tool, the region tool
// and the panel toggle — were under the panel: `elementFromPoint` at their centre returned a paragraph
// inside the panel, the mode never armed, and the reader could neither arm a tool from the toolbar nor close
// the panel from it (the X inside the panel was the only way out).
//
// What is held to account here, with the panel OPEN on that pane:
//
//   * every toolbar control answers a hit test at its own centre — the element under the point is the
//     control or a descendant of it. A press that would land on the panel instead is a press the app never
//     hears, and no other assertion in this file could tell that apart from "nothing happened";
//   * the panel is still the overlay on top: a point inside it resolves to the panel, not to the page;
//   * a mode armed FROM THE TOOLBAR really is armed — the app's own button reports it (`aria-pressed`) and
//     the app puts up the hint it shows while a marking gesture is live;
//   * the page is still annotatable with the panel open: a real press-drag-release on the band of the page
//     the panel leaves free stores an annotation, and the assertion is the app's OWN record of that write —
//     the version the panel resolved, read back through the window's own surface — not a pixel on screen;
//   * the panel closes FROM THE TOOLBAR and opens again, both states reported by the toolbar button itself.
//     That close is taken while the status line of the write above is on screen: the pane's bottom row is
//     shared by the toolbar and that line, so both are held to their own hit tests.

test.setTimeout(240_000)

const REGION_PROMPT = 'Create a region drawing PDF.'
// The app's own minimum width (src/main/windows.ts), i.e. the narrowest window a user can reach.
const NARROW_WINDOW = { width: 1100, height: 800 }

type Box = { x: number; y: number; right: number; bottom: number; width: number; height: number }

type ControlProbe = {
  slot: string
  centre: { x: number; y: number }
  /** What the app's own hit test finds at the control's centre, named for a failure message. */
  hit: string
  /** True when that point belongs to the control itself (the button or the icon inside it). */
  reachesControl: boolean
  pressed: string | null
  expanded: string | null
}

type PaneProbe = {
  pane: Box
  panel: Box
  toolbar: Box
  panelAtItsOwnCentre: string
  panelCentreIsInsidePanel: boolean
  controls: ControlProbe[]
  windowWidth: number
}

/**
 * The pane's overlay geometry and, for every toolbar control, what a press at its centre would reach.
 *
 * `elementFromPoint` is the app's own answer to "which element is under this point", which is the question
 * the defect was about: the control was on screen and visible the whole time, and the press still went to
 * the panel above it. Visibility alone would have passed.
 */
const readPane = (page: Page): Promise<PaneProbe> =>
  page.evaluate(() => {
    const round = (value: number): number => Math.round(value * 10) / 10
    const box = (element: Element | null): Box | null => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return {
        x: round(rect.x),
        y: round(rect.y),
        right: round(rect.right),
        bottom: round(rect.bottom),
        width: round(rect.width),
        height: round(rect.height)
      }
    }
    const name = (element: Element | null): string => {
      if (!element) return 'nothing'
      const slot = element.getAttribute('data-slot')
      const testId = element.getAttribute('data-testid')
      return (
        element.tagName.toLowerCase() + (slot ? `[${slot}]` : '') + (testId ? `[${testId}]` : '')
      )
    }
    const panel = document.querySelector('[data-testid="pdf-annotation-panel"]')
    const toggle = document.querySelector('[data-slot="pdf-annotation-panel-toggle"]')
    const toolbar = toggle?.parentElement ?? null
    const controls = Array.from(
      document.querySelectorAll(
        '[data-slot^="pdf-annotation-mode-"],[data-slot="pdf-region-toggle"],[data-slot="pdf-annotation-panel-toggle"]'
      )
    )
    const panelRect = panel?.getBoundingClientRect()
    const panelCentre = panelRect
      ? document.elementFromPoint(
          panelRect.x + panelRect.width / 2,
          panelRect.y + panelRect.height / 2
        )
      : null

    return {
      pane: (toolbar?.parentElement ? box(toolbar.parentElement) : null) as Box,
      panel: box(panel) as Box,
      toolbar: box(toolbar) as Box,
      panelAtItsOwnCentre: name(panelCentre),
      panelCentreIsInsidePanel: Boolean(panelCentre && panel && panel.contains(panelCentre)),
      windowWidth: window.innerWidth,
      controls: controls.map((control) => {
        const rect = control.getBoundingClientRect()
        const x = rect.x + rect.width / 2
        const y = rect.y + rect.height / 2
        const hit = document.elementFromPoint(x, y)
        return {
          slot: control.getAttribute('data-slot') ?? 'unknown',
          centre: { x: round(x), y: round(y) },
          hit: name(hit),
          reachesControl: Boolean(hit && (hit === control || control.contains(hit))),
          pressed: control.getAttribute('aria-pressed'),
          expanded: control.getAttribute('aria-expanded')
        }
      })
    }
  })

/** What is under a point of the window, named: 'overlay' is the app's own drawing surface for a page. */
const hitAt = (page: Page, x: number, y: number): Promise<string> =>
  page.evaluate(
    ([pointX, pointY]: [number, number]) => {
      const element = document.elementFromPoint(pointX, pointY) as HTMLElement | null
      if (!element) return 'nothing'
      if (element.closest('[data-slot="pdf-region-overlay"]')) return 'overlay'
      const slot = element.getAttribute('data-slot')
      const testId = element.getAttribute('data-testid')
      return (
        element.tagName.toLowerCase() + (slot ? `[${slot}]` : '') + (testId ? `[${testId}]` : '')
      )
    },
    [x, y] as [number, number]
  )

/**
 * The pane's width once two consecutive readings agree: the window's own resize propagates through the
 * panel group, and a pane read mid-resize is a layout the press would no longer land in.
 */
const settledPaneWidth = async (page: Page): Promise<number> => {
  const paneWidth = (): Promise<number> =>
    page.evaluate(() => {
      const toggle = document.querySelector('[data-slot="pdf-annotation-panel-toggle"]')
      return toggle?.parentElement?.parentElement?.clientWidth ?? 0
    })
  let previous = await paneWidth()
  for (let reading = 0; reading < 40; reading += 1) {
    await page.waitForTimeout(120)
    const current = await paneWidth()
    if (current > 0 && current === previous) return current
    previous = current
  }
  throw new Error(`the preview pane never settled into a width (last reading ${previous}px)`)
}

/**
 * Everything the pane has to hold to with the panel open, at whatever width it is — the premise of the case,
 * the panel's place in the stacking order, and a hit test at every toolbar control. Shared by the two cases
 * below so that "narrow because the window is" and "narrow because the reader pulled the divider" cannot
 * drift apart in what they assert.
 */
const expectPaneHoldsUp = (probe: PaneProbe, paneWidth: number): void => {
  // Measured rather than assumed: the pane really is too narrow for the panel (320px against its right edge)
  // and the toolbar (reaching ~174px over from the left) to sit side by side. If a later layout makes that
  // impossible, this fails to say the case is no longer narrow, rather than passing quietly. (Measured on a
  // 423px pane: the panel's left edge at x=776, the toolbar's right edge at x=858.8.)
  expect(
    probe.panel.x,
    `the pane (${paneWidth}px) is wide enough for the panel and the toolbar after all`
  ).toBeLessThan(probe.toolbar.right)

  // The panel is still the overlay ON TOP: what is under a point inside it belongs to the panel.
  expect(probe.panelCentreIsInsidePanel, `the panel is under ${probe.panelAtItsOwnCentre}`).toBe(
    true
  )

  // Every control of the toolbar answers a press at its own centre — the tools first, the panel toggle last,
  // because the panel covers from the right and would eat them in that order.
  expect(probe.controls.map((control) => control.slot)).toEqual([
    'pdf-annotation-mode-highlight',
    'pdf-annotation-mode-underline',
    'pdf-annotation-mode-area',
    'pdf-annotation-mode-page-note',
    'pdf-region-toggle',
    'pdf-annotation-panel-toggle'
  ])
  for (const control of probe.controls) {
    expect(
      control.reachesControl,
      `a press at the centre of ${control.slot} (${control.centre.x}, ${control.centre.y}) reaches ${control.hit}`
    ).toBe(true)
  }
}

test('keeps the annotation tools and the panel toggle reachable with the panel open on the narrowest pane', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'PDF annotation narrow pane')
  await sendPrompt(page, REGION_PROMPT, 'Region PDF ready for session', 90_000)

  const receipt = await page.getByText(/^Region PDF ready for session /).innerText()
  const identity = receipt.match(
    /^Region PDF ready for session ([^,]+), artifact ([^,]+), version ([^.]+)\.$/
  )
  if (!identity) throw new Error(`Invalid PDF artifact receipt: ${receipt}`)
  const [, sessionId, artifactId] = identity

  // The PDF the agent wrote through the app's own artifact tool, opened the way a reader opens it.
  await page.getByRole('button', { name: 'Preview generated file region-evidence.pdf' }).click()
  const toggle = page.locator('[data-slot="pdf-annotation-panel-toggle"]')
  const panel = page.getByTestId('pdf-annotation-panel')
  await expect(toggle).toBeVisible()

  // The narrowest window the app allows. Everything below is asserted on THIS pane.
  await app.setMainWindowSize(NARROW_WINDOW)
  const paneWidth = await settledPaneWidth(page)
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: 10_000 })
    .toBe(NARROW_WINDOW.width)

  // Open the panel from the toolbar. With the panel closed there is nothing over the toolbar, so this is the
  // reader's own first step; the assertions below are about the state it leads to.
  await toggle.click()
  await expect(panel).toBeVisible()

  const probe = await readPane(page)
  expectPaneHoldsUp(probe, paneWidth)
  // The panel's own toggle starts expanded: it is the button the reader has to be able to press twice.
  expect(
    probe.controls.find((control) => control.slot === 'pdf-annotation-panel-toggle')?.expanded
  ).toBe('true')

  // Arm a tool FROM THE TOOLBAR. The app's own button reports the mode (`aria-pressed`) and the app puts up
  // the hint it shows while a marking gesture is live — state, not an appearance.
  const areaTool = page.locator('[data-slot="pdf-annotation-mode-area"]')
  await expect(areaTool).toHaveAttribute('aria-pressed', 'false')
  await areaTool.click()
  await expect(areaTool).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('pdf-annotation-hint')).toBeVisible()

  // Annotate the page with the panel open, on the band of the page the panel leaves free (the panel covers
  // the page's right part, so the press point is checked before the button goes down).
  const overlay = page.locator('[data-slot="pdf-region-overlay"]').first()
  await expect(overlay).toBeVisible()
  const pageBox = (await overlay.boundingBox()) as Box | null
  if (!pageBox) throw new Error('the PDF page offers no box to draw on')
  const start = { x: pageBox.x + pageBox.width * 0.04, y: pageBox.y + pageBox.height * 0.2 }
  const end = { x: pageBox.x + pageBox.width * 0.2, y: pageBox.y + pageBox.height * 0.5 }
  expect(await hitAt(page, start.x, start.y), 'the press point is not the page').toBe('overlay')

  await page.mouse.move(start.x, start.y)
  await page.waitForTimeout(60)
  await page.mouse.down()
  // Live before it is released: the rubber band the app draws during a drag, with a real extent. A drag that
  // was dropped mid-gesture stores nothing and says nothing.
  const band = page.locator('[data-slot="pdf-region-rubber-band"]')
  await expect(band).toBeVisible({ timeout: 5_000 })
  await page.mouse.move(end.x, end.y, { steps: 8 })
  await page.waitForTimeout(60)
  const bandBox = await band.boundingBox()
  expect(bandBox?.width ?? 0).toBeGreaterThan(2)
  expect(bandBox?.height ?? 0).toBeGreaterThan(2)
  await page.mouse.up()

  // The write, read back out of the app: the version the panel resolved is the version the annotation names,
  // and its rectangle is a real one. This is the app's own record — the pane's status line and the panel's
  // list are appearances, and this assertion would still hold if both were painted wrong.
  const versionId = await page
    .getByTestId('pdf-annotation-counts')
    .getAttribute('data-anchor-version')
  expect(versionId, 'the panel did not name the version it is showing').toBeTruthy()
  type AnchorRequest = {
    projectId: string
    sessionId: string
    artifactId: string
    versionId: string | null
  }
  const readStored = (): Promise<{
    annotations: Array<{
      annotation: { kind: string; versionId: string; selector: Record<string, unknown> }
    }>
  }> =>
    page.evaluate(
      async (request) =>
        (
          globalThis as unknown as {
            api: { pdfAnnotations: { list: (input: AnchorRequest) => Promise<never> } }
          }
        ).api.pdfAnnotations.list(request),
      { projectId, sessionId, artifactId, versionId }
    )

  await expect
    .poll(async () => (await readStored()).annotations.length, { timeout: 30_000 })
    .toBe(1)
  const written = (await readStored()).annotations[0]!
  expect(written.annotation.kind).toBe('area')
  expect(written.annotation.versionId).toBe(versionId)
  const rect = written.annotation.selector.rect as {
    x: number
    y: number
    width: number
    height: number
  }
  expect(rect.width).toBeGreaterThan(0.1)
  expect(rect.height).toBeGreaterThan(0.2)
  // And the app reports the write it made.
  await expect(page.getByTestId('pdf-annotation-status')).toHaveText('Annotation saved')
  await expect(page.getByTestId('pdf-annotation-item')).toHaveCount(1)

  // The write put a status line up in the pane's own bottom row, beside the toolbar, so the controls are
  // held to their hit tests again WITH it on screen: a line of text eating the press instead is the same
  // defect with a different culprit (measured: the toggle was under it, on this pane, until the text
  // overlays stopped taking presses).
  const withStatus = await readPane(page)
  for (const control of withStatus.controls) {
    expect(
      control.reachesControl,
      `a press at the centre of ${control.slot} (${control.centre.x}, ${control.centre.y}) reaches ${control.hit}`
    ).toBe(true)
  }

  // Close it from the TOOLBAR — the button that was under the panel before — and open it again from the same
  // button, with the button's own state reporting each step.
  await toggle.click()
  await expect(page.getByTestId('pdf-annotation-panel')).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(page.getByTestId('pdf-annotation-panel')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
})

/**
 * Pulls the pane's own divider to the right — the reader's gesture for a narrower pane — and returns the width
 * the pane settled at. The width is read back rather than assumed: the pane's minimum is a share of the window
 * (measured: a drag of 90px takes a 423px pane to 333px) and a drag that overshoots far enough collapses the
 * pane instead of narrowing it, which this reports by name rather than as a missing element later.
 */
const pullPaneNarrower = async (page: Page, by: number): Promise<number> => {
  const handle = page.locator('[aria-label="Resize right panel"]')
  const box = await handle.boundingBox()
  if (!box) throw new Error('the preview pane offers no resize handle')
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + by, y, { steps: 10 })
  await page.mouse.up()
  const width = await settledPaneWidth(page)
  expect(width, 'the preview pane collapsed instead of narrowing').toBeGreaterThan(0)
  return width
}

test('holds the same ground when the reader pulls the pane narrower than the window split', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'PDF annotation narrow pane by hand')
  await sendPrompt(page, REGION_PROMPT, 'Region PDF ready for session', 90_000)
  await page.getByRole('button', { name: 'Preview generated file region-evidence.pdf' }).click()
  const toggle = page.locator('[data-slot="pdf-annotation-panel-toggle"]')
  const panel = page.getByTestId('pdf-annotation-panel')
  await expect(toggle).toBeVisible()

  await app.setMainWindowSize(NARROW_WINDOW)
  const splitWidth = await settledPaneWidth(page)

  // The panel is opened first, so the divider is pulled with the pane already in the state this case is about.
  await toggle.click()
  await expect(panel).toBeVisible()

  const narrower = await pullPaneNarrower(page, 90)
  expect(
    narrower,
    `the pane did not get narrower than the window's own ${splitWidth}px split`
  ).toBeLessThan(splitWidth)

  expectPaneHoldsUp(await readPane(page), narrower)

  // The panel still closes and opens from the toolbar on this pane, each state reported by the button itself.
  await toggle.click()
  await expect(page.getByTestId('pdf-annotation-panel')).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(page.getByTestId('pdf-annotation-panel')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
})
