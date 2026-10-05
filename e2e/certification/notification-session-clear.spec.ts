import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// IC41: the session-scoped "clear completion notices" action has existed on BOTH sides of the bridge
// (`notifications:mark-session-completions-read` + the store action) and had no caller at all.
//
// Opening a session FROM the notification centre is the one place a person explicitly names a session, so
// that is where the call belongs — better than clearing on activation, which would silently drop notices for
// sessions the app opened by itself. This reading proves the stored inbox changes, not that a panel looks
// different.
test.setTimeout(240_000)

type InboxSnapshot = {
  unreadCount: number
  items: Array<{ id: string; kind: string; sessionId?: string; readAt?: number }>
}

const readInbox = async (page: import('@playwright/test').Page): Promise<InboxSnapshot> =>
  (await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { notifications: { getSnapshot: () => Promise<unknown> } }
    }
    return bridge.api.notifications.getSnapshot()
  })) as InboxSnapshot

test('opening a session from the notification centre clears its completion notices', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page, 'Notification clearing')
  await sendPrompt(page, 'Finish a task so a completion notice exists.', 'Deterministic reply:')

  const before = await readInbox(page)
  const completions = before.items.filter((item) => item.kind === 'task.completed')
  console.log(
    `[ic41] inbox before: unread=${before.unreadCount}; items=${JSON.stringify(
      before.items.map((item) => ({
        kind: item.kind,
        sessionId: item.sessionId,
        readAt: item.readAt
      }))
    )}`
  )
  expect(completions.length).toBeGreaterThan(0)
  const sessionId = completions[0]?.sessionId
  expect(sessionId).toBeTruthy()

  // Open the centre and take that very notice.
  await page
    .getByRole('button', { name: /Messages/ })
    .first()
    .click()
  const dialog = page.getByRole('dialog', { name: /message center/i })
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  console.log(
    `[ic41] the centre reads: "${(await dialog.innerText()).replace(/\s+/g, ' ').trim().slice(0, 300)}"`
  )
  await dialog
    .getByRole('button', { name: /completed|finished|task/i })
    .first()
    .click()
  console.log(`[ic41] opened the session from the centre: ${sessionId}`)

  // The stored inbox is the proof: that session's completion notices are read now.
  await expect
    .poll(
      async () => {
        const after = await readInbox(page)
        const mine = after.items.filter(
          (item) => item.sessionId === sessionId && item.kind === 'task.completed'
        )
        return mine.length > 0 && mine.every((item) => item.readAt !== undefined)
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  const after = await readInbox(page)
  console.log(
    `[ic41] inbox after: unread=${after.unreadCount}; the session's completions are read: ${JSON.stringify(
      after.items
        .filter((item) => item.sessionId === sessionId && item.kind === 'task.completed')
        .map((item) => item.readAt !== undefined)
    )}`
  )
})
