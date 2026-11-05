import { test } from '../fixtures/electron-app'
import { createProject } from '../certification/helpers'
import type { Locator, Page } from 'playwright'

// Diagnostic, deliberately NOT in any gate: it answers "is the render-window and content-visibility
// optimisation actually reaching the DOM in a long transcript?" — the question behind the 160-turn cost
// profile, where layout/paint (`(program)`) became the largest per-turn term.
//
//   npm run build:e2e && PERF_TURNS=160 PERF_WAIT=selector npx playwright test e2e/perf/content-visibility.spec.ts
//
// It reports, for the transcript as it stands after the last turn:
//   - how many message bodies the DOM holds vs how many the session has
//   - how many of those report `content-visibility: auto` and how many are currently skipped
//   - the transcript's scroll height and the tallest single row
// A number that disagrees with the render window means the optimisation is not active; a scroll height
// that dwarfs the viewport means layout cost is structural, not a missing CSS hint.

const composerInput = (page: Page): Locator => page.locator('[data-perf="composer-input"]')
const composerSend = (page: Page): Locator => page.locator('[data-perf="composer-send"]').first()

const sendTurn = async (page: Page, prompt: string): Promise<void> => {
  const before = await page.evaluate(
    () => document.querySelectorAll('[data-slot="assistant-message-body"]').length
  )
  await composerInput(page).fill(prompt)
  await composerSend(page).click()
  await page.waitForFunction(
    (expected) =>
      document.querySelectorAll('[data-slot="assistant-message-body"]').length > expected,
    before,
    { timeout: 60_000, polling: 200 }
  )
}

test('reports whether render windowing and content-visibility reach a long transcript', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Content visibility probe')
  await page.bringToFront()

  const turns = Number(process.env.PERF_TURNS ?? 20)
  for (let index = 0; index < turns; index += 1) {
    await sendTurn(page, `Turn ${index}: summarize the reprocessing protocol.`)
  }

  const report = await page.evaluate(() => {
    const bodies = [...document.querySelectorAll('[data-slot="assistant-message-body"]')]
    const rows = [...document.querySelectorAll('[data-slot="message-scroller-item"]')]
    // Walk one settled assistant row up to the transcript container so the report names the elements that
    // actually carry the optimisation instead of guessing at selectors.
    const ancestry: string[] = []
    const probe = bodies[0]
    let cursor: Element | null = probe ?? null
    while (cursor && ancestry.length < 8) {
      const style = getComputedStyle(cursor)
      ancestry.push(
        `${cursor.tagName.toLowerCase()}[data-slot=${cursor.getAttribute('data-slot') ?? '-'}]` +
          `{cv:${style.contentVisibility},h:${Math.round(cursor.getBoundingClientRect().height)}}`
      )
      cursor = cursor.parentElement
    }
    const autoNodes = [...document.querySelectorAll('*')].filter(
      (node) => getComputedStyle(node).contentVisibility === 'auto'
    )
    const scrollerNode = [...document.querySelectorAll('*')].find((node) =>
      node.className?.toString().includes('message-scroller')
    ) as HTMLElement | undefined

    const computedAuto = bodies.filter(
      (node) => getComputedStyle(node).contentVisibility === 'auto'
    ).length
    const skipped = bodies.filter((node) => {
      const card = node.closest('[data-slot="message-scroller-item"]') ?? node.parentElement
      if (!card) return false
      const style = getComputedStyle(card)
      return (
        style.contentVisibility === 'auto' &&
        typeof card.checkVisibility === 'function' &&
        !card.checkVisibility({ contentVisibilityAuto: true })
      )
    }).length
    return {
      bodies: bodies.length,
      rows: rows.length,
      domNodes: document.querySelectorAll('*').length,
      bodiesWithContentVisibilityAuto: computedAuto,
      bodiesCurrentlySkipped: skipped,
      ancestry,
      nodesWithContentVisibilityAuto: autoNodes.length,
      transcriptScrollHeight: scrollerNode ? scrollerNode.scrollHeight : null,
      scrollerClass: scrollerNode ? String(scrollerNode.className).slice(0, 120) : null,
      viewportHeight: window.innerHeight,
      tallestRow: rows.reduce(
        (tallest, row) => Math.max(tallest, (row as HTMLElement).getBoundingClientRect().height),
        0
      )
    }
  })

  console.log(`[cv] turns=${turns} ${JSON.stringify(report)}`)
  test.info().annotations.push({ type: 'content-visibility', description: JSON.stringify(report) })
})
