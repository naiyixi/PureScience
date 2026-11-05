import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { createProject } from '../certification/helpers'
import { test as appTest } from '../fixtures/electron-app'

// HOW MANY TIMES DOES EACH ROW RENDER — a regression guard for the transcript rendering contract,
// not a gate. `docs/plan-2026-11-05-transcript-render-architecture.md` §五 aims at "a settled row does
// not re-render when a chunk arrives"; that claim can only be judged by counting renders, and every
// earlier attempt to reason about it (props identity, mutation batches, content-visibility) ended in a
// wrong conclusion. Two tables come out of one run:
//
//   renders  — per row, over PERF_TURNS turns. Median ≈ chunks-per-turn means the whole transcript
//              re-renders per chunk; median ≈ 1–2 means only boundary work remints a row.
//   churn    — which slot-props dependency changed (index into the tuple literal in
//              WorkspaceMessageScroller), so a regression names the prop.
//
//   npm run build:e2e && PERF_TURNS=40 npx playwright test e2e/perf/render-count.spec.ts --reporter=line
//
// Recorded baseline (2026-11-05, 40 turns, before the subscription work): rows=82 total=17672
// median=226 max=402; churn 16=3280 4=1680 6=1640 0=40 2=40.

const sendTurn = async (page: Page, prompt: string): Promise<void> => {
  const replies = page.getByText('Deterministic reply', { exact: false })
  const before = await replies.count()
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect.poll(async () => replies.count(), { timeout: 60_000 }).toBeGreaterThan(before)
}

appTest('counts transcript row renders and props churn', async ({ app }) => {
  appTest.setTimeout(240_000)
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Render counts')
  await page.bringToFront()

  const turns = Number(process.env.PERF_TURNS ?? 10)
  await sendTurn(page, 'Warm-up turn')

  await page.evaluate(() => {
    ;(window as unknown as Record<string, unknown>).__PURESCIENCE_RENDER_COUNTS__ = {}
    ;(window as unknown as Record<string, unknown>).__PURESCIENCE_PROP_CHURN__ = {}
  })

  for (let index = 0; index < turns; index += 1) {
    await sendTurn(page, `Counted turn ${index}`)
  }

  const readings = await page.evaluate(() => {
    const renders =
      (window as unknown as Record<string, Record<string, number> | undefined>)
        .__PURESCIENCE_RENDER_COUNTS__ ?? {}
    const churn =
      (window as unknown as Record<string, Record<string, Record<number, number>> | undefined>)
        .__PURESCIENCE_PROP_CHURN__ ?? {}

    const counts = Object.values(renders)
    const sorted = [...counts].sort((left, right) => right - left)
    const churnTotals: Record<number, number> = {}
    for (const bucket of Object.values(churn)) {
      for (const [index, count] of Object.entries(bucket)) {
        churnTotals[Number(index)] = (churnTotals[Number(index)] ?? 0) + count
      }
    }
    return {
      rows: counts.length,
      total: counts.reduce((sum, count) => sum + count, 0),
      median: sorted[Math.floor(sorted.length / 2)] ?? 0,
      max: sorted[0] ?? 0,
      churn: Object.entries(churnTotals)
        .map(([index, count]) => ({ index: Number(index), count }))
        .sort((left, right) => right.count - left.count)
    }
  })

  console.log(
    `[render-count] ${turns} turns: rows=${readings.rows} total=${readings.total}` +
      ` median=${readings.median} max=${readings.max}`
  )
  console.log(
    `[render-count] props churn by tuple index: ${
      readings.churn.map((entry) => `${entry.index}=${entry.count}`).join(' ') || '(none)'
    }`
  )

  expect(readings.rows).toBeGreaterThan(0)
})
