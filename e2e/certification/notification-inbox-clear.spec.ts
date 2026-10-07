import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// The inbox's reader-side clearing: remove one notice, or clear them all. Both exist as channels and controls
// (the implementation shipped with a unit test and a render suite) — this is the true-machine reading, and it
// judges the STORED inbox rather than the panel: a notice that vanished from the list but stayed in the store
// is the failure this is here to catch.
//
// TWO notices from ONE session, which does not need a second project: a turn that finishes writes a
// `task.completed` notice, and a turn that asks the app for permission writes an authorization notice (the
// fixture's own `Request fixture permission.` prompt drives exactly that; the app settles the request, but the
// notice it created stays). Two SESSIONS would need the project switcher, and "back to the home screen → New
// project" is not reachable from inside a conversation — measured, so this reading seeds around it.
test.setTimeout(240_000)

type InboxSnapshot = { unreadCount: number; items: Array<{ id: string; kind: string }> }

const readInbox = async (page: import('@playwright/test').Page): Promise<InboxSnapshot> =>
  (await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { notifications: { getSnapshot: () => Promise<unknown> } }
    }
    return bridge.api.notifications.getSnapshot()
  })) as InboxSnapshot

test('deletes one notice, clears them all, and cancelling changes nothing', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Notification inbox clearing')
  await sendPrompt(page, 'Finish a task so a completion notice exists.', 'Deterministic reply:')
  // The fixture answers 'Fixture permission allowed.' or '… denied.' depending on the app's own permission
  // policy (measured: denied, so the reply text must not be pinned to one of them) — what writes the notice is
  // the REQUEST itself (`runtime-composition.ts` creates `authorization.required` keyed by session+request).
  await sendPrompt(page, 'Request fixture permission.', 'Fixture permission')

  const seeded = await readInbox(page)
  console.log(
    `[notifclear] seeded: unread=${seeded.unreadCount}; items=${JSON.stringify(seeded.items.map((item) => ({ id: item.id, kind: item.kind })))}`
  )
  // A spec that proceeds without the fixture it needs reports success for work it never did.
  expect(
    seeded.items.length,
    `two notices are needed for this reading: ${JSON.stringify(seeded.items.map((item) => item.kind))}`
  ).toBeGreaterThan(1)

  // The trigger is the bell itself: its accessible name is "Messages, N unread". "Message center" is the
  // PANEL's name (role=dialog) — the first attempt looked for that as a button and never found it.
  await page.getByRole('button', { name: /^Messages,/ }).first().click()
  await expect(page.getByRole('dialog', { name: 'Message center' })).toBeVisible({ timeout: 15_000 })

  // Cancelling the clear must change nothing — the warning is a decision point, not a decoration.
  await page.locator('[data-slot="notifications-clear-all"]').click()
  await expect(page.locator('[data-slot="notifications-clear-warning"]')).toBeVisible()
  const warning = (await page.locator('[data-slot="notifications-clear-warning"]').innerText())
    .replace(/\s+/g, ' ')
    .trim()
  console.log(`[notifclear] the clear-all warning says: "${warning}"`)
  await page.locator('[data-slot="notifications-clear-cancel"]').click()

  const afterCancel = await readInbox(page)
  expect(afterCancel.items.length, 'cancelling the clear removed notices').toBe(seeded.items.length)

  // Remove exactly one, by its own control, and check the STORE — one fewer, not zero.
  const removedId = seeded.items[0]!.id
  await page.locator('[data-slot="notification-item-delete"]').first().click()

  await expect
    .poll(async () => (await readInbox(page)).items.some((item) => item.id === removedId), {
      timeout: 30_000
    })
    .toBe(false)
  const afterOne = await readInbox(page)
  console.log(
    `[notifclear] after deleting one: items=${afterOne.items.length} (was ${seeded.items.length})`
  )
  expect(afterOne.items.length).toBe(seeded.items.length - 1)

  // Now clear what is left, through the confirmation — the half that needs more than one notice.
  await page.locator('[data-slot="notifications-clear-all"]').click()
  await page.locator('[data-slot="notifications-clear-confirm-button"]').click()

  await expect
    .poll(async () => (await readInbox(page)).items.length, { timeout: 30_000 })
    .toBe(0)
  const cleared = await readInbox(page)
  console.log(
    `[notifclear] after clearing all: items=${cleared.items.length}, unread=${cleared.unreadCount}`
  )
  expect(cleared.unreadCount).toBe(0)
  await expect(page.getByText('No messages yet.')).toBeVisible({ timeout: 15_000 })
})
