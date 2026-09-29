import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect } from '@playwright/test'

import { test } from './fixtures/electron-app'

// U1 (#17) on a real machine: the real Electron app, the real update check running in the MAIN process,
// the real renderer store, the real dialog and a real Chromium layout. The only replaced thing is the
// BYTES of the version.json response — the check runs through Electron's net.fetch in main, which no
// page-level route can intercept, and the manifest of the next release cannot exist yet. Everything
// downstream of those bytes (UpdateService → status broadcast → update store → dialog → CSS layout) is
// the shipped code path, which is why the numbers below are worth writing down.
//
// What this pins:
//   R1  syntax the renderer has no rule for reaches the reader verbatim;
//   R2  the size on the button is the manifest's size for THIS host's artifact (the sizes below are all
//       different on purpose) and the number is rendered by the real browser;
//   R3  the Chinese copy + a 2000-character unbreakable token cause no horizontal overflow, no
//       ellipsis-clipping and no element spilling outside the panel.

const RELEASE_VERSION = '1.99.0'
const CDN = `https://github.com/naiyixi/PureScience/releases/download/v${RELEASE_VERSION}`
const SHA = 'a'.repeat(64)

// One entry per platform key the app can ask for, each with a distinct size and the label it must
// produce. The sizes are what the assertion compares against — nothing here is derived from the app.
const ARTIFACTS = {
  'mac-arm64': {
    file: `PureScience-${RELEASE_VERSION}-arm64.dmg`,
    size: 7.5 * 1024 * 1024,
    label: '7.5 MB'
  },
  'mac-x64': {
    file: `PureScience-${RELEASE_VERSION}-x64.dmg`,
    size: 9 * 1024 * 1024,
    label: '9.0 MB'
  },
  'win-x64': {
    file: `PureScience-Setup-${RELEASE_VERSION}.exe`,
    size: 10 * 1024 * 1024,
    label: '10.0 MB'
  },
  'linux-x64-deb': {
    file: `PureScience-${RELEASE_VERSION}-amd64.deb`,
    size: 11 * 1024 * 1024,
    label: '11.0 MB'
  }
} as const

type ArtifactKey = keyof typeof ARTIFACTS

// Mirrors platformDownloadKey in src/shared/update.ts so the expectation follows the host the spec runs on.
const hostArtifactKey = (): ArtifactKey => {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  if (process.platform === 'win32') return 'win-x64'
  return 'linux-x64-deb'
}

// 2000 characters with no space and no CJK break opportunity: the worst case a wrap rule has to survive.
const LONG_TOKEN = `超长不可断行${'abcdefghij'.repeat(200)}结尾标记`

const NOTES_ZH = [
  '## 新功能',
  '- **更新说明结构化渲染**：分组标题 + 编号条目 + 条目内小标题，改动引用 `5ef94da`。',
  '- **下载体积真实**：按钮上显示更新器报出的待下载体积，取不到就不显示（04df5a56）。',
  '## 修复',
  `- 修掉更新对话框的一处横向溢出：${LONG_TOKEN}`,
  '',
  '> 未知语法（引用块）原样显示',
  '| 表头 | 值 |',
  '结尾纯文本'
].join('\n')

const NOTES_EN = ['## New', '- **Structured notes** — group titles, numbered entries.'].join('\n')

const manifest = {
  version: RELEASE_VERSION,
  releaseDate: new Date().toISOString(),
  notes: { zh: NOTES_ZH, en: NOTES_EN },
  downloads: Object.fromEntries(
    Object.entries(ARTIFACTS).map(([key, artifact]) => [
      key,
      { url: `${CDN}/${artifact.file}`, size: artifact.size, sha256: SHA }
    ])
  )
}

test('the update dialog structures its notes, keeps unknown syntax, and shows the real download size', async ({
  app
}) => {
  const page = await app.completeOnboarding()
  const expected = ARTIFACTS[hostArtifactKey()]
  const otherLabels = Object.entries(ARTIFACTS)
    .filter(([key]) => key !== hostArtifactKey())
    .map(([, artifact]) => artifact.label)

  await app.stubUpdateManifest(manifest)

  // Real UI path: Settings → General → Check now.
  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'General', exact: true })
    .click()

  // The startup check may still be in flight; the button is disabled while one is running.
  const checkNow = settings.getByRole('button', { name: 'Check now' })
  await expect(checkNow).toBeEnabled({ timeout: 60_000 })
  await checkNow.click()
  await expect(settings.getByRole('button', { name: `Update to ${RELEASE_VERSION}` })).toBeVisible({
    timeout: 30_000
  })

  // Worst case for layout: the Chinese copy, chosen through the real picker.
  await settings.getByRole('combobox', { name: 'Language' }).click()
  await page.getByRole('option', { name: '简体中文' }).click()
  const settingsZh = page.getByRole('dialog', { name: '设置' })
  const updateButton = settingsZh.getByRole('button', { name: `更新到 ${RELEASE_VERSION}` })
  await expect(updateButton).toBeVisible({ timeout: 15_000 })
  await updateButton.click()

  const dialog = page.getByRole('dialog', { name: '有可用更新' })
  await expect(dialog).toBeVisible()

  // --- R2: the button carries the updater's own size for THIS host's artifact -------------------
  const downloadButton = dialog.getByRole('button', { name: `下载更新（${expected.label}）` })
  await expect(downloadButton).toBeVisible()
  await expect(downloadButton).toBeEnabled()
  for (const label of otherLabels) await expect(downloadButton).not.toContainText(label)

  // --- U1: group titles, numbered entries, entry subtitle ---------------------------------------
  await expect(dialog.getByTestId('release-note-group-title')).toHaveText(['新功能', '修复'])
  const entries = dialog.getByTestId('release-note-entry')
  await expect(entries).toHaveCount(3)
  await expect(entries.first().getByTestId('release-note-entry-title')).toHaveText(
    '更新说明结构化渲染：'
  )
  await expect(entries.first()).toContainText('5ef94da')
  await expect(entries.nth(1)).toContainText('04df5a56')
  // A real <ol> with real markers: the numbering is painted by the browser, not typed into the text.
  await expect(dialog.locator('ol')).toHaveCount(2)
  await expect(dialog.locator('ol').first()).toHaveCSS('list-style-type', 'decimal')

  // --- R1: syntax the renderer has no rule for is on screen, verbatim ---------------------------
  await expect(dialog).toContainText('> 未知语法（引用块）原样显示')
  await expect(dialog).toContainText('| 表头 | 值 |')
  await expect(dialog).toContainText('结尾纯文本')
  await expect(dialog).toContainText(LONG_TOKEN)

  // --- R3: measured in the real browser --------------------------------------------------------
  const surface = dialog.getByTestId('update-notes-surface')
  const metrics = await surface.evaluate((element) => {
    const nodes = Array.from(element.querySelectorAll<HTMLElement>('*'))
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      ellipsized: nodes.filter((node) => getComputedStyle(node).textOverflow === 'ellipsis').length,
      clipped: nodes.filter((node) => getComputedStyle(node).overflow === 'hidden').length,
      // Every descendant must fit horizontally inside the surface's content box.
      widestRight: Math.max(
        ...nodes.map((node) => {
          const nodeBox = node.getBoundingClientRect()
          const surfaceBox = element.getBoundingClientRect()
          return nodeBox.right - surfaceBox.right
        })
      )
    }
  })
  const dialogMetrics = await dialog.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }))
  const buttonBox = await downloadButton.boundingBox()
  const dialogBox = await dialog.boundingBox()

  // The long token must have WRAPPED inside the box rather than run past its right edge: measure the
  // actual line boxes of the whole token (a scroll container would report them beyond its content box).
  const longLine = await surface.evaluate((element, token) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const surfaceBox = element.getBoundingClientRect()
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      const start = node.data.indexOf(token)
      if (start < 0) continue
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + token.length)
      const rects = Array.from(range.getClientRects())
      return {
        characters: token.length,
        lineBoxes: rects.length,
        widestRight: Math.max(...rects.map((rect) => rect.right)),
        surfaceRight: surfaceBox.right
      }
    }
    return null
  }, LONG_TOKEN)

  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
  expect(metrics.widestRight).toBeLessThanOrEqual(1)
  expect(metrics.ellipsized).toBe(0)
  expect(longLine).not.toBeNull()
  // 2000-odd unbreakable characters cannot be one line in a 518px box: if this is 1, the token did not
  // wrap and the box is hiding the overflow.
  expect(longLine?.lineBoxes ?? 0).toBeGreaterThan(10)
  expect(longLine?.widestRight ?? 0).toBeLessThanOrEqual((longLine?.surfaceRight ?? 0) + 1)
  expect(dialogMetrics.scrollWidth).toBeLessThanOrEqual(dialogMetrics.clientWidth + 1)
  expect(buttonBox).not.toBeNull()
  expect(dialogBox).not.toBeNull()
  if (buttonBox && dialogBox) {
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 1)
  }
  // The notes scroll vertically by design (max-h); they must not be clipped horizontally.
  expect(metrics.clientHeight).toBeGreaterThan(0)

  const evidenceDir = resolve(process.cwd(), 'docs', 'evidence')
  await mkdir(evidenceDir, { recursive: true })
  await page.screenshot({ path: resolve(evidenceDir, '2026-09-30-u1-update-notes-zh.png') })
  // The surface scrolls vertically, so the second image is taken from the bottom of the notes — that is
  // where the unbreakable token lives, and the wrap is the thing worth looking at.
  await surface.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await surface.screenshot({
    path: resolve(evidenceDir, '2026-09-30-u1-update-notes-zh-surface.png')
  })
  await writeFile(
    resolve(evidenceDir, '2026-09-30-u1-update-notes-metrics.json'),
    `${JSON.stringify(
      {
        host: `${process.platform}/${process.arch}`,
        artifactKey: hostArtifactKey(),
        reportedSizeBytes: expected.size,
        shownSizeLabel: expected.label,
        notesSurface: metrics,
        longTokenLineBoxes: longLine,
        dialog: dialogMetrics,
        downloadButtonBox: buttonBox,
        dialogBox
      },
      null,
      2
    )}\n`,
    'utf8'
  )
})
