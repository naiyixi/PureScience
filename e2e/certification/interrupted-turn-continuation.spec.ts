import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// Acceptance for Continue: a turn interrupted by an app restart is picked up where it stopped, and the
// message that was sent is still the one message. Resume is the other action on the same banner, and it
// sends the message again as a new turn — which is why the banner states the difference in words and
// why this spec counts the message instead of only looking for a reply.

const PROMPT = 'Continue the interrupted turn fixture.'
const CONTINUED_REPLY = 'The interrupted turn continued from where it stopped.'

test.setTimeout(180_000)

// OPEN: this spec does not run yet, and the reason is measured rather than assumed.
//
// A restart is graceful here (the fixture calls Electron's own close), and the turn is left genuinely
// open by the fixture (it streams a partial answer, then never finishes). After that restart the app
// has NO session to show: `sessions.loadAll()` returns zero sessions, the home page's Recent sessions
// list is empty, and the banner therefore never appears. So on this path an in-flight turn leaves
// nothing behind to continue — either the flush the renderer answers at shutdown does not run before
// the process goes down, or a session whose turn never completed is never written at all. Which of the
// two it is decides whether Continue is reachable in production; that question is recorded in
// docs/plan-2026-09-23-entry-layer-optimization.md under U13 and is not guessed at here.
//
// The unit suite beside the banner covers the wiring this spec would exercise (Continue is offered,
// states how it differs from Resume, is refused when there is no unfinished turn, and names a
// continuation failure). What is missing is the end-to-end half.
test.fixme('a turn interrupted by a restart is continued, not sent again', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Interrupted turn')

  const conversation = page.getByRole('region', { name: 'Conversation' })
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(conversation.getByText(PROMPT, { exact: true })).toBeVisible()
  // The fixture never answers this one, so the turn is genuinely in flight when the app goes down: it
  // is the app's shutdown, not the fixture, that leaves the session interrupted. While a run is in
  // flight the composer offers Cancel run in place of Send message, which is the signal to wait for.
  await expect(page.getByRole('button', { name: 'Cancel run' })).toBeVisible()

  page = await app.restart()

  // The app comes back on the home page: open the project, then the session inside it, the way a person
  // does. The session row is the one the workspace navigation shows for any session.
  await page
    .getByRole('region', { name: 'Projects' })
    .getByRole('button', { name: 'Interrupted turn', exact: true })
    .click()
  const sessions = page.getByRole('navigation', { name: 'Sessions' })
  await sessions
    .getByRole('button', { name: /Session status/ })
    .first()
    .click()

  // The session comes back interrupted, and the banner offers both actions with the difference stated.
  const hints = page.getByTestId('session-interrupted-hints')
  await expect(hints).toBeVisible({ timeout: 30_000 })
  await expect(hints).toContainText('Continue picks the turn up where it stopped')
  await expect(hints).toContainText('Resume sends this message again as a new turn.')

  const restored = page.getByRole('region', { name: 'Conversation' })
  await expect(restored.getByText(PROMPT, { exact: true })).toHaveCount(1)

  const continueButton = page.getByTestId('session-interrupted-continue')
  await expect(continueButton).toBeEnabled()
  await continueButton.click()

  // The same turn continues: the agent answers it, and the message stays a single message.
  await expect(restored.getByText(CONTINUED_REPLY, { exact: true })).toBeVisible({
    timeout: 60_000
  })
  await expect(restored.getByText(PROMPT, { exact: true })).toHaveCount(1)
})
