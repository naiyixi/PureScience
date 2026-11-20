import { expect } from '@playwright/test'
import type { TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
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

// Baselines are per machine class, not per product version.
//
// The same commit rasterises text slightly differently on the CI runner and on a development machine: run
// 44730436800 measured 2526 px (ratio 0.01) on `workspace-empty` against a baseline captured here, while the
// same commit passed locally in 9.0 s. Playwright already separates baselines by OS and architecture; this
// separates the two darwin-arm64 machines that actually run this spec, so a red means the product changed
// rather than that the other machine drew the same glyphs differently. Both profiles are refreshed the same
// way — run with `--update-snapshots` on the machine whose files you are updating.
const baselineProfile = (): string => (process.env.CI === 'true' ? 'ci' : 'local')

const baselineName = (name: string): string => name.replace(/\.png$/, `-${baselineProfile()}.png`)

const expectStableScreenshot = async (
  page: Page,
  name: string,
  testInfo: TestInfo,
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
    // The case market is the one section whose contents come off the network: the shelf is a GitHub release asset,
    // so its rows change whenever anyone publishes (measured: 2,984 px — 1% — between two runs of this same tree,
    // after a republished archive moved one case from 6 files to 15 and its size from 1.7 MB to 2.7 MB). Its
    // height follows that data, so hiding only the cards would shift everything below them; the whole section comes
    // out of the layout, and what stays compared is the part of the home page that this repository owns.
    for (const slot of [
      'environment-attention',
      'update-capsule',
      'network-status',
      'case-market'
    ]) {
      for (const element of document.querySelectorAll(`[data-slot="${slot}"]`)) {
        if (element instanceof HTMLElement) element.style.display = 'none'
      }
    }
  })
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  try {
    await expect(page).toHaveScreenshot(baselineName(name), {
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
    // …and say WHERE. The fingerprint above cannot separate "the copy changed" from "the same box moved",
    // and a lane-only red (the runner renders a packaged app on another macOS build) leaves no diff image
    // to look at. The two PNGs both exist on the runner — Playwright just wrote the actual beside the test
    // output — so they are compared here and the differing box is named, with the elements inside it.
    const region = await diffRegion(page, name, testInfo)
    console.log(`[visual] ${name} differing region ${JSON.stringify(region)}`)
    throw error
  }
}

// Reads the expected snapshot and the actual capture Playwright just wrote, compares them in the page
// (an OffscreenCanvas needs no extra dependency), and reports the bounding box of the pixels that differ
// together with the elements intersecting it. Instrumentation only: it never decides pass or fail.
const diffRegion = async (
  page: Page,
  name: string,
  testInfo: TestInfo
): Promise<Record<string, unknown>> => {
  try {
    const expected = await readFile(testInfo.snapshotPath(name, { kind: 'snapshot' }))
    // Playwright writes `<stem>-actual.png`: the extension is dropped, not doubled.
    const actual = await readFile(testInfo.outputPath(`${name.replace(/\.png$/, '')}-actual.png`))
    return await page.evaluate(
      async (payload: { expected: string; actual: string }) => {
        // No fetch here: the app page's CSP refuses data: URLs, and this only needs the bytes decoded.
        const decode = async (base64: string): Promise<ImageBitmap> => {
          const binary = atob(base64)
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index += 1)
            bytes[index] = binary.charCodeAt(index)
          return createImageBitmap(new Blob([bytes], { type: 'image/png' }))
        }
        const [want, got] = await Promise.all([decode(payload.expected), decode(payload.actual)])
        if (want.width !== got.width || want.height !== got.height) {
          return {
            geometry: `expected ${want.width}x${want.height}, actual ${got.width}x${got.height}`
          }
        }
        const pixels = (bitmap: ImageBitmap): Uint8ClampedArray => {
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          const context = canvas.getContext('2d')
          if (!context) throw new Error('no 2d context')
          context.drawImage(bitmap, 0, 0)
          return context.getImageData(0, 0, bitmap.width, bitmap.height).data
        }
        const left = pixels(want)
        const right = pixels(got)
        let minX = Number.POSITIVE_INFINITY
        let minY = Number.POSITIVE_INFINITY
        let maxX = -1
        let maxY = -1
        let changed = 0
        for (let index = 0; index < left.length; index += 4) {
          const delta =
            Math.abs(left[index] - right[index]) +
            Math.abs(left[index + 1] - right[index + 1]) +
            Math.abs(left[index + 2] - right[index + 2])
          if (delta <= 24) continue
          changed += 1
          const pixel = index / 4
          const x = pixel % want.width
          const y = (pixel - x) / want.width
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
        if (changed === 0) return { changed: 0 }
        const nameOf = (element: Element): string => {
          const slot = element.getAttribute('data-slot')
          const label = element.getAttribute('aria-label')
          const id = element.getAttribute('data-testid')
          const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 48)
          return `${element.tagName}${slot ? ` slot=${slot}` : ''}${id ? ` testid=${id}` : ''}${label ? ` label=${label}` : ''}${text ? ` “${text}”` : ''}`
        }
        const seen = new Set<Element>()
        const elements: string[] = []
        for (let x = minX; x <= maxX; x += Math.max(8, Math.round((maxX - minX) / 8) || 8)) {
          for (let y = minY; y <= maxY; y += Math.max(8, Math.round((maxY - minY) / 4) || 8)) {
            const hit = document.elementFromPoint(x, y)
            if (hit === null || seen.has(hit)) continue
            seen.add(hit)
            elements.push(`${nameOf(hit)} @${x},${y}`)
          }
        }
        return {
          changed,
          box: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
          elements: elements.slice(0, 12)
        }
      },
      {
        expected: expected.toString('base64'),
        actual: actual.toString('base64')
      }
    )
  } catch (cause) {
    return { unavailable: cause instanceof Error ? cause.message : String(cause) }
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

test('keeps core desktop surfaces visually stable', async ({ app }, testInfo) => {
  const page = await app.completeOnboarding()
  await prepareVisualPage(page)
  await expect(page.getByRole('region', { name: 'Projects' })).toBeVisible()
  await expectStableScreenshot(page, 'home-empty.png', testInfo)

  await page.getByRole('button', { name: 'New project' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'New project' })
  await expect(projectDialog).toBeVisible()
  await expectStableScreenshot(page, 'project-create-dialog.png', testInfo)

  await projectDialog.getByLabel('Name').fill('Visual baseline project')
  await projectDialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
  await expectStableScreenshot(page, 'workspace-empty.png', testInfo)

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
  await expectStableScreenshot(page, 'settings-general.png', testInfo, 0.004)
})
