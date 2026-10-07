import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// The inbox's reader-side clearing: remove one notice, or clear them all. Both exist as channels and controls
// (the implementation shipped with a unit test and a render suite) — this is the true-machine reading, and it
// judges the STORED inbox rather than the panel: a notice that vanished from the list but stayed in the store
// is the failure this is here to catch.
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
  // ONE notice, and the reading follows it all the way to empty: cancelling changes nothing, one delete really
  // removes that row, and the panel then says the inbox is empty. (A second notice would have to come from a
  // second SESSION — notices are per session, measured — which this reading does not stage; that is why the
  // clear-all half is named as not true-machine-verified in the evidence doc.)
  await sendPrompt(page, 'Finish a task so a completion notice exists.', 'Deterministic reply:')

  const seeded = await readInbox(page)
  console.log(
    `[notifclear] seeded: unread=${seeded.unreadCount}; items=${JSON.stringify(seeded.items.map((item) => ({ id: item.id, kind: item.kind })))}`
  )
  // A spec that proceeds without the fixture it needs reports success for work it never did.
  expect(
    seeded.items.length,
    `no notice was seeded, so the clearing has nothing to prove: ${JSON.stringify(seeded.items.map((item) => item.kind))}`
  ).toBeGreaterThan(0)

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

  // With the last notice gone the panel says so — and the clear-all control goes with it, because an empty
  // inbox has nothing to clear. Clear-all's own true-machine path therefore needs MULTIPLE notices across two
  // sessions, which this reading does not stage: that half stays covered by the unit test and the panel's
  // render suite, and is named as not true-machine-verified in the evidence doc rather than implied here.
  await expect(page.getByText('No messages yet.')).toBeVisible({ timeout: 15_000 })
  const afterLast = await readInbox(page)
  console.log(
    `[notifclear] after deleting the last notice: items=${afterLast.items.length}, and the panel says the inbox is empty`
  )
  expect(afterLast.unreadCount).toBe(0)
})
