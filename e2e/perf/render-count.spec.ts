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

// CSS hooks + structural wait, same as the smoothness baseline: a text/role locator re-resolves an
// accessible name over the whole document on every poll, and that work lands inside the window these
// counters describe.
const sendTurn = async (page: Page, prompt: string): Promise<void> => {
  const before = await page.evaluate(
    () => document.querySelectorAll('[data-slot="assistant-message-body"]').length
  )
  await page.locator('[data-perf="composer-input"]').fill(prompt)
  await page.locator('[data-perf="composer-send"]').first().click()
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll('[data-slot="assistant-message-body"]').length > expected,
    before,
    { timeout: 60_000, polling: 200 }
  )
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
    const host = window as unknown as Record<string, unknown>
    host.__PURESCIENCE_RENDER_COUNTS__ = {}
    host.__PURESCIENCE_PROP_CHURN__ = {}
    host.__PURESCIENCE_MARKDOWN_RENDERS__ = { count: 0, chars: 0 }
    host.__PURESCIENCE_STREAM_CHUNKS__ = { total: 0, committed: 0, chars: 0 }
    host.__PURESCIENCE_RENDER_REASONS__ = { first: 0, content: 0, status: 0, other: 0 }
    host.__PURESCIENCE_COMMITS__ = { count: 0, rowsByCommit: new Map() }
    host.__PURESCIENCE_RENDER_AT_COMMIT__ = { sameCommit: 0, afterCommit: 0 }
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

    const markdown = (
      window as unknown as Record<string, { count: number; chars: number } | undefined>
    ).__PURESCIENCE_MARKDOWN_RENDERS__ ?? { count: 0, chars: 0 }

    const chunks = (
      window as unknown as Record<
        string,
        { total: number; committed: number; chars: number } | undefined
      >
    ).__PURESCIENCE_STREAM_CHUNKS__ ?? { total: 0, committed: 0, chars: 0 }

    // Separated out so a high row count can be attributed: if the scroller renders as often as its rows,
    // the cause is above the row; if the scroller renders once and one row renders hundreds of times, the
    // cause is inside the row's own subscriptions.
    const scrollerRenders = renders.__scroller__ ?? 0
    const commits = (
      window as unknown as Record<
        string,
        { count: number; rowsByCommit: Map<number, number> } | undefined
      >
    ).__PURESCIENCE_COMMITS__ ?? { count: 0, rowsByCommit: new Map<number, number>() }
    const commitRows = [...commits.rowsByCommit.values()]
    const sameCommit =
      (window as unknown as Record<string, { sameCommit: number } | undefined>)
        .__PURESCIENCE_RENDER_AT_COMMIT__?.sameCommit ?? 0
    const reasons =
      (window as unknown as Record<string, Record<string, number> | undefined>)
        .__PURESCIENCE_RENDER_REASONS__ ?? {}
    const counts = Object.entries(renders)
      .filter(([key]) => key !== '__scroller__')
      .map(([, count]) => count)
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
      markdownRenders: markdown.count,
      scrollerRenders,
      reasons,
      commits: commits.count,
      maxRowsPerCommit: commitRows.length > 0 ? Math.max(...commitRows) : 0,
      rowsRenderedPerCommit:
        commitRows.length > 0 ? commitRows.reduce((a, b) => a + b, 0) / commitRows.length : 0,
      sameCommitRenders: sameCommit,
      chunks: chunks.total,
      chunksCommitted: chunks.committed,
      markdownChars: markdown.chars,
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

  // Parsing is the expensive half of a remount and is invisible to a row-render count, so it gets its own
  // line: renders/turn ≈ 1 means one parse per chunk, more than that means the render window (or a
  // remount) is re-parsing text that did not change.
  console.log(
    `[markdown] ${turns} turns: renders=${readings.markdownRenders}` +
      ` (${(readings.markdownRenders / turns).toFixed(1)}/turn)` +
      ` chars=${readings.markdownChars} (${Math.round(readings.markdownChars / turns)}/turn)`
  )

  // The ratio that makes the row-render number meaningful: one render per chunk means the cost *is* the
  // chunk rate; several renders per chunk is a bug in the row, not a property of the session length.
  console.log(`[render-count] scroller renders: ${readings.scrollerRenders}`)
  console.log(
    `[commits] ${turns} turns: commits=${readings.commits} (${(readings.commits / turns).toFixed(1)}/turn)` +
      ` rows/commit avg=${readings.rowsRenderedPerCommit.toFixed(2)} max=${readings.maxRowsPerCommit}` +
      ` | renders with no new commit: ${readings.sameCommitRenders}`
  )
  console.log(
    `[render-reason] ${Object.entries(readings.reasons)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(' ')}`
  )
  console.log(
    `[chunks] ${turns} turns: total=${readings.chunks} (${(readings.chunks / turns).toFixed(1)}/turn)` +
      ` committed=${readings.chunksCommitted} | row renders per chunk: ` +
      `${readings.chunks > 0 ? (readings.total / readings.chunks).toFixed(2) : 'n/a'}`
  )

  expect(readings.rows).toBeGreaterThan(0)
})
