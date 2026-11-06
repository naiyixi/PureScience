import { expect } from '@playwright/test'
import { loadavg } from 'node:os'
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
    host.__PURESCIENCE_COMMITS__ = { count: 0, rowsByCommit: new Map(), samples: [], origins: {} }
    host.__PURESCIENCE_SELECTOR__ = { calls: 0, changes: 0 }
    host.__PURESCIENCE_ROW_MOUNTS__ = { count: 0 }
    host.__PURESCIENCE_RENDER_CAUSES__ = {}
    host.__PURESCIENCE_EDIT_FLIPS__ = { renders: 0, flips: 0 }
    host.__PURESCIENCE_ROLE_RENDERS__ = { totals: {}, changes: {} }
    host.__PURESCIENCE_EDIT_INPUTS__ = {}
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
    // Shape of the commits that rendered several rows: a contiguous run means a window boundary is being
    // crossed; scattered ids mean the rows' memo keys themselves are unstable.
    const samples =
      (window as unknown as Record<string, { samples?: Array<{ commit: number; ids: string[] }> }>)
        .__PURESCIENCE_COMMITS__?.samples ?? []
    const domRowCount = document.querySelectorAll('[data-message-id]').length
    const rowIdCount = document.querySelectorAll('[data-row-id]').length
    const uniqueRowIdCount = new Set(
      Array.from(document.querySelectorAll('[data-row-id]')).map((element) =>
        element.getAttribute('data-row-id')
      )
    ).size
    const scrollerItems = document.querySelectorAll('[data-slot="message-scroller-item"]').length
    const uniqueIds = new Set(
      [...document.querySelectorAll('[data-message-id]')].map((el) =>
        el.getAttribute('data-message-id')
      )
    ).size
    const order = [...document.querySelectorAll('[data-message-id]')].map(
      (element) => element.getAttribute('data-message-id') ?? ''
    )
    const indexById = new Map(order.map((id, index) => [id, index]))
    const shapes = samples
      .filter((sample) => sample.ids.length >= 2)
      .map((sample) => {
        const indices = sample.ids
          .map((id) => indexById.get(id))
          .filter((index): index is number => index !== undefined)
          .sort((left, right) => left - right)
        const span = indices.length > 0 ? indices[indices.length - 1] - indices[0] + 1 : 0
        return {
          rows: indices.length,
          span,
          contiguous: span === indices.length,
          tail: order.length - 1 - (indices[indices.length - 1] ?? 0)
        }
      })
    const selector = (
      window as unknown as Record<string, { calls: number; changes: number } | undefined>
    ).__PURESCIENCE_SELECTOR__ ?? { calls: 0, changes: 0 }
    const mounts = (window as unknown as Record<string, { count: number } | undefined>)
      .__PURESCIENCE_ROW_MOUNTS__ ?? { count: 0 }
    const causes =
      (window as unknown as Record<string, Record<string, number> | undefined>)
        .__PURESCIENCE_RENDER_CAUSES__ ?? {}
    const editFlips = (
      window as unknown as Record<string, { renders: number; flips: number } | undefined>
    ).__PURESCIENCE_EDIT_FLIPS__ ?? { renders: 0, flips: 0 }
    const roleRenders = (
      window as unknown as Record<
        string,
        { totals: Record<string, number>; changes: Record<string, number> } | undefined
      >
    ).__PURESCIENCE_ROLE_RENDERS__ ?? { totals: {}, changes: {} }
    const origins =
      (window as unknown as Record<string, { origins?: Record<string, number> } | undefined>)
        .__PURESCIENCE_COMMITS__?.origins ?? {}
    const editInputs =
      (window as unknown as Record<string, Record<string, number> | undefined>)
        .__PURESCIENCE_EDIT_INPUTS__ ?? {}
    const reasons =
      (window as unknown as Record<string, Record<string, number> | undefined>)
        .__PURESCIENCE_RENDER_REASONS__ ?? {}
    const counts = Object.entries(renders)
      .filter(([key]) => key !== '__scroller__')
      .map(([, count]) => count)
    const sorted = [...counts].sort((left, right) => right - left)
    // Which rows carry the cost: a handful of ids with hundreds of renders each is a different problem from
    // every row rendering a few times.
    const topRows = Object.entries(renders)
      .filter(([key]) => key !== '__scroller__')
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([id, count]) => `${id}=${count}`)
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
      rowMounts: mounts.count,
      topRows,
      causes,
      editFlips,
      roleRenders,
      origins,
      editInputs,
      domRowCount,
      rowIdCount,
      uniqueRowIdCount,
      scrollerItems,
      uniqueIds,
      selectorCalls: selector.calls,
      selectorChanges: selector.changes,
      shapes,
      sampleCount: samples.length,
      sampleSizes: samples.slice(-5).map((sample) => sample.ids.length),
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
  {
    const contiguous = readings.shapes.filter((shape) => shape.contiguous).length
    const rows = readings.shapes.map((shape) => shape.rows)
    const spans = readings.shapes.map((shape) => shape.span)
    const tails = readings.shapes.map((shape) => shape.tail)
    const avg = (values: number[]): string =>
      values.length > 0 ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1) : 'n/a'
    console.log(
      `[commit-shape] sampled=${readings.shapes.length} contiguous=${contiguous}` +
        ` rows avg=${avg(rows)} span avg=${avg(spans)}` +
        ` distanceFromLastRow avg=${avg(tails)} rowsInDom=${readings.rows}` +
        ` | samples=${readings.sampleCount} sizes=${readings.sampleSizes.join(',')}`
    )
  }
  console.log(
    `[causes] ${Object.entries(readings.causes)
      .map(([key, count]) => `${key}=${count}`)
      .join(' ')}`
  )
  console.log(
    `[origins] ${Object.entries(readings.origins)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([label, count]) => `${label}=${count}`)
      .join(' | ')}`
  )
  console.log(
    `[edit-inputs] ${Object.entries(readings.editInputs)
      .sort((left, right) => right[1] - left[1])
      .map(([key, count]) => `${key}=${count}`)
      .join(' | ')}`
  )
  console.log(
    `[roles] totals=${JSON.stringify(readings.roleRenders.totals)}` +
      ` changes=${JSON.stringify(readings.roleRenders.changes)}`
  )
  console.log(
    `[edit-flips] provider renders=${readings.editFlips.renders} flips=${readings.editFlips.flips}`
  )
  console.log(
    `[dom] row-ids=${readings.rowIdCount} unique-rows=${readings.uniqueRowIdCount}` +
      ` message-ids=${readings.domRowCount} unique=${readings.uniqueIds}` +
      ` scroller-items=${readings.scrollerItems} counted-rows=${readings.rows}`
  )
  console.log(`[hot-rows] top: ${readings.topRows.join(' ')}`)
  console.log(
    `[mounts] ${turns} turns: mounts=${readings.rowMounts} (${(readings.rowMounts / turns).toFixed(1)}/turn)` +
      ` rows=${readings.rows} renders=${readings.total}` +
      ` rendersPerMount=${readings.rowMounts > 0 ? (readings.total / readings.rowMounts).toFixed(2) : 'n/a'}`
  )
  console.log(
    `[selector] ${turns} turns: calls=${readings.selectorCalls}` +
      ` (${(readings.selectorCalls / turns).toFixed(1)}/turn) changes=${readings.selectorChanges}` +
      ` (${(readings.selectorChanges / turns).toFixed(2)}/turn)` +
      ` ratio=${readings.selectorCalls > 0 ? (readings.selectorChanges / readings.selectorCalls).toFixed(3) : 'n/a'}`
  )
  console.log(
    `[render-reason] ${Object.entries(readings.reasons)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(' ')}`
  )
  // Budget assertions. These are counts, not durations, so they mean the same thing on a loaded laptop and on a
  // CI runner — which is why this spec can gate a nightly while the wall-clock perf spec cannot. Limits are set
  // roughly 3x above the current readings: tight enough to catch a regression that re-broadcasts a value into
  // every row (that mistake was 5.67 rows/commit and 18.4 commits/turn), loose enough not to flake.
  const budget = {
    rowsRenderedPerCommit: 1,
    commitsPerTurn: 20,
    rowRendersPerTurn: 5,
    maxRendersPerRow: 10
  }
  const measured = {
    rowsRenderedPerCommit: readings.rowsRenderedPerCommit,
    commitsPerTurn: readings.commits / turns,
    rowRendersPerTurn: readings.total / turns,
    maxRendersPerRow: readings.max
  }
  const overBudget = Object.entries(budget).filter(
    ([key, limit]) => measured[key as keyof typeof measured] > limit
  )
  console.log(
    `[budget] ${Object.entries(measured)
      .map(
        ([key, value]) =>
          `${key}=${value.toFixed(2)}/${budget[key as keyof typeof budget].toFixed(2)}`
      )
      .join(
        ' '
      )} | ${overBudget.length === 0 ? 'within budget' : `OVER: ${overBudget.map(([key]) => key).join(',')}`}`
  )
  expect(
    overBudget,
    `per-row render budget exceeded: ${overBudget.map(([k]) => k).join(',')}`
  ).toEqual([])

  console.log(
    `[chunks] ${turns} turns: total=${readings.chunks} (${(readings.chunks / turns).toFixed(1)}/turn)` +
      ` committed=${readings.chunksCommitted} | row renders per chunk: ` +
      `${readings.chunks > 0 ? (readings.total / readings.chunks).toFixed(2) : 'n/a'}`
  )

  // One more turn, measured with CDP counters instead of a stopwatch. `LayoutCount` / `RecalcStyleCount`
  // are counts: the host's load changes how LONG each one takes, not how many happen, so two runs at
  // different transcript lengths can be compared even on a busy machine. Wall clock is printed too, but
  // only as context — the same spec has produced 57 and 189 ms/turn for identical code on different days.
  // This is the reading that says whether a commit's *structural* cost grows with the transcript.
  const turnCdp = await page.context().newCDPSession(page)
  await turnCdp.send('Performance.enable')
  const readCounters = async (): Promise<Record<string, number>> => {
    const { metrics } = await turnCdp.send('Performance.getMetrics')
    const map: Record<string, number> = {}
    for (const metric of metrics) map[metric.name] = metric.value
    return map
  }
  const beforeTurn = await readCounters()
  await sendTurn(page, 'Measured turn')
  const afterTurn = await readCounters()
  const counter = (key: string): number => (afterTurn[key] ?? 0) - (beforeTurn[key] ?? 0)
  const load = loadavg()
    .map((value) => value.toFixed(2))
    .join(' / ')
  console.log(
    `[turn-cost] ${turns} turns + 1 measured turn: LayoutCount=${counter('LayoutCount')}` +
      ` RecalcStyleCount=${counter('RecalcStyleCount')}` +
      ` LayoutDuration=${(counter('LayoutDuration') * 1000).toFixed(0)}ms` +
      ` RecalcStyleDuration=${(counter('RecalcStyleDuration') * 1000).toFixed(0)}ms` +
      ` TaskDuration=${(counter('TaskDuration') * 1000).toFixed(0)}ms` +
      ` ScriptDuration=${(counter('ScriptDuration') * 1000).toFixed(0)}ms` +
      ` NodesNet=${counter('Nodes')} | host load ${load}`
  )

  expect(readings.rows).toBeGreaterThan(0)
})
