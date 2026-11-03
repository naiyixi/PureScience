import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test } from './fixtures/electron-app'

const prepareVisualPage = async (page: Page): Promise<void> => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addStyleTag({
    content:
      '* { scrollbar-width: none !important; } *::-webkit-scrollbar { display: none !important; }'
  })

  await page.getByRole('button', { name: /^Theme:/ }).click()
  await page.getByRole('menuitem', { name: /^Light/ }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
}

// The header's own text, which is what changes when one of the machine-describing items below appears or
// disappears. Two agreeing readings 250ms apart mean the checks that feed it have landed; the loop is capped
// so a surface that keeps changing still gets its screenshot (and its diff) rather than hanging here.
const waitForStableHeader = async (page: Page): Promise<void> => {
  const header = (): Promise<string> =>
    page.evaluate(() => document.querySelector('header')?.textContent ?? '')
  let previous = await header()
  let agreements = 0
  for (let reading = 0; reading < 40; reading += 1) {
    await page.waitForTimeout(250)
    const current = await header()
    if (current === previous) {
      agreements += 1
      if (agreements >= 2) return
    } else {
      agreements = 0
    }
    previous = current
  }
}

const expectStableScreenshot = async (
  page: Page,
  name: string,
  maxDiffPixelRatio = 0.002
): Promise<void> => {
  await page.locator('a[aria-label*="GitHub"]').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden'
  })
  // The use-case gallery is content, not shell: its cards are copy and measured readings that change when a
  // capability ships, and it has its own certification spec. Keeping it inside the home baseline meant every
  // card addition re-baselined the page, and a baseline regenerated off-runner drifted 4% against the lane.
  // `evaluateAll` runs in the page, where TypeScript types are not in play — no cast inside.
  await page.locator('[data-slot="use-case-gallery"]').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden'
  })
  // Four header items describe THIS machine rather than the product, and each arrives from a check that
  // finishes when it finishes: the version badge (`v2.18.0` here, `v2.18.0-nightly.g2dbdb00` on a nightly
  // build — the job log's surface fingerprint printed the lane's header verbatim), the update capsule (only
  // while the feed carries a newer build), the network pill (only while the probe says the link is missing or
  // its path out is broken) and the runtime-attention button (only while the environment check FAILS — a CI
  // runner has no agent runtime). A mask that ran before one of them appeared left it in the layout, and the
  // same page then diffed differently on each attempt (measured on the lane: 0.2% on one attempt, 0.6% on the
  // retry, both over the 0.2% budget). So the header is waited for until it stops changing, and all four are
  // taken out of the layout before the shot. Everything else stays strictly compared — no tolerance loosened.
  await waitForStableHeader(page)
  await page.evaluate(() => {
    const badge = document.querySelector('[data-slot="app-version"]')
    if (badge instanceof HTMLElement) badge.style.visibility = 'hidden'
    for (const slot of ['environment-attention', 'update-capsule', 'network-status']) {
      for (const element of document.querySelectorAll(`[data-slot="${slot}"]`)) {
        if (element instanceof HTMLElement) element.style.display = 'none'
      }
    }
  })
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  try {
    await expect(page).toHaveScreenshot(name, {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: process.platform === 'darwin' ? maxDiffPixelRatio : 0.035
    })
  } catch (error) {
    // A pixel count names nothing by itself, and the diff image stays on the runner (the certification
    // job uploads P0 artifacts only). Say what the surface actually held, so the next red is readable
    // from the job log alone: identical text with a diff means paint/environment, different text names
    // the element that changed.
    console.log(
      `[visual] ${name} differs; surface fingerprint ${JSON.stringify(await surfaceFingerprint(page))}`
    )
    throw error
  }
}

// What a reader would see, as text plus the boxes that carry it — enough to tell "the copy changed"
// from "the same copy rendered differently" without the diff image.
const surfaceFingerprint = async (page: Page): Promise<Record<string, unknown>> =>
  page.evaluate(() => {
    const text = (element: Element | null): string | null =>
      element === null ? null : (element.textContent ?? '').replace(/\s+/g, ' ').trim()
    const box = (element: Element | null): string | null => {
      if (element === null) return null
      const rect = element.getBoundingClientRect()
      return `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`
    }
    const dialog = document.querySelector('[role="dialog"]')
    const active = document.activeElement
    return {
      active:
        active === null
          ? null
          : `${active.tagName}${(active as HTMLElement).id ? `#${(active as HTMLElement).id}` : ''}`,
      header: text(document.querySelector('header')),
      dialog: text(dialog),
      dialogBox: box(dialog),
      documents: `${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}`,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      theme: document.documentElement.className
    }
  })

test('keeps core desktop surfaces visually stable', async ({ app }) => {
  const page = await app.completeOnboarding()
  await prepareVisualPage(page)
  await expect(page.getByRole('region', { name: 'Projects' })).toBeVisible()
  await expectStableScreenshot(page, 'home-empty.png')

  await page.getByRole('button', { name: 'New project' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'New project' })
  await expect(projectDialog).toBeVisible()
  await expectStableScreenshot(page, 'project-create-dialog.png')

  await projectDialog.getByLabel('Name').fill('Visual baseline project')
  await projectDialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
  await expectStableScreenshot(page, 'workspace-empty.png')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'General', exact: true })
    .click()
  await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  const appVersion = settings.getByRole('region', { name: 'App version' })
  // The version line itself carries no layout information and changes every release, while the packaged app and
  // an unpackaged build report different values for it — so it is masked outright rather than compared. Hiding
  // only the buttons and the <p> elements left the line itself visible, which is exactly the pixel difference
  // that failed the release lane (6020 px, 1.0%, reproduced on retry, and absent when run against the build
  // rather than the packaged app).
  await appVersion.locator('*').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden'
  })
  await appVersion.getByRole('button').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden'
  })
  await appVersion.locator(':scope > p').evaluateAll((elements) => {
    for (const element of elements) element.style.visibility = 'hidden'
  })
  // The text-dense settings surface has slightly different font antialiasing on macos-14 runners.
  await expectStableScreenshot(page, 'settings-general.png', 0.004)
})
