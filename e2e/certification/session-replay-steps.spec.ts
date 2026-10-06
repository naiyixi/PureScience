import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// IC52 stage 1: the session information card lists the session's own steps — read-only. The steps come
// from the document the app itself wrote (the same document `sessions.readDocument` hands the renderer),
// so a reader walks what really happened rather than a summary of it, and nothing in the section can be
// pressed. This is the true-machine reading for the card's replay section.
//
// Scope, stated honestly: the fixture agent answers with text and records no tool activity, so this reading
// exercises the prompt step and the read-only guard. Tool steps, the "not attached to a prompt" wording and
// the "not known vs nothing" case are covered by the card's render suite (SessionInfoCard.render.test.tsx).
test.setTimeout(240_000)

test("the session card lists the session's own steps, read-only", async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  const prompt = 'Create a table PDF fixture.'
  await createProject(page, 'Replay steps evidence')
  await sendPrompt(page, prompt, 'Table PDF ready for session', 90_000)

  // Sending already put us in that session's workspace. The info card is opened by the session-title
  // button in the header (ConversationPanel), not from the home screen's "Recent sessions" list.
  await page.locator('h1 button').first().click()

  const card = page.locator('[data-slot="session-info-card"]')
  await expect(card).toBeVisible({ timeout: 60_000 })

  const section = card.locator('[data-slot="session-replay-steps"]')
  await expect(section).toBeVisible({ timeout: 30_000 })

  const steps = card.locator('[data-slot="replay-step"]')
  const kinds = await steps.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-replay-step-kind'))
  )
  console.log(`[ic52] the card lists ${kinds.length} step(s): ${JSON.stringify(kinds)}`)

  // The turn's own prompt is the first step: the section is built from the session's record, not invented.
  expect(kinds[0]).toBe('prompt')
  expect(kinds.filter((kind) => kind === 'prompt')).toHaveLength(1)

  // Read-only: nothing in the section can be pressed.
  await expect(section.locator('button, input, select, textarea')).toHaveCount(0)

  // Stage 2: asking about a step. The answer is assembled from that step's own record and every fact names
  // the field it was read from — and a question the record cannot answer is said rather than answered around.
  const ask = card.locator('[data-slot="session-replay-ask"]')
  await expect(ask).toBeVisible({ timeout: 30_000 })
  await ask.locator('select').selectOption({ index: 1 })
  await ask.locator('input').fill('which prompt does this step belong to?')
  await ask.locator('[data-slot="session-replay-ask-submit"]').click()

  const facts = ask.locator('[data-slot="replay-answer-fact"]')
  await expect(facts.first()).toBeVisible({ timeout: 15_000 })
  const answerText = (await facts.first().innerText()).trim()
  console.log(`[ic52] the answer says: "${answerText}"`)
  expect(answerText).toContain('promptMessageId')

  await ask.locator('input').fill('is this statistically significant?')
  await ask.locator('[data-slot="session-replay-ask-submit"]').click()
  await expect(ask.locator('[data-slot="session-replay-ask-unanswered"]')).toBeVisible({
    timeout: 15_000
  })
  console.log('[ic52] a question the step record cannot answer is said, not answered')
})
