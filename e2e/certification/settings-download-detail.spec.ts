import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// IC17 real-window acceptance for the SETTINGS page's download detail.
//
// The workspace half of this claim is already recorded by the IC16 reading (its gate printed
// `Downloading managed python runtime (2%) 63.8 KB/s · 24.0 KB / 16.0 MB · ~4m 17s`). What was missing is
// Settings: its setup card showed the message and a bare bar, with no speed, size or ETA — the same
// download read two different ways. This drives a real provision against the same stub CDN and reads the
// panel's line, which is now the SHARED formatter's output (`formatProgressLine`), the same one the
// workspace banner and the update dialog use.
//
// MEASUREMENT CORRECTION (why the first version of this spec was wrong to stay a log). Its header filed
// the missing speed/size/ETA as a pipeline defect — "the rich `download` field does not survive to the
// store in this flow" — on the strength of ONE sample taken at i === 0, i.e. immediately after the retry
// click and therefore before any download tick exists. That reading cannot be generalised: the `(N%)`
// message and the `download` detail are fields of ONE object literal (src/main/notebook/language-pack-fetch.ts),
// so a card displaying the percent is necessarily holding the detail, and Electron's structured clone
// cannot keep one field while dropping its sibling. The spec now measures the two halves separately and
// asserts both, so a red run names WHICH half is missing (transit vs rendering) instead of leaving it to
// prose: the raw broadcast the renderer receives, and the card's rendered line.
const STALL_PORT = 41998
process.env.PURESCIENCE_ENV_CDN_BASE = `http://127.0.0.1:${STALL_PORT}`
process.env.PURESCIENCE_MICROMAMBA_BIN = join(
  homedir(),
  '.purescience',
  'runtime',
  'micromamba',
  'bin',
  'micromamba'
)

const PACK_SUBDIR = process.platform === 'darwin' ? 'osx-arm64' : 'linux-64'
const PACK_BYTES = 16_777_216
const DRIP_INTERVAL_MS = 200
const DRIP_CHUNK = 'x'.repeat(8 * 1024)

let cdn: Server
let manifestAttempts = 0

test.beforeAll(async () => {
  cdn = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0]
    if (path.endsWith('/manifest.json')) {
      manifestAttempts += 1
      console.log(`[ic17-cdn] manifest request #${manifestAttempts}`)
      if (manifestAttempts === 1) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'cdn-down' }))
        return
      }
      const entry = (version: string): Record<string, unknown> => ({
        language: 'python',
        version,
        file: `python-${version}.tar.zst`,
        sha256: '0'.repeat(64),
        size: PACK_BYTES
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          schema: 1,
          envVersion: 1,
          subdir: PACK_SUBDIR,
          packs: { 'python-3.12': entry('3.12'), 'python-3.13': entry('3.13') }
        })
      )
      return
    }
    console.log(`[ic17-cdn] pack drip start: ${path}`)
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(PACK_BYTES)
    })
    const drip = setInterval(() => response.write(DRIP_CHUNK), DRIP_INTERVAL_MS)
    response.on('close', () => clearInterval(drip))
  })
  await new Promise<void>((resolve) => cdn.listen(STALL_PORT, '127.0.0.1', () => resolve()))
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => cdn.close(() => resolve()))
})

test.setTimeout(420_000)

test('the Settings setup card shows the same live download detail the workspace shows', async ({
  app
}) => {
  const page = await app.completeOnboarding()

  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Runtimes' })
    .click()
  await settings
    .getByTestId('runtimes-cards-python')
    .getByRole('button', { name: 'Download and set up' })
    .click()

  // First manifest attempt fails (500), so the card reports the failure; the retry is what reaches the
  // dripping pack. Both paths are the real provisioner, not a simulated state.
  const retry = settings.getByRole('button', { name: /retry/i }).first()
  await expect(retry).toBeVisible({ timeout: 120_000 })

  // TRANSIT HALF. Subscribe to the same broadcast channel the store uses, from the page, and record what
  // the renderer was actually HANDED (the nested detail included). Installing it before the retry means
  // every download tick is observed. Read back after the sampling loop.
  await page.evaluate(() => {
    const scope = globalThis as unknown as {
      __ic17raw: Array<{ phase: string; message: string; hasDownload: boolean; speed?: number }>
      api: { notebookEnv: { onProgress: (listener: (p: unknown) => void) => () => void } }
    }
    scope.__ic17raw = []
    scope.api.notebookEnv.onProgress((p) => {
      const event = p as {
        phase?: string
        message?: string
        download?: { bytesPerSecond?: number }
      }
      scope.__ic17raw.push({
        phase: String(event.phase),
        message: String(event.message),
        hasDownload: event.download != null,
        speed: event.download?.bytesPerSecond
      })
    })
  })

  await retry.click()

  // RENDERING HALF. The message carries the percent only during a pack download
  // (`Downloading managed <lang> runtime (N%)` — language-pack-fetch.ts is its ONLY producer), so the
  // same sample that shows a percent is a sample in which the card was holding a download tick, and the
  // shared line must be on screen with it (`formatSpeed`'s `/s` suffix is the marker).
  const percents = new Set<string>()
  let cardShowedSharedLine = false
  for (let i = 0; i < 8; i += 1) {
    const section = (await settings.getByTestId('runtimes-cards-python').innerText()).replace(
      /\s+/g,
      ' '
    )
    const percent = /\((\d+)%\)/.exec(section)?.[1]
    if (percent) percents.add(percent)
    if (percent && section.includes('/s')) cardShowedSharedLine = true
    if (i === 0) console.log(`[ic17-panel] first sample :: ${section.slice(0, 200)}`)
    await page.waitForTimeout(4_000)
  }

  const raw = await page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ic17raw: Array<{ phase: string; message: string; hasDownload: boolean; speed?: number }>
        }
      ).__ic17raw
  )
  const withDetail = raw.filter((event) => event.hasDownload)
  console.log(
    `[ic17] renderer received ${raw.length} broadcast(s); ${withDetail.length} carried the nested download detail; sample ${JSON.stringify(withDetail[0] ?? raw[0] ?? null)}`
  )
  console.log(
    `[ic17] panel percent samples: ${[...percents].join(', ')}; shared line rendered: ${cardShowedSharedLine}`
  )

  expect(raw.length).toBeGreaterThan(0)
  expect(withDetail.length).toBeGreaterThan(0)
  // The card is live: a stuck renderer would show one value (or none) for thirty seconds.
  expect(percents.size).toBeGreaterThan(1)
  expect(cardShowedSharedLine).toBe(true)
})
