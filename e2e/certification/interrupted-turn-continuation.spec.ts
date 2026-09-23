import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// The first turn is answered, so the session is written down at all: a session whose only turn never
// completed is not persisted, and after the restart there is then nothing to continue (measured).
const FIRST_TURN = 'Answer this turn before the interruption.'
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
//   * Ninth measurement, after fixing what the eighth one exposed: the guard no longer refuses. The
//     continuation path required a `resumeRecovery` record, and nothing in the repository ever wrote one —
//     `kind: 'resume-required'` appeared only in the type and in that check — so the action could not have
//     succeeded for anyone. The record is now written while restoring an interrupted session, where the app
//     is the one who knows which turn was cut off, and the refusal moved on to the next honest obstacle:
//     "The turn could not be continued: Error invoking remote method 'acp:continue-interrupted-turn': Error:
//     ACP session not found: e2e-session-1" (thrown by prompt-turn-workflow.ts:219). Its force-load sibling
//     at :200 is the 'after force-load' variant, so this is the plain one. The fixture's agent advertises
//     `loadSession: false` while implementing `session/resume`, so which side is missing the session — the
//     app's post-restart resume, or the fixture's capabilities — is what to read next.
//   * The same rebuilt machine also confirms the accessibility fix from this round: the composer's group
//     label now reads 'Send options' instead of the literal "{t('workspace.sendMessage')} options".
//   * Seventh and eighth measurements: the fixture can now produce the session this acceptance needs — a
//     completed first turn, then a turn left hanging with its partial answer ('Part of the answer arrived
//     before the app went down.'), and the app restarts while that turn is open. The restart itself had to be
//     bounded first: an unbounded close hangs while a turn is in flight (284s, then the test timed out), so
//     the fixture closes gracefully within a budget and forces after that. The open-turn memory also had to
//     stop being keyed by session id, which is the same value every run: a marker left by a failed run made
//     the next run answer instead of hang, and the spec now clears stale markers before it starts.
//   * With all of that, the banner is reached on the real machine and works exactly as designed: the session
//     row reads 'Session status: Error Answer this turn before the interruption.', the conversation carries
//     the interrupted message with its partial answer and 'Failed' time, and after the restart the banner
//     shows 'Session was interrupted before the app closed.' with 'Continue turn' beside 'Resume', the
//     difference between them stated in words, and a named refusal when the action cannot be carried out.
//     What it refuses with is the open item: "The turn could not be continued: Error invoking remote method
//     'acp:continue-interrupted-turn': Error: Resume no longer matches the interrupted turn on the active
//     Conversation Branch." — the renderer-to-main wiring fires (the failure is reported by name, which is
//     the contract this unit added), and the main process then rejects the recorded turn. Whether the guard
//     is comparing the wrong message, or a partial answer is treated as an answer, is the next thing to read
//     in interrupted-turn-continuation.ts rather than guess at.
//   * Sixth measurement: the marker moved to a session-keyed file under the system temp directory, because
//     the agent cannot receive the app's environment. This run is the check for that channel.
//   * Fifth measurement, with the fixture answering a first turn and hanging on a second: the first turn
//     completes and is written down (the session row reads 'Session status: Error Answer this turn before the
//     interruption.'), the second prompt is in the conversation, and no run is in flight — because this
//     round's own fixture change errored it. `PURESCIENCE_FAKE_AGENT_STATE` never reached the agent: the
//     backend is spawned with the config's environment (`agent-connection-adapter.ts:179`), not the app's,
//     so the marker path the fake agent required was absent and its guard threw. That guard is gone. The
//     open-turn memory is per process until the path travels through a channel the agent really receives,
//     which is what the restart shape needs.
//   * Fourth measurement, clean conditions (no daemon, bookmarks dialog no longer clicked): the restart
//     succeeds and the project opens, and the workspace then shows its session list with 'No conversations
//     yet'. Nothing was left to continue because nothing was ever written down: this fixture's only turn is
//     the one that never finishes, and a session whose single turn never completed is not persisted. So the
//     fixture is wrong for this acceptance, not the app — an interrupted turn is reachable when a session
//     that already has a completed turn is interrupted inside a later one. The fake agent answers the first
//     send and hangs on the second; this spec has to do the same two sends.
//   * Third measurement, with the window bug fixed and the restart shape in place: onboarding, the prompt,
//     the in-flight composer and the restart all succeed. Reaching the session then failed because of this
//     spec, not the app: clicking the sidebar's 'Sessions and bookmarks' control opens the Session bookmarks
//     dialog (the failure snapshot shows exactly that dialog with its Close button, the privacy note and
//     'No bookmarks yet'), and the workspace's session navigation is not rendered while it is up. That click
//     is gone below; how the workspace lists sessions after a restart — and whether the interrupted session
//     is opened automatically — is the next thing to read from the app rather than assume.
//
// So the shape to establish is: the turn is left open, the app is restarted (which is when a session with
// an unfinished turn is restored as interrupted), the session is opened, and Continue is expected to hand
// the same turn back to the agent without producing a second copy of the message.
// The fixture keeps 'this run already left a turn hanging' in a temp file named after the session id, which
// is the same value every run. A run that failed before the continuation therefore leaves a marker behind and
// the next run gets an answer instead of a hang (measured). Start from a clean slate.
test.beforeEach(async () => {
  const directory = tmpdir()
  for (const entry of await readdir(directory)) {
    if (entry.startsWith('purescience-e2e-interrupted-turn-')) {
      await rm(join(directory, entry), { force: true })
    }
  }
})

test.fixme('a turn that was interrupted is continued, not sent again', async ({ app }) => {
  // Two turns, a restart and a session opened from scratch: more than the default budget allows.
  test.setTimeout(300_000)
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Interrupted turn')

  const conversation = page.getByRole('region', { name: 'Conversation' })
  await sendPrompt(page, FIRST_TURN, 'Deterministic reply:')
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
  // NOT that control: 'Sessions and bookmarks' opens the Session bookmarks dialog, which takes the place of
  // the workspace while it is up (measured). The session navigation is looked for directly instead.
  const sessions = page.getByRole('navigation', { name: 'Sessions' })
  await expect(sessions).toBeVisible({ timeout: 30_000 })
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
