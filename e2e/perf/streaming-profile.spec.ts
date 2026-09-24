import { test } from '../fixtures/electron-app'
import { createProject } from '../certification/helpers'
import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

// Attribution run for the streaming jank the smoothness baseline reproduces at PERF_TURNS=45: instead of
// guessing which render path costs the 50-78ms tasks, this records a real CDP CPU profile during the
// streaming phase and writes it to test-results/perf/. Analyse it with:
//
//   node scripts/ci/../   (or the snippet in docs/evidence) — see docs/evidence/...-audit.md
//
// It asserts nothing about speed; it exists to produce evidence.

const sendTurn = async (page: Page, prompt: string): Promise<void> => {
  const replies = page.getByText('Deterministic reply', { exact: false })
  const before = await replies.count()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect.poll(async () => replies.count(), { timeout: 60_000 }).toBeGreaterThan(before)
}

test('records a CPU profile while a long transcript streams', async ({ app }) => {
  test.setTimeout(300_000)
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Streaming profile')

  const turns = Number(process.env.PERF_TURNS ?? 45)
  for (let index = 0; index < turns; index += 1) {
    await sendTurn(page, `Profile turn ${index}`)
  }

  await mkdir('test-results/perf', { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')

  // Profile the next three streaming turns: the phase the baseline measured as janky.
  for (let index = 0; index < 3; index += 1) {
    await sendTurn(page, `Profiled turn ${index}`)
  }

  const { profile } = (await cdp.send('Profiler.stop')) as { profile: unknown }
  const path = 'test-results/perf/streaming.cpuprofile'
  await writeFile(path, JSON.stringify(profile))
  console.log(`[perf] cpu profile written to ${path}`)
})
