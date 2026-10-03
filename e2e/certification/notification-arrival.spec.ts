import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// Acceptance for IC7 on a real window. The inbox already knew a task had finished — the main process
// records `task.completed` on every terminal agent turn (`src/main/acp/runtime-composition.ts:191-208`) —
// and the bell already rendered `unreadCount`, but nothing subscribed to the inbox at startup: a reader
// saw a badge only after opening the bell by hand, which is the one moment they no longer need telling.
// `App.tsx:314` now subscribes once (`notifications.onChanged` + `getSnapshot`, no new channel).
//
// The assertion is deliberately on the bell's own accessible name, and it never clicks the bell: the
// subscription is what is under test, so a manual refresh must not be what makes the number appear.

test.setTimeout(180_000)

test('the bell lights up on its own when a task finishes', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Notification arrival')

  const bell = page.getByRole('button', { name: /^Messages, / }).first()
  await expect(bell).toBeVisible()
  const before = await bell.getAttribute('aria-label')
  console.log(`[ic7] bell before the turn: ${before}`)
  expect(before).toBe('Messages, no unread messages')

  await sendPrompt(page, 'Create a provenance artifact.', 'Artifact provenance verified for session', 90_000)

  // No click on the bell anywhere above or below: the number appearing is the arrival of the change.
  await expect(bell).toHaveAttribute('aria-label', /Messages, [1-9][0-9]* unread/, { timeout: 30_000 })
  console.log(`[ic7] bell after a finished turn: ${await bell.getAttribute('aria-label')}`)
})
