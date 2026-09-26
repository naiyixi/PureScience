import { expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import type { CDPSession, Page } from 'playwright'

import { createProject } from '../certification/helpers'
import { test } from '../fixtures/electron-app'

// Where does a long session actually spend its work while the user *does* something (scrolls, types)?
// CPU profiles answer "which frame", but their wall-clock numbers swing with machine load. CDP's
// Performance domain answers with **counters** instead — LayoutCount, RecalcStyleCount, Nodes,
// TaskDuration — which are load-independent, so a before/after comparison needs no ABBA pairing.
//
// It asserts nothing about speed; it produces evidence.

const sendTurn = async (page: Page, prompt: string): Promise<void> => {
  const replies = page.getByText('Deterministic reply', { exact: false })
  const before = await replies.count()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect.poll(async () => replies.count(), { timeout: 60_000 }).toBeGreaterThan(before)
}

const readMetrics = async (cdp: CDPSession): Promise<Record<string, number>> => {
  const { metrics } = (await cdp.send('Performance.getMetrics')) as {
    metrics: Array<{ name: string; value: number }>
  }
  const map: Record<string, number> = {}
  for (const metric of metrics) map[metric.name] = metric.value
  return map
}

const TRACKED = [
  'Nodes',
  'LayoutCount',
  'RecalcStyleCount',
  'LayoutDuration',
  'RecalcStyleDuration',
  'ScriptDuration',
  'TaskDuration'
]

const report = (
  label: string,
  before: Record<string, number>,
  after: Record<string, number>
): void => {
  const parts = TRACKED.map((key) => {
    const value = (after[key] ?? 0) - (before[key] ?? 0)
    return key.endsWith('Duration')
      ? `${key}=${(value * 1000).toFixed(0)}ms`
      : `${key}=${value >= 0 ? '+' : ''}${value}`
  })
  console.log(`[perf] ${label}: ${parts.join(' ')}`)
}

test('measures the interaction metrics a user can feel', async ({ app }) => {
  test.setTimeout(600_000)
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Interaction metrics')

  const turns = Number(process.env.PERF_TURNS ?? 30)
  for (let index = 0; index < turns; index += 1) {
    await sendTurn(page, `Metrics turn ${index}`)
  }

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')

  const scale = await page.evaluate(() => ({
    elements: document.querySelectorAll('*').length,
    items: document.querySelectorAll('[data-slot="message-scroller-item"]').length,
    rows: document.querySelectorAll('[data-testid="tool-chip"]').length,
    chars: document.body.innerText.length
  }))
  console.log(
    `[perf] scale: elements=${scale.elements} items=${scale.items} toolRows=${scale.rows} textChars=${scale.chars}`
  )

  // (a) Scrolling the transcript back — the pure "read an old answer" gesture.
  let before = await readMetrics(cdp)
  for (let step = 0; step < 14; step += 1) {
    await page.evaluate(() => {
      const viewport = document.querySelector('[data-slot="message-scroller-viewport"]')
      if (viewport) viewport.scrollTop = Math.max(0, viewport.scrollTop - 400)
    })
    await page.waitForTimeout(50)
  }
  report('scroll up (14 steps)', before, await readMetrics(cdp))

  // (b) Focus/click separately: opening the composer mounts its toolbar, so it must not be billed to typing.
  before = await readMetrics(cdp)
  await page.getByRole('textbox', { name: 'Ask anything' }).click()
  await page.waitForTimeout(300)
  report('focus the composer', before, await readMetrics(cdp))

  // (c) Per-keystroke cost with nothing else running: 40 characters, one at a time.
  const draft = 'a fairly long draft message typed one character at a time'
  before = await readMetrics(cdp)
  await page.keyboard.type(draft)
  const typingAfter = await readMetrics(cdp)
  report(`typing ${draft.length} chars`, before, typingAfter)
  const typingScript =
    ((typingAfter['ScriptDuration'] ?? 0) - (before['ScriptDuration'] ?? 0)) * 1000
  console.log(
    `[perf] per keystroke: script=${(typingScript / draft.length).toFixed(2)}ms ` +
      `task=${((((typingAfter['TaskDuration'] ?? 0) - (before['TaskDuration'] ?? 0)) * 1000) / draft.length).toFixed(2)}ms`
  )

  // Profile the isolated typing phase so the cost can be attributed to a frame (see the icon-attribution
  // script's sibling analysis): the counters say "X ms per keystroke", the profile says "in what".
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
  await page.keyboard.type('profiled typing pass for attribution', { delay: 20 })
  const { profile } = (await cdp.send('Profiler.stop')) as { profile: unknown }
  await mkdir('test-results/perf', { recursive: true })
  await writeFile('test-results/perf/typing.cpuprofile', JSON.stringify(profile))

  // (d) The real complaint scenario: typing *while* the agent streams.
  const streamDone = sendTurn(page, 'Stream while typing')
  before = await readMetrics(cdp)
  await page.getByRole('textbox', { name: 'Ask anything' }).click()
  await page.keyboard.type('typing while the answer streams in', { delay: 20 })
  report('typing 34 chars during a stream', before, await readMetrics(cdp))
  await streamDone

  // (e) A streaming turn while the transcript is already long.
  before = await readMetrics(cdp)
  await sendTurn(page, 'One more streamed turn')
  report('one streamed turn', before, await readMetrics(cdp))
})
