import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

const PROMPT = 'Continue the interrupted turn fixture.'
const CONTINUED_REPLY = 'The interrupted turn continued from where it stopped.'

// Acceptance for Continue: a turn interrupted before it finished is picked up where it stopped, and the
// message that was sent is still the one message. Resume is the other action on the same banner, and it
// sends the message again as a new turn — which is why the banner states the difference in words and why
// this spec counts the message instead of only looking for a reply.
//
// OPEN — not verified on the real machine yet. What has been measured, and what had to be retracted:
//
//   * The banner needs the app to consider the turn interrupted. A turn left open by the fixture (it
//     streams part of an answer, then never finishes) does NOT become interrupted while the app runs:
//     after 120s the session still reads "Session status: Running". So the no-restart shape this spec
//     first tried cannot reach the banner at all.
//   * An earlier restart-shaped attempt reported that a restart leaves no session behind (zero from
//     sessions.loadAll()). That measurement is VOID: it was taken with the window bug below, so the app
//     had closed underneath the run and the answer came from a dead instance. It must be taken again.
//   * The window bug, which is fixed here: completeOnboarding() and configureFakeAgent() each hand back
//     the window they leave behind, and the first attempt kept holding the one from before the reload.
//     Every run then died inside onboarding with 'Target page, context or browser has been closed', while
//     a neighbouring spec that reassigns both passes in 13s. The helpers' return values are used below.
//
// So the shape to establish is: the turn is left open, the app is restarted (which is when a session with
// an unfinished turn is restored as interrupted), the session is opened, and Continue is expected to hand
// the same turn back to the agent without producing a second copy of the message.
test.fixme('a turn that was interrupted is continued, not sent again', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Interrupted turn')

  const conversation = page.getByRole('region', { name: 'Conversation' })
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(conversation.getByText(PROMPT, { exact: true })).toBeVisible()
  // While the turn is in flight the composer offers Cancel run in place of Send message.
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
  await expect(hints).toBeVisible({ timeout: 60_000 })
  await expect(hints).toContainText('Continue picks the turn up where it stopped')
  await expect(hints).toContainText('Resume sends this message again as a new turn.')

  const restored = page.getByRole('region', { name: 'Conversation' })
  await expect(restored.getByText(PROMPT, { exact: true })).toHaveCount(1)

  const continueButton = page.getByTestId('session-interrupted-continue')
  await expect(continueButton).toBeEnabled()
  await continueButton.click()

  // The same turn continues: the agent answers it, and the message stays a single message.
  await expect(restored.getByText(CONTINUED_REPLY, { exact: true })).toBeVisible({
    timeout: 90_000
  })
  await expect(restored.getByText(PROMPT, { exact: true })).toHaveCount(1)
})
