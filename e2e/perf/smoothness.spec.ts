import { test } from '../fixtures/electron-app'
import { createProject } from '../certification/helpers'
import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import {
  describeFrameMetric,
  percentile,
  summarizeFrameCadence,
  type FrameCadenceSummary
} from '../../src/shared/perf-frame-cadence'

// The certification helper waits for a reply by text, which assumes that text is unique in the
// transcript. A perf baseline deliberately repeats the same canned reply, so each turn is awaited by the
// reply count increasing instead.
// PERF_WAIT=selector swaps the text-locator poll for a structural wait. The default wait re-resolves a
// text locator over the whole document every ~100ms while the reply streams; that work lands on the
// renderer's main thread and therefore inside the very measurement it is waiting on, and it grows with
// transcript length. The structural wait only counts nodes matching a data-slot, which isolates app cost
// from harness cost — the two modes exist so the difference can be measured instead of assumed.
// CSS hooks, not role/name lookups: resolving an accessible name walks the whole document, and in a long
// transcript that walk costs more than the work being measured. The role-based locators stay the real-user
// path and are exercised by the functional e2e suite.
const composerInput = (page: Page): Locator => page.locator('[data-perf="composer-input"]')
const composerSend = (page: Page): Locator => page.locator('[data-perf="composer-send"]').first()

const sendTurn = async (page: Page, prompt: string): Promise<void> => {
  const structuralWait = process.env.PERF_WAIT === 'selector'
  const replies = page.getByText('Deterministic reply', { exact: false })
  const bodies = (): Promise<number> =>
    page.evaluate(() => document.querySelectorAll('[data-slot="assistant-message-body"]').length)

  const before = structuralWait ? await bodies() : await replies.count()
  await composerInput(page).fill(prompt)
  await composerSend(page).click()
  if (structuralWait) {
    await page.waitForFunction(
      (expected) =>
        document.querySelectorAll('[data-slot="assistant-message-body"]').length > expected,
      before,
      { timeout: 60_000, polling: 200 }
    )
    return
  }
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
    window.__perf = { longTasks: [], frames: [], batches: 0 }
    // React commits show up as DOM mutation batches: one commit usually produces one batch callback. The
    // ratio against frame count is what says whether the transcript re-renders per delta or per frame.
    const mutations = new MutationObserver(() => {
      window.__perf.batches += 1
    })
    mutations.observe(document.body, { subtree: true, characterData: true, childList: true })
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
  window.__perf.batches = 0
`

type RawProbe = {
  longTasks: Array<{ start: number; duration: number }>
  frames: number[]
  batches: number
}

const startProbe = async (page: import('playwright').Page): Promise<void> => {
  await page.evaluate(PROBE)
}

/**
 * The harness measures its own cadence before it measures the app. macOS throttles
 * `requestAnimationFrame` to roughly 12 Hz while a window is occluded or not foreground, which floors every
 * frame reading near 80 ms — the reading then describes the window manager, not the product. Calibrating
 * first turns that into a named "no reading" instead of a number nobody can act on.
 */
const calibrateInstrument = async (page: Page): Promise<FrameCadenceSummary> => {
  const gaps = (await page.evaluate(async () => {
    const ticks: number[] = []
    await new Promise<void>((resolve) => {
      const started = performance.now()
      const sample = (time: number): void => {
        ticks.push(time)
        if (time - started < 750) requestAnimationFrame(sample)
        else resolve()
      }
      requestAnimationFrame(sample)
    })
    return ticks.slice(1).map((time, index) => time - ticks[index]!)
  })) as number[]
  return summarizeFrameCadence(gaps)
}

const stopProbe = async (
  page: import('playwright').Page,
  label: string,
  instrument: FrameCadenceSummary
): Promise<{ gapsMs: number[] }> => {
  const raw = (await page.evaluate('window.__perf')) as RawProbe
  const durations = raw.longTasks.map((task) => task.duration).sort((a, b) => b - a)
  const gaps = raw.frames
    .slice(1)
    .map((time, index) => time - raw.frames[index]!)
    .sort((a, b) => a - b)
  const p95 = percentile(gaps, 0.95)

  console.log(
    `[perf] ${label}: longest=${Math.round(durations[0] ?? 0)}ms | >50ms=${durations.filter((d) => d > 50).length} of ${durations.length}` +
      // The max gap is the stall signal that matters: a dropped-frame pileup shows up here even when
      // average cadence looks fine. Percentiles are withheld when the phase was too short to support them.
      ` | ${describeFrameMetric(instrument, { frames: gaps.length, p95Ms: p95, maxMs: Math.max(...gaps, 0) })}`
  )
  console.log(
    `[perf] ${label}: mutation batches≈${raw.batches} commits over frames=${raw.frames.length}` +
      ` | per frame: ${(raw.batches / Math.max(raw.frames.length, 1)).toFixed(2)}`
  )
  // Catastrophic-only ceilings: a hang or a multi-second block is the signal worth failing on. The frame
  // ceiling only means something while the window is producing frames at a usable cadence — asserting it on
  // a throttled instrument would fail a release for the desk arrangement.
  expect(durations[0] ?? 0).toBeLessThan(5000)
  if (instrument.verdict === 'usable' && p95 !== null) expect(p95).toBeLessThan(500)
  return { gapsMs: gaps }
}

const measureIpc = async (page: import('playwright').Page, label: string): Promise<void> => {
  const samples = (await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { projects: { list: () => Promise<unknown> } }
    }
    const timings: number[] = []
    // 30 round trips: the previous 12 could not support a p95 at all, so its "p95" was the maximum.
    for (let index = 0; index < 30; index += 1) {
      const started = performance.now()
      await bridge.api.projects.list()
      timings.push(performance.now() - started)
    }
    return timings.sort((left, right) => left - right)
  })) as number[]
  const show = (value: number | null): string => (value === null ? 'n/a' : `${Math.round(value)}ms`)
  console.log(
    `[perf] ${label}: project.list n=${samples.length} p50=${show(percentile(samples, 0.5))}` +
      ` p95=${show(percentile(samples, 0.95))} max=${show(samples[samples.length - 1] ?? null)}`
  )
}

test('measures smoothness of the interactions a user feels', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Smoothness baseline')

  // A measurement taken while the window sits behind another app measures the window manager, so raise it
  // first and then establish the cadence this run can actually produce.
  await page.bringToFront()
  const instrument = await calibrateInstrument(page)
  test.info().annotations.push({ type: 'perf-instrument', description: instrument.detail })
  console.log(`[perf] instrument: ${instrument.verdict} — ${instrument.detail}`)

  await measureIpc(page, 'ipc idle')

  // A transcript long enough to matter: each turn is a real render pass over the message list. Raise it
  // with `PERF_TURNS=40 npm run test:e2e:perf` to find where the interaction layer starts to hurt — the
  // baseline above is a small session, which is not where "it feels laggy" would come from.
  const turns = Number(process.env.PERF_TURNS ?? 10)
  // Aggregate main-thread work, which the long-task probe cannot see: a streamed chunk does a little work
  // in every slot it touches, and none of those tasks crosses the 50ms threshold. CDP's Performance
  // counters accumulate per process (no threshold), so the delta across the streaming phase is the total
  // work the transcript burned — the quantity that grows with session length. Accumulating totals need one
  // session with metrics enabled once; the counters are read from that same session.
  const perfSession = await page.context().newCDPSession(page)
  await perfSession.send('Performance.enable')
  const readClock = async (): Promise<{ taskMs: number; scriptMs: number }> => {
    const { metrics } = await perfSession.send('Performance.getMetrics')
    const seconds = (name: string): number =>
      (metrics.find((metric) => metric.name === name)?.value ?? 0) * 1000
    return { taskMs: seconds('TaskDuration'), scriptMs: seconds('ScriptDuration') }
  }
  const beforeStream = await readClock()
  await startProbe(page)
  for (let index = 0; index < turns; index += 1) {
    await sendTurn(page, `Baseline turn ${index}`)
  }
  await stopProbe(page, `streaming ${turns} turns`, instrument)
  const afterStream = await readClock()
  const taskDelta = afterStream.taskMs - beforeStream.taskMs
  const scriptDelta = afterStream.scriptMs - beforeStream.scriptMs
  console.log(
    `[perf] streaming ${turns} turns main thread: task=${Math.round(taskDelta)}ms script=${Math.round(scriptDelta)}ms` +
      ` | per turn: task=${(taskDelta / turns).toFixed(1)}ms script=${(scriptDelta / turns).toFixed(1)}ms`
  )

  // Typing into the composer with that transcript on screen — the "typing feels laggy" case.
  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await startProbe(page)
  await composer.fill('')
  await composer.pressSequentially('Measuring how long each keystroke takes to land.', {
    delay: 30
  })
  await stopProbe(page, 'typing into the composer', instrument)

  // Scrolling the transcript. Six wheel steps produced 37 frames in the baseline, and a nearest-rank p95 of
  // 37 samples sits within a hair of the maximum — the reading could not be told apart from one stall. Three
  // down/up sweeps at 60 ms per step run for ~3.6 s, which is what a percentile needs (>=200 frames), and
  // p50 is printed as well: the budget this scenario is judged against is the median, not the tail.
  await startProbe(page)
  for (let round = 0; round < 3; round += 1) {
    for (const direction of [1, -1]) {
      for (let step = 0; step < 10; step += 1) {
        await page.mouse.wheel(0, direction * 1200)
        await page.waitForTimeout(60)
      }
    }
  }
  const scroll = await stopProbe(page, 'scrolling the transcript', instrument)
  const scrollP50 = percentile(scroll.gapsMs, 0.5)
  console.log(
    `[perf] scrolling the transcript: p50=${scrollP50 === null ? 'n/a' : `${Math.round(scrollP50)}ms`}` +
      ` over ${scroll.gapsMs.length} frames (one frame at 60 Hz = 16.7ms)`
  )

  // Opening the command palette (U17) — a keystroke to first paint.
  await startProbe(page)
  const opened = Date.now()
  await page.keyboard.press('Meta+k')
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 })
  console.log(`[perf] palette open: ${Date.now() - opened}ms to visible`)
  await page.keyboard.press('Escape')
  await stopProbe(page, 'command palette', instrument)

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
  await stopProbe(page, 'reopening a heavy session', instrument)

  await measureIpc(page, 'ipc after heavy session')
})
