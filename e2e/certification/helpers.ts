import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'

const createProject = async (page: Page, name: string): Promise<string> => {
  const existingProjectIds = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { projects: { list: () => Promise<Array<{ id: string }>> } }
    }
    return (await bridge.api.projects.list()).map((project) => project.id)
  })
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  let projectId: string | undefined
  await expect
    .poll(
      async () => {
        projectId = await page.evaluate(async (existingIds) => {
          const bridge = globalThis as unknown as {
            api: { projects: { list: () => Promise<Array<{ id: string }>> } }
          }
          return (await bridge.api.projects.list()).find(
            (project) => !existingIds.includes(project.id)
          )?.id
        }, existingProjectIds)
        return projectId
      },
      { timeout: 30_000 }
    )
    .toEqual(expect.any(String))
  return projectId!
}

const sendPrompt = async (
  page: Page,
  prompt: string,
  reply: string,
  timeout = 30_000
): Promise<void> => {
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  const expectedReply = page.getByText(reply, { exact: false })
  const fixtureFailure = page.getByText(/^E2E fixture failure:/)
  await expect(expectedReply.or(fixtureFailure)).toBeVisible({ timeout })
  if (await fixtureFailure.isVisible()) throw new Error(await fixtureFailure.innerText())
}

const openRecentSession = async (page: Page, prompt: string): Promise<void> => {
  const session = page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: prompt })
  await expect(session).toBeVisible({ timeout: 60_000 })
  await session.click()
}

// Conversation items are rendered inside `message-scroller`, whose items carry
// `content-visibility: auto` with an intrinsic placeholder. An item the reader has scrolled past is
// then *skipped for layout*, and `innerText` on a skipped subtree is the empty string even though the
// text is still in the DOM — measured on this app: contained height 160 px (the placeholder),
// `innerText` "", `textContent` 66 chars. A receipt read with `innerText` therefore fails on exactly
// those runs where the conversation grew long enough to push the receipt out of view, and the failure
// reads as "Invalid … receipt: " with the sentence plainly visible in the page snapshot.
// What such a line asserts is *what the receipt says*, so read the DOM text; whether the surface is on
// screen is asserted by the panel/message assertions around it.
const receiptText = async (locator: Locator): Promise<string> =>
  ((await locator.textContent()) ?? '').replace(/\s+/g, ' ').trim()

export { createProject, openRecentSession, receiptText, sendPrompt }
