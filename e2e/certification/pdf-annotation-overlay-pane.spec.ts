import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test, type ElectronApp } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for the COVER layout (#16, decided): on a pane too narrow to hold the annotation panel beside
// the page, the panel is an OVERLAY on the pane's right edge — the page's own width is the pane's and never
// the pane's minus the panel's. The other half of the same decision is that the panel stays readable while
// it covers: its width is bounded by the PANE (`max-w-full`), not by a share of it, so it keeps its full
// 20rem wherever the pane allows 20rem instead of being squeezed to 85% of an already narrow pane.
//
// Measured before the panel's width bound was corrected (real app, window at the app's own minimum 1100,
// pane 423px): the page is 391px wide with the panel closed and 391px with it open — the layout never
// depended on the panel. What did depend on the pane was the panel: 320px at a 423px pane, 283.2px at a
// 333px pane the reader had pulled, i.e. the panel was being squeezed by the very pane it sits on top of.
//
// What is held to account here, with the panel OPEN on a narrow pane:
//
//   * (a) the page's width with the panel open is the width it has with the panel closed — numerically,
//       with the tolerance stated, and NOT a band left over by the panel (`pane - 20rem` would be 103px on
//       the narrowest window; a cover layout leaves 391);
//   * the panel's own width is `min(20rem, pane)`: the readable width the cover decision is for;
//   * (b) every control of the panel and of the toolbar answers a hit test at its own centre — the element
//       under the point is the control or a descendant of it. A press that would land on the other surface
//       is a press the app never hears;
//   * (c) a real press-drag-release on the band of the page the panel leaves free stores an annotation,
//       and the assertion is the app's OWN record of that write — read back through the window's own
//       surface (`api.pdfAnnotations.list`), not a pixel on screen and not the panel's list;
//   * (d) in Chinese, the densest dictionary: no horizontal overflow anywhere in the window, none in the
//       panel, and no element inside the panel sticking out of its box — the panel is not cropped copy.

test.setTimeout(240_000)

const REGION_PROMPT = 'Create a region drawing PDF.'
// The app's own minimum width (src/main/windows.ts), i.e. the narrowest window a user can reach.
const APP_MINIMUM_WINDOW_WIDTH = 1100
// A run can put the window at a width below that minimum (`PURESCIENCE_E2E_NARROW_WINDOW_WIDTH=1000`),
// which no reader can drag the window to — a window the app itself never lays out. Everything below reads
// its geometry back from the pane this window produced, so it has to hold there too: that run is the check
// that nothing here depends on the width this machine (or a CI runner) happens to give.
const NARROW_WINDOW_WIDTH = Number(
  process.env.PURESCIENCE_E2E_NARROW_WINDOW_WIDTH ?? APP_MINIMUM_WINDOW_WIDTH
)
const NARROW_WINDOW = { width: NARROW_WINDOW_WIDTH, height: 800 }
const NARROW_WINDOW_BELOW_MINIMUM = NARROW_WINDOW_WIDTH < APP_MINIMUM_WINDOW_WIDTH
const WIDE_WINDOW = { width: 1600, height: 900 }
// The panel's own reading width (`w-80`) — the width the cover layout is there to preserve.
const PANEL_WIDTH = 320
// How much of the pane the reader's pull takes off it, as a SHARE of the pane this window laid out. The
// divider follows the pointer pixel for pixel, so a share lands on a share — of a 423px pane on the window
// above, and of whatever the pane is on the machine running this. A fixed 90px was a guess at the 423:
// where the window gave a smaller pane the same pull ran to the divider's floor and left the pane wider
// than the split it was supposed to narrow.
const PULL_SHARE = 0.15

/**
 * How far the page's width may move when the panel opens.
 *
 * The page element is sized `Math.round(fitWidth * zoom)` from an integer content box at zoom 1, so an
 * overlay that takes no room leaves it identical: the measured delta is 0px on both panes this file uses.
 * 1px is the largest delta a sub-pixel rounding of the border box could produce; a panel that really took
 * room from the page would move it by its own 20rem — 320 times this budget.
 */
const PAGE_WIDTH_TOLERANCE = 1

type Box = { x: number; y: number; right: number; bottom: number; width: number; height: number }

type ControlProbe = {
  surface: 'toolbar' | 'panel'
  slot: string
  centre: { x: number; y: number }
  /** What the app's own hit test finds at the control's centre, named for a failure message. */
  hit: string
  /** True when that point belongs to the control itself (the button or the icon inside it). */
  reachesControl: boolean
}

type OverlayProbe = {
  pane: Box
  page: Box
  panel: Box
  toolbar: Box
  /** How far the page's own width exceeds the band the panel would leave it in a side-by-side layout. */
  pageWiderThanFreeBand: number
  /** Net clearance between the panel's bottom edge and the toolbar's top edge (0 or less = they touch). */
  panelToToolbarClearance: number
  panelAtItsOwnCentre: string
  panelCentreIsInsidePanel: boolean
  controls: ControlProbe[]
}

/**
 * The pane's overlay geometry and, for every control of both surfaces, what a press at its centre would
 * reach.
 *
 * `elementFromPoint` is the app's own answer to "which element is under this point": the control can be on
 * screen and visible the whole time and the press still go to the surface above it, which visibility alone
 * would never catch. A control that is scrolled out of its own surface is brought into view first (the
 * reader has to scroll to it too), so what is measured is the state a press can actually happen in.
 */
const readOverlay = (page: Page): Promise<OverlayProbe> =>
  page.evaluate(() => {
    const round = (value: number): number => Math.round(value * 10) / 10
    const toBox = (rect: DOMRect): Box => ({
      x: round(rect.x),
      y: round(rect.y),
      right: round(rect.right),
      bottom: round(rect.bottom),
      width: round(rect.width),
      height: round(rect.height)
    })
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
    const pane = toolbar?.parentElement ?? null
    const pageEl = document.querySelector('[data-page-number]')

    const toolbarControls = Array.from(
      document.querySelectorAll(
        '[data-slot^="pdf-annotation-mode-"],[data-slot="pdf-region-toggle"],[data-slot="pdf-annotation-panel-toggle"]'
      )
    )
    const panelControls = Array.from(
      document.querySelectorAll(
        '[data-slot="pdf-annotation-close"],[data-slot="pdf-annotation-import"],[data-slot="pdf-annotation-export-annotated"],[data-slot="pdf-annotation-export-notes"],[data-testid="pdf-annotation-delete"]'
      )
    )

    const panelRect = panel?.getBoundingClientRect()
    const panelCentre = panelRect
      ? document.elementFromPoint(
          panelRect.x + panelRect.width / 2,
          panelRect.y + panelRect.height / 2
        )
      : null
    const pageBox = pageEl?.getBoundingClientRect()
    const toolbarBox = toolbar?.getBoundingClientRect()
    const paneBox = pane?.getBoundingClientRect()

    const probe = (
      control: Element,
      surface: 'toolbar' | 'panel'
    ): {
      surface: 'toolbar' | 'panel'
      slot: string
      centre: { x: number; y: number }
      hit: string
      reachesControl: boolean
    } => {
      // Scrolled out of its surface: bring it into view, the way the reader would, before hit testing.
      const surfaceRect = surface === 'panel' ? panelRect : toolbarBox
      const before = control.getBoundingClientRect()
      if (surfaceRect && (before.top < surfaceRect.top || before.bottom > surfaceRect.bottom)) {
        ;(control as HTMLElement).scrollIntoView({ block: 'nearest' })
      }
      const rect = control.getBoundingClientRect()
      const x = rect.x + rect.width / 2
      const y = rect.y + rect.height / 2
      const hit = document.elementFromPoint(x, y)
      return {
        surface,
        slot: control.getAttribute('data-slot') ?? control.getAttribute('data-testid') ?? 'unknown',
        centre: { x: round(x), y: round(y) },
        hit: name(hit),
        reachesControl: Boolean(hit && (hit === control || control.contains(hit)))
      }
    }

    const freeBand = panelRect ? panelRect.x - (paneBox?.x ?? 0) : 0
    return {
      pane: toBox(paneBox as DOMRect),
      page: toBox(pageBox as DOMRect),
      panel: toBox(panelRect as DOMRect),
      toolbar: toBox(toolbarBox as DOMRect),
      pageWiderThanFreeBand: pageBox ? round(pageBox.width - freeBand) : 0,
      panelToToolbarClearance:
        panelRect && toolbarBox ? round(toolbarBox.top - panelRect.bottom) : 0,
      panelAtItsOwnCentre: name(panelCentre),
      panelCentreIsInsidePanel: Boolean(panelCentre && panel && panel.contains(panelCentre)),
      controls: [
        ...toolbarControls.map((control) => probe(control, 'toolbar')),
        ...panelControls.map((control) => probe(control, 'panel'))
      ]
    }
  }) as Promise<OverlayProbe>

/** The page's width and the pane's, read together: the page is sized from the pane's content box. */
const readWidths = (
  page: Page
): Promise<{ pageWidth: number; paneWidth: number; panelWidth: number; pageLeftOfPanel: number }> =>
  page.evaluate(() => {
    const round = (value: number): number => Math.round(value * 10) / 10
    const pageEl = document.querySelector('[data-page-number]')
    const panel = document.querySelector('[data-testid="pdf-annotation-panel"]')
    const pane = document.querySelector('[data-slot="pdf-annotation-panel-toggle"]')?.parentElement
      ?.parentElement as HTMLElement | null
    const pageRect = pageEl?.getBoundingClientRect()
    const panelRect = panel?.getBoundingClientRect()
    return {
      pageWidth: pageRect ? round(pageRect.width) : 0,
      paneWidth: pane?.clientWidth ?? 0,
      panelWidth: panelRect ? round(panelRect.width) : 0,
      pageLeftOfPanel: pageRect ? round(Math.max(0, (panelRect?.x ?? pageRect.x) - pageRect.x)) : 0
    }
  })

/** Every control of both surfaces answers a press at its own centre. */
const expectEveryControlReachable = (probe: OverlayProbe): void => {
  const toolbarSlots = probe.controls.filter((control) => control.surface === 'toolbar')
  expect(
    toolbarSlots.map((control) => control.slot),
    'the toolbar no longer offers the tools this case is about'
  ).toEqual([
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
      `a press at the centre of the ${control.surface} control ${control.slot} (${control.centre.x}, ${control.centre.y}) reaches ${control.hit}`
    ).toBe(true)
  }
  // The panel is the overlay ON TOP: what is under a point inside it belongs to the panel.
  expect(probe.panelCentreIsInsidePanel, `the panel is under ${probe.panelAtItsOwnCentre}`).toBe(
    true
  )
}

/** The cover contract, at whatever pane width the case is running on. */
const expectCoverContract = (
  probe: OverlayProbe,
  closed: { pageWidth: number; paneWidth: number },
  open: { pageWidth: number; paneWidth: number; panelWidth: number }
): void => {
  expect(closed.pageWidth, 'the page had no width to compare against').toBeGreaterThan(0)
  expect(open.paneWidth, 'the pane changed width between the two readings').toBe(closed.paneWidth)

  // (a) The page's width is the pane's, not the pane's minus the panel's. The two readings are the same
  // number: the panel is an overlay and takes no room in the flow the pages are laid out in.
  expect(
    Math.abs(open.pageWidth - closed.pageWidth),
    `the page is ${open.pageWidth}px wide with the panel open and ${closed.pageWidth}px with it closed ` +
      `(tolerance ${PAGE_WIDTH_TOLERANCE}px) on a ${open.paneWidth}px pane`
  ).toBeLessThanOrEqual(PAGE_WIDTH_TOLERANCE)

  // And in the form the defect would take: a side-by-side layout leaves the page the band left of the
  // panel (on the narrowest window: 423 - 320 = 103px). The page is far wider than that band.
  expect(
    probe.panel.x,
    `the panel (left edge ${probe.panel.x}) does not overlap the page — this pane is not the cover case`
  ).toBeLessThan(probe.page.right)
  expect(
    probe.pageWiderThanFreeBand,
    `the page (${probe.page.width}px) fits inside the band the panel leaves it ` +
      `(${probe.pageWiderThanFreeBand}px wider than that band) — the panel is not squeezing it`
  ).toBeGreaterThan(200)
  expect(
    probe.page.width,
    `the page (${probe.page.width}px) is not its own width on this pane`
  ).toBeGreaterThan(probe.pane.width - probe.panel.width)
}

/**
 * Puts the window at the width this file tests at and returns only once the renderer's own viewport reports
 * it. The window is the layout's input and the renderer is where it is measured, so the width is confirmed
 * there before anything reads a pane: a pane read before the resize reaches the renderer belongs to the
 * window that was there before it, and a slower machine reads exactly that.
 */
const setNarrowWindow = async (app: ElectronApp, page: Page): Promise<void> => {
  await app.setMainWindowSize(NARROW_WINDOW, { belowMinimum: NARROW_WINDOW_BELOW_MINIMUM })
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: 10_000 })
    .toBe(NARROW_WINDOW.width)
}

/**
 * The pane's width once three consecutive readings agree: a pane read mid-resize is a layout no press lands
 * in. Two agreeing readings were not enough — a stalled layout answers two reads 120ms apart with the width
 * it had before the resize, and everything measured from that width is measured from the wrong window.
 */
const settledPaneWidth = async (page: Page): Promise<number> => {
  let previous = (await readWidths(page)).paneWidth
  let agreements = 0
  for (let reading = 0; reading < 60; reading += 1) {
    await page.waitForTimeout(120)
    const current = (await readWidths(page)).paneWidth
    if (current > 0 && current === previous) {
      agreements += 1
      if (agreements >= 2) return current
    } else {
      agreements = 0
    }
    previous = current
  }
  throw new Error(`the preview pane never settled into a width (last reading ${previous}px)`)
}

test('covers the page instead of narrowing it, with both surfaces reachable and a real write', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'PDF annotation cover pane')
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

  // The narrowest window the app allows: the pane the cover decision is about. Its width is read back from
  // the renderer rather than assumed, so everything below measures this window's pane.
  await setNarrowWindow(app, page)
  await settledPaneWidth(page)
  const closed = await readWidths(page)
  expect(
    closed.paneWidth,
    `the pane is ${closed.paneWidth}px wide, not the narrow case`
  ).toBeLessThan(33 * 16)
  expect(panel, 'the panel was already open').toBeHidden()

  await toggle.click()
  await expect(panel).toBeVisible()
  const open = await readWidths(page)
  const probe = await readOverlay(page)

  expectCoverContract(probe, closed, open)

  // The panel's own width is `min(20rem, pane)`: what the cover decision is for. Before the bound was
  // corrected this was 85% of the pane, which is the same number at a 423px pane and 37px narrower at a
  // 333px one.
  expect(
    open.panelWidth,
    `the panel is ${open.panelWidth}px wide on a ${open.paneWidth}px pane (expected min(320, pane))`
  ).toBe(Math.min(PANEL_WIDTH, open.paneWidth))

  // (b) The panel and the toolbar, control by control.
  expectEveryControlReachable(probe)

  // The reservation from the earlier half of this issue is still in force: the panel stops ABOVE the
  // toolbar's row instead of over it.
  expect(
    probe.panelToToolbarClearance,
    `the panel's bottom (${probe.panel.bottom}) meets the toolbar (${probe.toolbar.y}) with ` +
      `${probe.panelToToolbarClearance}px between them`
  ).toBeGreaterThan(0)

  // (c) Arm a tool FROM THE TOOLBAR, then annotate the page with the panel open on the band it leaves
  // free. The app's own button reports the mode and puts up the hint it shows while a gesture is live.
  const areaTool = page.locator('[data-slot="pdf-annotation-mode-area"]')
  await expect(areaTool).toHaveAttribute('aria-pressed', 'false')
  await areaTool.click()
  await expect(areaTool).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('pdf-annotation-hint')).toBeVisible()

  const overlay = page.locator('[data-slot="pdf-region-overlay"]').first()
  await expect(overlay).toBeVisible()
  const pageBox = (await overlay.boundingBox()) as Box | null
  if (!pageBox) throw new Error('the PDF page offers no box to draw on')
  const start = { x: pageBox.x + pageBox.width * 0.04, y: pageBox.y + pageBox.height * 0.2 }
  const end = { x: pageBox.x + pageBox.width * 0.2, y: pageBox.y + pageBox.height * 0.5 }
  // The press point is the page — with the panel open over the page's right part, a point off the overlay
  // would be a gesture the app never hears, and this case would be asserting on nothing.
  expect(
    await page.evaluate(
      ([x, y]: [number, number]) => {
        const element = document.elementFromPoint(x, y)
        return element?.closest('[data-slot="pdf-region-overlay"]') ? 'overlay' : 'not-overlay'
      },
      [start.x, start.y] as [number, number]
    ),
    'the press point is not the page'
  ).toBe('overlay')

  await page.mouse.move(start.x, start.y)
  await page.waitForTimeout(60)
  await page.mouse.down()
  const band = page.locator('[data-slot="pdf-region-rubber-band"]')
  await expect(band).toBeVisible({ timeout: 5_000 })
  await page.mouse.move(end.x, end.y, { steps: 8 })
  await page.waitForTimeout(60)
  const bandBox = await band.boundingBox()
  expect(bandBox?.width ?? 0).toBeGreaterThan(2)
  expect(bandBox?.height ?? 0).toBeGreaterThan(2)
  await page.mouse.up()

  // The write, read back out of the app: the version the panel resolved is the version the annotation
  // names, and its rectangle is a real one. This is the app's own record — the pane's status line and the
  // panel's list are appearances, and this assertion would still hold if both were painted wrong.
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

  await expect.poll(async () => (await readStored()).annotations.length).toBe(1)
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
  await expect(page.getByTestId('pdf-annotation-status')).toHaveText('Annotation saved')

  // The write put a status line up in the pane's bottom row, beside the toolbar — so both surfaces are
  // held to their hit tests again WITH it on screen, and the page's width is read once more with a list
  // item and a citation rendered in the panel.
  const afterWrite = await readWidths(page)
  expect(Math.abs(afterWrite.pageWidth - closed.pageWidth)).toBeLessThanOrEqual(
    PAGE_WIDTH_TOLERANCE
  )
  expectEveryControlReachable(await readOverlay(page))

  // The reader closes the panel from the toolbar and gets the same page width back: the page never took
  // the panel's measure, in either direction.
  await toggle.click()
  await expect(panel).toBeHidden()
  const closedAgain = await readWidths(page)
  expect(
    Math.abs(closedAgain.pageWidth - closed.pageWidth),
    `the page is ${closedAgain.pageWidth}px after closing the panel and was ${closed.pageWidth}px before ` +
      `it was ever opened (tolerance ${PAGE_WIDTH_TOLERANCE}px)`
  ).toBeLessThanOrEqual(PAGE_WIDTH_TOLERANCE)

  // The wide pane is the other half of the decision: nothing about the cover change may reach it. Measured
  // before the change at a 1600 window (pane 623px): the panel was 320px wide and ran the pane's FULL
  // height. It still is, and it is still the same 320px — the old 85% bound could only bite on panes below
  // 377px, so above the threshold the two bounds are the same number.
  await app.setMainWindowSize(WIDE_WINDOW)
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: 10_000 })
    .toBe(WIDE_WINDOW.width)
  await settledPaneWidth(page)
  const wideClosed = await readWidths(page)
  expect(wideClosed.paneWidth, 'the wide pane is not wider than the threshold').toBeGreaterThan(
    33 * 16
  )
  await toggle.click()
  await expect(panel).toBeVisible()
  const wideOpen = await readWidths(page)
  const wideProbe = await readOverlay(page)
  expectCoverContract(wideProbe, wideClosed, wideOpen)
  expect(wideOpen.panelWidth, `the panel is ${wideOpen.panelWidth}px wide on a wide pane`).toBe(
    PANEL_WIDTH
  )
  // Full height here, and it may be: on this pane the panel's own edge already starts to the right of the
  // toolbar's, so the two never share a row — which is what the 33rem reservation is for.
  expect(
    Math.abs(wideProbe.panel.bottom - wideProbe.pane.bottom),
    `the panel ends at ${wideProbe.panel.bottom} on a pane that ends at ${wideProbe.pane.bottom}`
  ).toBeLessThanOrEqual(1)
  expect(
    wideProbe.panel.x,
    `the panel (left edge ${wideProbe.panel.x}) reaches into the toolbar (right edge ${wideProbe.toolbar.right}) on a wide pane`
  ).toBeGreaterThanOrEqual(wideProbe.toolbar.right)
})

/**
 * Pulls the pane's own divider to the right — the reader's gesture for a narrower pane — and returns the
 * width the pane settled at. Read back rather than assumed: the pane's minimum is a share of the window,
 * and a drag that overshoots far enough collapses the pane instead of narrowing it. Callers pass a share of
 * the pane they measured, so the pull is a delta on this window's layout and not a width of its own.
 */
const pullPaneNarrower = async (page: Page, by: number): Promise<number> => {
  const handle = page.locator('[aria-label="Resize right panel"]')
  const handleBox = await handle.boundingBox()
  if (!handleBox) throw new Error('the preview pane offers no resize handle')
  const y = handleBox.y + handleBox.height / 2
  await page.mouse.move(handleBox.x + handleBox.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(handleBox.x + handleBox.width / 2 + by, y, { steps: 10 })
  await page.mouse.up()
  const paneWidth = await settledPaneWidth(page)
  expect(paneWidth, 'the preview pane collapsed instead of narrowing').toBeGreaterThan(0)
  return paneWidth
}

test('keeps the panel readable and the page unchanged on a hand-narrowed pane, in Chinese', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'PDF annotation cover pane by hand')
  await sendPrompt(page, REGION_PROMPT, 'Region PDF ready for session', 90_000)
  await page.getByRole('button', { name: 'Preview generated file region-evidence.pdf' }).click()
  const toggle = page.locator('[data-slot="pdf-annotation-panel-toggle"]')
  const panel = page.getByTestId('pdf-annotation-panel')
  await expect(toggle).toBeVisible()

  // The pane this window actually lays out, read back from the renderer once the renderer reports the window
  // width: the width the reader's gesture is measured against is this one, not a size this file assumed.
  await setNarrowWindow(app, page)
  const split = await settledPaneWidth(page)
  await toggle.click()
  await expect(panel).toBeVisible()

  // The reader's gesture, driven from that measurement: pull the divider by a share of the pane this window
  // laid out. A fixed 90px was a guess at a 423px pane — where the window gives a smaller pane the same pull
  // ran past the divider's floor and the pane settled AT the floor, wider than the split it was meant to
  // narrow. A share of the measured split lands on the same share of whatever this window gave.
  const pulledBy = Math.round(split * PULL_SHARE)
  const narrower = await pullPaneNarrower(page, pulledBy)
  expect(
    narrower,
    `the pane did not get narrower than the window's own ${split}px split (pulled ${pulledBy}px)`
  ).toBeLessThan(split)
  expect(narrower, 'this pane is wide enough to be the cover case after all').toBeLessThan(
    (PANEL_WIDTH * 100) / 85
  )

  // The panel keeps its full reading width here: this is the pane where the old 85% bound bit (measured:
  // 283.2px at a 333px pane, i.e. 73.5% of it — a panel squeezed by the pane it covers).
  const openEn = await readWidths(page)
  expect(
    openEn.panelWidth,
    `the panel is ${openEn.panelWidth}px wide on a ${openEn.paneWidth}px pane (expected min(320, pane))`
  ).toBe(Math.min(PANEL_WIDTH, openEn.paneWidth))

  await toggle.click()
  await expect(panel).toBeHidden()
  const closedEn = await readWidths(page)
  await toggle.click()
  await expect(panel).toBeVisible()
  expectCoverContract(await readOverlay(page), closedEn, openEn)

  // (d) Chinese: the densest dictionary, chosen through the real picker.
  await page.getByRole('button', { name: 'Language' }).click()
  await page.getByRole('menuitem', { name: '简体中文' }).click()
  await expect(page.getByTestId('pdf-annotation-panel')).toBeVisible()

  const openZh = await readWidths(page)
  await toggle.click()
  await expect(page.getByTestId('pdf-annotation-panel')).toBeHidden()
  const closedZh = await readWidths(page)
  await toggle.click()
  await expect(page.getByTestId('pdf-annotation-panel')).toBeVisible()

  const zhProbe = await readOverlay(page)
  expect(
    Math.abs(zhProbe.pane.width - narrower),
    `the pane is ${zhProbe.pane.width}px wide in Chinese and was ${narrower}px in English`
  ).toBeLessThanOrEqual(1)
  expectCoverContract(zhProbe, closedZh, openZh)
  expectEveryControlReachable(zhProbe)

  // No horizontal overflow anywhere: not in the window, not in the panel, and no element inside the panel
  // sticking out of its box (a panel that scrolls sideways, or that clips its own copy, is a broken panel
  // whatever the string says).
  const overflow = await page.evaluate(() => {
    const panelEl = document.querySelector(
      '[data-testid="pdf-annotation-panel"]'
    ) as HTMLElement | null
    const rect = panelEl?.getBoundingClientRect()
    const beyond: string[] = []
    if (panelEl && rect) {
      for (const child of Array.from(panelEl.querySelectorAll('*'))) {
        const childRect = child.getBoundingClientRect()
        if (childRect.width === 0) continue
        const out = Math.round((childRect.right - rect.right) * 10) / 10
        if (out > 0.5) {
          const element = child as HTMLElement
          beyond.push(
            `${element.tagName.toLowerCase()}${element.getAttribute('data-testid') ? `[${element.getAttribute('data-testid')}]` : ''} +${out}px`
          )
        }
      }
    }
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      panelScrollWidth: panelEl?.scrollWidth ?? 0,
      panelClientWidth: panelEl?.clientWidth ?? 0,
      panelWidth: rect ? Math.round(rect.width * 10) / 10 : 0,
      beyond: beyond.slice(0, 8)
    }
  })

  expect(
    overflow.documentScrollWidth,
    `the window scrolls sideways in Chinese (${overflow.documentScrollWidth} > ${overflow.documentClientWidth})`
  ).toBeLessThanOrEqual(overflow.documentClientWidth)
  expect(
    overflow.panelScrollWidth,
    `the panel scrolls sideways in Chinese on a ${overflow.panelWidth}px panel (${overflow.panelScrollWidth} > ${overflow.panelClientWidth})`
  ).toBeLessThanOrEqual(overflow.panelClientWidth)
  expect(
    overflow.beyond,
    `elements inside the panel stick out of it in Chinese: ${overflow.beyond.join(', ')}`
  ).toEqual([])
})
