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

// (flake, v2.33.2) The receipt line is the fixture agent's reply; the artifact row that carries the file's
// path is a separate write into the session document, so a read taken the moment the reply appears can come
// back without it. Measured on the Windows runner (release run 44969881391, job 137051828764):
// `pdf-figure-extraction`'s first attempt threw "the PDF artifact has no path in the session document"
// after 19 s, and retry #1 passed 21 s later on the same tree. Polling the document does not lower what
// these specs assert — the command still has to run on the artifact the app itself recorded — it only
// takes the sampling instant out of the instrument, and it names the two failures apart: a row that never
// appears (the write did not happen) versus a row with an empty path (document and `PersistedArtifact.path`
// disagree, where the type says a path is always present).
const readSessionArtifact = async (
  page: Page,
  request: { projectId: string; sessionId: string; name: string }
): Promise<{ path?: string; names: string[]; pathless: boolean }> =>
  page.evaluate(async ({ projectId, sessionId, name }) => {
    const bridge = globalThis as unknown as {
      api: {
        sessions: {
          readDocument: (input: {
            projectId: string
            sessionId: string
          }) => Promise<{ artifacts?: Array<{ name?: string; path?: string }> } | undefined>
        }
      }
    }
    const document = await bridge.api.sessions.readDocument({ projectId, sessionId })
    const artifacts = document?.artifacts ?? []
    const artifact = artifacts.find((entry) => entry.name === name)
    return {
      path: artifact?.path ? artifact.path : undefined,
      names: artifacts.map((entry) => entry.name ?? '(unnamed)'),
      pathless: Boolean(artifact) && !artifact?.path
    }
  }, request)

const sessionArtifactPath = async (
  page: Page,
  request: { projectId: string; sessionId: string; name: string },
  timeoutMs = 90_000
): Promise<string> => {
  const startedAt = Date.now()
  let reading = await readSessionArtifact(page, request)
  while (!reading.path && Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(250)
    reading = await readSessionArtifact(page, request)
  }
  if (!reading.path) {
    throw new Error(
      reading.pathless
        ? `${request.name} is in the session document without a path after ${timeoutMs} ms`
        : `the session document never listed ${request.name} in ${timeoutMs} ms; it lists [${reading.names.join(', ')}]`
    )
  }
  console.log(
    `[cert] artifact ${request.name} reached the session document after ${Date.now() - startedAt} ms`
  )
  return reading.path
}

export { createProject, openRecentSession, receiptText, sendPrompt, sessionArtifactPath }
