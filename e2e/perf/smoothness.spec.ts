import { test } from '../fixtures/electron-app'
import { createProject } from '../certification/helpers'
import { expect } from '@playwright/test'
import type { Page } from 'playwright'

// The certification helper waits for a reply by text, which assumes that text is unique in the
// transcript. A perf baseline deliberately repeats the same canned reply, so each turn is awaited by the
// reply count increasing instead.
const sendTurn = async (page: Page, prompt: string): Promise<void> => {
  const replies = page.getByText('Deterministic reply', { exact: false })
  const before = await replies.count()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect.poll(async () => replies.count(), { timeout: 60_000 }).toBeGreaterThan(before)
}

// Smoothness measurement — deliberately NOT in the certification matrix (`npm run test:e2e:p0` runs
// e2e/certification only). Perf numbers on a shared runner vary far too much to gate a release, and a
// flaky perf assertion gets disabled, which is worse than none. Run it against the packaged build and
// compare numbers before/after a change:
//
//   npm run build:e2e && npm run test:e2e:perf
//
// Reported per scenario: the longest blocking task, how many tasks blew the 50ms budget, the p95 frame
// interval while interacting, and IPC round-trip percentiles. Ceilings are catastrophic-only.

// Installed once, then reused: `buffered: true` replays every task since app start into each phase, which
// reports one old task as if it happened in all of them — the first version of this probe did exactly
// that and printed the same "longest=136ms" for four different interactions.
const PROBE = `
  if (!window.__perfInstalled) {
    window.__perfInstalled = true
    window.__perf = { longTasks: [], frames: [] }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__perf.longTasks.push({ start: entry.startTime, duration: entry.duration })
      }
    }).observe({ type: 'longtask' })
    const sample = (time) => {
      window.__perf.frames.push(time)
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }
  window.__perf.longTasks.length = 0
  window.__perf.frames.length = 0
`

type RawProbe = { longTasks: Array<{ start: number; duration: number }>; frames: number[] }

const startProbe = async (page: import('playwright').Page): Promise<void> => {
  await page.evaluate(PROBE)
}

const stopProbe = async (page: import('playwright').Page, label: string): Promise<void> => {
  const raw = (await page.evaluate('window.__perf')) as RawProbe
  const durations = raw.longTasks.map((task) => task.duration).sort((a, b) => b - a)
  const gaps = raw.frames
    .slice(1)
    .map((time, index) => time - raw.frames[index]!)
    .sort((a, b) => a - b)
  const p95 = (values: number[]): number =>
    values.length === 0
      ? 0
      : Math.round(values[Math.min(values.length - 1, Math.floor(values.length * 0.95))]!)

  console.log(
    `[perf] ${label}: longest=${Math.round(durations[0] ?? 0)}ms | >50ms=${durations.filter((d) => d > 50).length} of ${durations.length}` +
      // The max gap is the stall signal that matters: a dropped-frame pileup shows up here even when
      // average cadence looks fine.
      ` | frames=${gaps.length} p95=${p95(gaps)}ms max=${Math.max(...gaps, 0).toFixed(0)}ms`
  )
  // Catastrophic-only ceilings: a hang or a multi-second block is the signal worth failing on.
  expect(durations[0] ?? 0).toBeLessThan(5000)
  expect(p95(gaps)).toBeLessThan(500)
}

const measureIpc = async (page: import('playwright').Page, label: string): Promise<void> => {
  const samples = (await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { projects: { list: () => Promise<unknown> } }
    }
    const timings: number[] = []
    for (let index = 0; index < 12; index += 1) {
      const started = performance.now()
      await bridge.api.projects.list()
      timings.push(performance.now() - started)
    }
    return timings.sort((left, right) => left - right)
  })) as number[]
  const at = (fraction: number): number =>
    Math.round(samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))]!)
  console.log(`[perf] ${label}: project.list p50=${at(0.5)}ms p95=${at(0.95)}ms max=${at(1)}ms`)
}

test('measures smoothness of the interactions a user feels', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Smoothness baseline')

  await measureIpc(page, 'ipc idle')

  // A transcript long enough to matter: each turn is a real render pass over the message list. Raise it
  // with `PERF_TURNS=40 npm run test:e2e:perf` to find where the interaction layer starts to hurt — the
  // baseline above is a small session, which is not where "it feels laggy" would come from.
  const turns = Number(process.env.PERF_TURNS ?? 10)
  await startProbe(page)
  for (let index = 0; index < turns; index += 1) {
    await sendTurn(page, `Baseline turn ${index}`)
  }
  await stopProbe(page, `streaming ${turns} turns`)

  // Typing into the composer with that transcript on screen — the "typing feels laggy" case.
  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await startProbe(page)
  await composer.fill('')
  await composer.pressSequentially('Measuring how long each keystroke takes to land.', {
    delay: 30
  })
  await stopProbe(page, 'typing into the composer')

  // Scrolling the transcript.
  await startProbe(page)
  for (let index = 0; index < 6; index += 1) {
    await page.mouse.wheel(0, 1200)
    await page.waitForTimeout(120)
  }
  await stopProbe(page, 'scrolling the transcript')

  // Opening the command palette (U17) — a keystroke to first paint.
  await startProbe(page)
  const opened = Date.now()
  await page.keyboard.press('Meta+k')
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 })
  console.log(`[perf] palette open: ${Date.now() - opened}ms to visible`)
  await page.keyboard.press('Escape')
  await stopProbe(page, 'command palette')

  // Switching back into the heavy session from the workspace session list (the entry carries a status
  // prefix, so it is matched by its turn name).
  await page
    .getByRole('complementary', { name: 'Workspace navigation' })
    .getByRole('button', { name: 'New' })
    .click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible({
    timeout: 30_000
  })
  const session = page.getByRole('button', { name: /Baseline turn 0/ }).first()
  await startProbe(page)
  const switched = Date.now()
  await session.click()
  await expect(page.getByText('Deterministic reply').first()).toBeVisible({ timeout: 30_000 })
  console.log(`[perf] reopen heavy session: ${Date.now() - switched}ms to visible`)
  await stopProbe(page, 'reopening a heavy session')

  await measureIpc(page, 'ipc after heavy session')
})
