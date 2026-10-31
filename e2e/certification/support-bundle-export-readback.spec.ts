import { statSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import * as tar from 'tar'

import { formatBytes } from '../../src/shared/update'
import { test } from '../fixtures/electron-app'

// IC37 real-window acceptance: the support-bundle export reports what it wrote and how much it stripped.
//
// The main process has always computed `bytes` and `redactions` on the result; the panel showed only the path, so
// a reader had to open the archive to learn either. Now the message carries both.
//
// Only the native save dialog is stubbed (the fixture's one seam) — everything downstream is real: the bundle is
// assembled and written by the app, and the size in the message is cross-checked against the file on disk, so
// the number cannot be a coincidence of two places quoting the same stub.
//
// It also reads back the every-call latency section. That section is the only place a channel's *ordinary* cost
// is recorded (the slow ring starts at 50 ms), so it is the reading a "it feels slow" report depends on: if the
// producer stopped being wired, the file would keep shipping its empty state and every unit test would still be
// green. The window this test drove is what makes the assertion meaningful — the numbers counted here were
// produced by the clicks above, not by a fixture.
test.setTimeout(180_000)

test('the support-bundle export reports the size and the redaction count', async ({ app }) => {
  const page = await app.completeOnboarding()
  const bundlePath = join(app.storageRoot, 'support-bundle.zip')
  await app.stubSaveDialog(bundlePath)

  await page.getByRole('button', { name: 'Settings' }).first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'General', exact: true })
    .click()
  await settings.getByRole('button', { name: /Export support bundle/i }).click()

  // The message is where the two numbers have to appear…
  const message = settings.getByText(/Support bundle saved to/i).first()
  await expect(message).toBeVisible({ timeout: 60_000 })
  const text = (await message.innerText()).replace(/\s+/g, ' ').trim()
  console.log(`[ic37] the panel says: "${text}"`)
  expect(text).toContain(bundlePath)

  // …the size it reports is the size on disk (read independently here, formatted by the same shared helper).
  const onDisk = statSync(bundlePath).size
  console.log(`[ic37] the bundle on disk: ${onDisk} bytes`)
  expect(onDisk).toBeGreaterThan(0)
  const reported = formatBytes(onDisk, 'en')
  console.log(`[ic37] that size as the panel would render it: "${reported}"`)
  expect(text).toContain(reported)

  // …and the redaction count is a number the reader can act on, not a placeholder.
  const redactions = /(\d+)\s+fields redacted/.exec(text)
  console.log(`[ic37] the redaction count it reports: ${redactions?.[1] ?? '(none)'}`)
  expect(redactions).not.toBeNull()
  expect(Number(redactions?.[1] ?? '-1')).toBeGreaterThanOrEqual(0)

  // The every-call window, read back from the archive the app wrote. `status` is asserted before the numbers:
  // the empty state (`no-calls-observed`) is a legitimate shape for a process that served nothing, and it must
  // not be readable as "the channel is fast" — or as "the producer is still wired".
  const extracted = join(app.storageRoot, 'bundle-extracted')
  await mkdir(extracted, { recursive: true })
  await tar.extract({ file: bundlePath, cwd: extracted })
  const latency = JSON.parse(
    await readFile(join(extracted, 'diagnostics/ipc-channel-latency.json'), 'utf8')
  ) as {
    status: string
    capacity: number
    channelsObserved: number
    untrackedCalls: number
    channels: {
      channel: string
      observed: number
      windowSamples: number
      p50Ms: number
      p95Ms: number
      maxMs: number
      rejectedInWindow: number
    }[]
  }
  console.log(
    `[ic37] channels measured: ${latency.channelsObserved}, listed: ${latency.channels.length}, untracked: ${latency.untrackedCalls}`
  )
  console.log(
    `[ic37] worst tail: ${latency.channels
      .slice(0, 5)
      .map((entry) => `${entry.channel} p50=${entry.p50Ms}ms p95=${entry.p95Ms}ms`)
      .join(' | ')}`
  )
  // The Settings dialog this test drove is hundreds of IPC calls; a process that served them cannot be empty.
  expect(latency.status).toBe('records')
  expect(latency.channelsObserved).toBeGreaterThan(0)
  expect(latency.capacity).toBeGreaterThan(0)
  const measured = latency.channels.find((entry) => entry.windowSamples > 0)
  expect(measured).toBeDefined()
  expect(Number.isFinite(measured?.p50Ms)).toBe(true)
  expect(Number.isFinite(measured?.p95Ms)).toBe(true)
  // Ordering is what makes the pair readable as a distribution rather than two independent numbers.
  expect(Number(measured?.p95Ms)).toBeGreaterThanOrEqual(Number(measured?.p50Ms))
  expect(Number(measured?.maxMs)).toBeGreaterThanOrEqual(Number(measured?.p95Ms))
  expect(Number(measured?.rejectedInWindow)).toBeGreaterThanOrEqual(0)
})
