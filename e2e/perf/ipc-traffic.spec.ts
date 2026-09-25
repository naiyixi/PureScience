import { test } from '../fixtures/electron-app'
import { createProject } from '../certification/helpers'
import { expect } from '@playwright/test'
import type { Page } from 'playwright'

// How much does one streamed turn ship from the main process to the renderer?
//
// The React side of streaming has its own instrument (`smoothness.spec.ts` counts commits and long tasks,
// `streaming-profile.spec.ts` attributes CPU). Neither can see the other half of the cost: every chunk that
// crosses the preload bridge is deserialized by the renderer, applied to React state, and — for the snapshot
// channel — walked in full again. This spec counts what actually crosses, per channel and in bytes, from the
// main process: the renderer's own bridge objects are contextBridge-frozen and cannot be wrapped.
//
// A single-chunk reply hides all of it (one delivery per turn), so this spec streams: the fixture splits an
// answer into PURESCIENCE_E2E_STREAM_CHUNKS pieces (40 by default here, one every 5ms), which is what a real
// agent turn looks like. Reported per turn: sends and bytes per channel, with the transcript size for scale.
//
//   npm run build:e2e && npx playwright test e2e/perf/ipc-traffic.spec.ts
//
// Not part of the certification matrix: numbers on a shared runner cannot gate a release.

process.env.PURESCIENCE_E2E_STREAM_CHUNKS ??= '40'

type ChannelTraffic = { channels: Record<string, number>; bytes: Record<string, number> }
type MainBridge = { runningApplication: { evaluate: (fn: unknown, arg?: unknown) => Promise<unknown> } }

const INSTALL = ({ webContents, app }: { webContents: unknown; app: unknown }): void => {
  const scope = globalThis as unknown as {
    __ipcTraffic?: ChannelTraffic
    __ipcTrafficInstalled?: boolean
  }
  if (scope.__ipcTrafficInstalled) return
  scope.__ipcTrafficInstalled = true
  scope.__ipcTraffic = { channels: {}, bytes: {} }
  const patch = (contents: unknown): void => {
    const target = contents as { send: (channel: string, ...args: unknown[]) => void }
    const original = target.send.bind(target)
    target.send = (channel: string, ...args: unknown[]): void => {
      const traffic = scope.__ipcTraffic
      if (traffic) {
        traffic.channels[channel] = (traffic.channels[channel] ?? 0) + 1
        // JSON length is a stable proxy for the structured clone the renderer pays for: the payload has
        // already been validated as cloneable by reaching this call.
        traffic.bytes[channel] =
          (traffic.bytes[channel] ?? 0) + (args.length > 0 ? JSON.stringify(args).length : 0)
      }
      original(channel, ...args)
    }
  }
  const bridge = webContents as { getAllWebContents: () => unknown[] }
  for (const contents of bridge.getAllWebContents()) patch(contents)
  const lifecycle = app as { on: (event: string, listener: (event: unknown, contents: unknown) => void) => void }
  lifecycle.on('web-contents-created', (_event, contents) => patch(contents))
}

const RESET = (): void => {
  const scope = globalThis as unknown as { __ipcTraffic?: ChannelTraffic }
  if (scope.__ipcTraffic) scope.__ipcTraffic = { channels: {}, bytes: {} }
}

const READ = (): ChannelTraffic | undefined =>
  (globalThis as unknown as { __ipcTraffic?: ChannelTraffic }).__ipcTraffic

const sendTurn = async (page: Page, prompt: string): Promise<void> => {
  const replies = page.getByText('Deterministic reply', { exact: false })
  const before = await replies.count()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect.poll(async () => replies.count(), { timeout: 60_000 }).toBeGreaterThan(before)
}

test('measures how much a streamed turn sends to the renderer', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'IPC traffic baseline')

  const bridge = app as unknown as MainBridge
  await bridge.runningApplication.evaluate(INSTALL as unknown as (electron: unknown) => void)

  const turns = Number(process.env.PERF_TURNS ?? 3)
  const chunks = Number(process.env.PURESCIENCE_E2E_STREAM_CHUNKS ?? 1)
  for (let index = 0; index < turns; index += 1) {
    await bridge.runningApplication.evaluate(RESET as unknown as (electron: unknown) => void)
    await sendTurn(page, `Traffic turn ${index}`)
    const traffic = (await bridge.runningApplication.evaluate(
      READ as unknown as (electron: unknown) => ChannelTraffic
    )) as ChannelTraffic
    const transcriptBytes = await page.evaluate(() => document.body.innerText.length)
    const totalBytes = Object.values(traffic.bytes).reduce((sum, value) => sum + value, 0)
    const ranked = Object.entries(traffic.bytes)
      .sort((left, right) => right[1] - left[1])
      .map(
        ([channel, bytes]) =>
          `${channel}×${traffic.channels[channel]}=${Math.round(bytes / 1024)}KB(≈${Math.round(
            bytes / Math.max(traffic.channels[channel] ?? 1, 1)
          )}B each)`
      )
    console.log(
      `[ipc] turn ${index}: chunks=${chunks} transcript≈${transcriptBytes}B total=${Math.round(
        totalBytes / 1024
      )}KB | ${ranked.join(', ')}`
    )
  }
})
