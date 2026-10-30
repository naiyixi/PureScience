import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'

// E1 / E2 on a real window — what this machine can actually show, stated as what it is.
//
// Two earlier drafts of this reading were dropped because their assumptions were wrong, and the reason is
// worth keeping: the fixture agent answers with ONE fixed line (it does not echo the prompt), and a live
// transcript carries only the current run's tool activity — two turns therefore produce ONE activity group,
// not the "settled group / newest group" pair the drafts compared. That pair needs a reloaded transcript
// (activities come back from the session document); this spec pins what a live window does show, and does
// not claim the pair.
//
// What it does pin, on a real window:
//   1. a finished turn's tool work is ONE summary row that says how many steps it ran and how long it took;
//   2. the row is folded (its tool rows are not on screen) and pressing it opens them — and pressing again
//      folds them back;
//   3. the row's cost cell says "usage not recorded" for a turn whose provider reported no usage. It never
//      prints a `0`, which would claim a measured cost of nothing.
process.env.PURESCIENCE_E2E_TOOL_EVENTS = '2'

test.setTimeout(300_000)

test.afterAll(() => {
  delete process.env.PURESCIENCE_E2E_TOOL_EVENTS
})

const FIXTURE_REPLY = 'Deterministic reply: Summarize the deterministic fixture.'

const sendTurn = async (page: Page, prompt: string, turn: number): Promise<void> => {
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(FIXTURE_REPLY, { exact: true })).toHaveCount(turn, {
    timeout: 120_000
  })
}

test('a finished turn folds into one summary row that opens, and that row states its cost honestly', async ({
  app
}) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Turn readings on a real window')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  await sendTurn(page, 'First turn for the summary row.', 1)
  // Activities arrive per event, not per turn: let the transcript settle before reading it.
  await page.waitForTimeout(1_500)

  const group = page.locator('[data-testid="tool-group"]').first()
  const header = group.locator('[data-testid="tool-group-header"]')
  await expect(group).toHaveCount(1)

  const summary = (await header.textContent())?.replace(/\s+/g, ' ').trim() ?? ''
  console.log(`[e1-e2] summary row: ${summary}`)
  // 1: the row states what the folded work did.
  expect(summary).toMatch(/\d+ steps?/)
  expect(summary).toMatch(/\d+(ms|s)\b/)

  // 3: the cost cell is a reading, never an invented zero.
  const reading = (
    await group.locator('[data-testid="tool-group-turn-tokens"]').textContent()
  )?.trim()
  console.log(`[e2] cost cell: ${JSON.stringify(reading)}`)
  expect(reading).toBeTruthy()
  expect(reading).not.toMatch(/^0\b/)
  expect(reading).toMatch(/usage not recorded/i)

  // 2: the newest turn stays OPEN (that is the rule: newest or running ⇒ open), and the summary row is a
  // real control — pressing it folds the work away, pressing again brings it back.
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await expect(group.locator('[data-testid="tool-chip"]')).toHaveCount(2)
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(group.locator('[data-testid="tool-chip"]')).toHaveCount(0)
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await expect(group.locator('[data-testid="tool-chip"]')).toHaveCount(2)
  console.log('[e1] newest turn open → folded (0 rows) → open again (2 rows), on a real window')
})
