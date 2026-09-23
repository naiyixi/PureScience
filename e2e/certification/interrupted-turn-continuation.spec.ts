import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// Acceptance for Continue: a turn interrupted before it finished is picked up where it stopped, and the
// message that was sent is still the one message. Resume is the other action on the same banner, and it
// sends the message again as a new turn — which is why the banner states the difference in words and why
// this spec counts the message instead of only looking for a reply.
//
// The interruption comes from the fixture, not from killing the app: its interrupted-turn scenario
// streams part of an answer and then never finishes. Measured on a real run, the app marks that session
// interrupted while the turn is still open — status 'error' carrying the app's own interrupted-session
// message, two messages persisted, no restart involved — so no restart is needed here either.

const PROMPT = 'Continue the interrupted turn fixture.'
const CONTINUED_REPLY = 'The interrupted turn continued from where it stopped.'

test.setTimeout(180_000)

// OPEN — not verified on the real machine yet, and here is exactly how far it got.
//
// The interruption itself is real and measured: the fixture streams part of an answer and then never
// finishes, and while that turn is still open the app marks the session interrupted on its own — status
// 'error' carrying the app's own interrupted-session message, two messages persisted, no restart
// involved. (A restart variant was tried first and is NOT the right shape: a turn left open across a
// graceful restart came back with no session at all — sessions.loadAll() returned zero — so there was
// nothing to continue on that path.)
//
// What blocks this spec is starting the app, not continuing a turn. Two measurements so far: while the
// dev daemon (the launchagent, which these runs reload) was up, the app never got past its splash; with
// the daemon unloaded and its processes gone, the window is still closed from underneath the run during
// onboarding ('Target page, context or browser has been closed' raised out of completeOnboarding, with a
// second PureScience instance package-mounted from a disk image running on the machine). Which of those
// is responsible is the next thing to establish; until then the end-to-end half stays unverified and is
// marked as such instead of being reported green.
test.fixme('a turn that was interrupted is continued, not sent again', async ({ app }) => {
  const page = await app.completeOnboarding()
  await app.configureFakeAgent()
  await createProject(page, 'Interrupted turn')

  const conversation = page.getByRole('region', { name: 'Conversation' })
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(conversation.getByText(PROMPT, { exact: true })).toBeVisible()

  // The banner offers both actions, and it says how they differ.
  const hints = page.getByTestId('session-interrupted-hints')
  await expect(hints).toBeVisible({ timeout: 120_000 })
  await expect(hints).toContainText('Continue picks the turn up where it stopped')
  await expect(hints).toContainText('Resume sends this message again as a new turn.')
  await expect(conversation.getByText(PROMPT, { exact: true })).toHaveCount(1)

  const continueButton = page.getByTestId('session-interrupted-continue')
  await expect(continueButton).toBeEnabled()
  await continueButton.click()

  // The same turn continues: the agent answers it, and the message stays a single message.
  await expect(conversation.getByText(CONTINUED_REPLY, { exact: true })).toBeVisible({
    timeout: 90_000
  })
  await expect(conversation.getByText(PROMPT, { exact: true })).toHaveCount(1)
})
