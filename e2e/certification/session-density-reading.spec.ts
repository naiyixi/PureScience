import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'

// Reading: does the transcript actually fit more conversation on one screen?
//
// "Feels smoother / reads better" is not measurable, but the thing that causes it is: how many pixels a
// finished turn occupies. This walks four real turns with tool activity, then reports — in pixels — the
// height of the transcript, the height of one folded summary row, and how many turns fit in the viewport.
// Run it on two builds (before / after a layout change) and the difference is the claim.
process.env.PURESCIENCE_E2E_TOOL_EVENTS = '2'

test.setTimeout(600_000)

test.afterAll(() => {
  delete process.env.PURESCIENCE_E2E_TOOL_EVENTS
})

const FIXTURE_REPLY = 'Deterministic reply: Summarize the deterministic fixture.'
const TURNS = 4

const sendTurn = async (page: Page, prompt: string, turn: number): Promise<void> => {
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(FIXTURE_REPLY, { exact: true })).toHaveCount(turn, {
    timeout: 120_000
  })
}

test('measures how much conversation one screen holds', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Density reading')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  for (let turn = 1; turn <= TURNS; turn += 1) await sendTurn(page, `Turn ${turn}.`, turn)
  await page.waitForTimeout(2_000)

  const reading = await page.evaluate((turns) => {
    const scroller = document.querySelector('[data-slot="message-scroller"], main')
    const viewport = scroller?.clientHeight ?? window.innerHeight
    const groups = Array.from(document.querySelectorAll('[data-testid="tool-group"]'))
    const rows = groups.map((group) => {
      const header = group.querySelector('[data-testid="tool-group-header"]') as HTMLElement | null
      return Math.round(header?.getBoundingClientRect().height ?? 0)
    })
    // The last reply is the end of the transcript; everything above it is what a reader scrolls through.
    const lastReply = Array.from(
      document.querySelectorAll('[data-slot="assistant-message-footer"]')
    ).pop() as HTMLElement | undefined
    const transcriptHeight = lastReply
      ? Math.round(
          lastReply.getBoundingClientRect().bottom - (scroller?.getBoundingClientRect().top ?? 0)
        )
      : 0
    return {
      viewport,
      transcriptHeight,
      perTurn: transcriptHeight > 0 ? Math.round(transcriptHeight / turns) : 0,
      summaryRows: rows,
      groups: groups.length
    }
  }, TURNS)

  console.log(`[density] ${JSON.stringify(reading)}`)
  expect(reading.groups).toBeGreaterThanOrEqual(1)
  expect(reading.perTurn).toBeGreaterThan(0)
})
