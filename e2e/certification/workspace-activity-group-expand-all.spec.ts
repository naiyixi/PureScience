import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { scopeEnvironmentToThisSpec } from '../fixtures/spec-environment'

// ⌘⇧E is a keyboard-only control: nothing on screen advertises it, so the only place its contract can be
// proven is a real window with real key events. The jsdom suite proves the state machine in isolation; this
// proves the key actually arrives at the window and that a reader can see the result.
//
// The two defects this pins were shipped in v2.21.3's first tag and found only because the release lane went
// red (both fixed in 2556d4ad):
//   · the discriminator compared `'activityGroup'` against the real literal `'activity-group'`, so the
//     override map it wrote was never read and the shortcut changed nothing at all;
//   · "is anything collapsed?" read the per-row override table instead of the per-group one, so the answer
//     was always "yes, something is collapsed" — the shortcut could open groups but never close them.
// The second one is only observable on the SECOND press, which is why this spec presses it three times and
// asserts the closing transition, not just "something changed".
let restoreEnvironment = (): void => {}

test.beforeAll(() => {
  // Two tool-call lifecycles per turn so each turn renders an activity group to fold.
  restoreEnvironment = scopeEnvironmentToThisSpec({ PURESCIENCE_E2E_TOOL_EVENTS: '2' })
})

test.afterAll(() => {
  restoreEnvironment()
})

test.setTimeout(300_000)

const FIXTURE_REPLY = 'Deterministic reply: Summarize the deterministic fixture.'

const groupExpansion = (page: Page): Promise<string[]> =>
  page
    .getByTestId('tool-group-header')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-expanded') ?? 'missing'))

const pressExpandAll = async (page: Page): Promise<void> => {
  await page.keyboard.press('Meta+Shift+E')
  // The handler runs synchronously on keydown; the extra turn of the loop lets React commit before the
  // assertion below reads the DOM (expect.poll would also retry, this just keeps the log honest).
  await page.waitForTimeout(100)
}

test('⌘⇧E opens every activity group from a real window, then closes them all', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Expand-all shortcut')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  const sendTurn = async (prompt: string, expectedReplies: number): Promise<void> => {
    await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByText(FIXTURE_REPLY, { exact: true })).toHaveCount(expectedReplies, {
      timeout: 120_000
    })
  }

  await sendTurn('First audited turn', 1)
  await sendTurn('Second audited turn', 2)

  // Settled history arrives collapsed and the newest turn open — the transcript's own default. Waiting for
  // the headers to exist (rather than a fixed sleep) is also what guarantees they are mounted.
  await expect
    .poll(async () => (await groupExpansion(page)).length, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(2)
  const settled = await groupExpansion(page)
  expect(
    settled.every((state) => state === 'true' || state === 'false'),
    `group headers must expose aria-expanded, got ${JSON.stringify(settled)}`
  ).toBe(true)
  console.log(`[cert] default group expansion = ${JSON.stringify(settled)}`)

  // First press: whatever the default, a reader who asks for "all" gets everything open.
  await pressExpandAll(page)
  await expect.poll(() => groupExpansion(page)).toEqual(settled.map(() => 'true'))
  console.log(`[cert] after first ⌘⇧E = ${JSON.stringify(await groupExpansion(page))}`)

  // Second press is the one the "always opens" defect could not survive: nothing is collapsed any more, so
  // this has to close everything — including the newest turn.
  await pressExpandAll(page)
  await expect.poll(() => groupExpansion(page)).toEqual(settled.map(() => 'false'))
  console.log(`[cert] after second ⌘⇧E = ${JSON.stringify(await groupExpansion(page))}`)

  // Round trip back open, so the spec leaves the transcript in the state a reader expects after a third press.
  await pressExpandAll(page)
  await expect.poll(() => groupExpansion(page)).toEqual(settled.map(() => 'true'))

  // A shortcut must not steal the key from someone typing: focus the composer, press it, and the transcript
  // stays exactly as it was while the typed text survives.
  const beforeTyping = await groupExpansion(page)
  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await composer.click()
  await page.keyboard.type('cmd-shift-e while typing')
  await pressExpandAll(page)
  await page.waitForTimeout(300)
  expect(await groupExpansion(page)).toEqual(beforeTyping)
  await expect(composer).toContainText('cmd-shift-e while typing')

  console.log('[cert] shortcut ignored inside the composer; transcript unchanged')
})
