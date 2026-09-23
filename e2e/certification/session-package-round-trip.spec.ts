import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { test } from '../fixtures/electron-app'

// Acceptance for the export half of the session-package surface, on a real window.
//
// The desktop could read a package someone else sent and nothing else: `sessions:export-package` had no
// renderer caller, so a session could arrive but never leave. This walks both directions on a real
// session — the sidebar entry and its dialog through the UI, and the package itself by exporting real
// bytes and reading them back.
//
// The save sheet is an OS dialog Playwright cannot drive, so the round trip names its destination
// explicitly (the channel supports that) instead of pretending the sheet was clicked.

const USER_MESSAGE = 'Summarize the deterministic fixture.'
const AGENT_REPLY = `Deterministic reply: ${USER_MESSAGE}`
const PROJECT_NAME = 'Package round trip'

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

type SessionsApi = {
  sessions: {
    loadAll: () => Promise<unknown>
    exportPackage: (request: {
      projectId: string
      sessionId: string
      mode: 'essential' | 'full'
      destinationPath?: string
    }) => Promise<
      | { ok: true; path: string; bytes: number; notes: readonly string[] }
      | { ok: false; error: string }
    >
    previewPackage: (request: { packagePath: string }) => Promise<
      | { accepted: false; reason?: string }
      | {
          accepted: true
          described: {
            counts: { messages: number; citations: number; files: number }
            assertion: { origin: string; locallyVerified: boolean }
            mode: string
          }
        }
    >
    importPackage: (request: {
      packagePath: string
      confirm: { targetProjectId: string }
    }) => Promise<
      { ok: true; sessionId: string; notes: readonly string[] } | { ok: false; reason: string }
    >
  }
}

test('a session package can be produced from the UI and read back', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await createProject(page)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill(USER_MESSAGE)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText(AGENT_REPLY, { exact: true })).toBeVisible()

  // 1. The entry is where a session's other actions are, and it opens the export dialog.
  await page.getByRole('button', { name: `Open actions for ${USER_MESSAGE}` }).click()
  await page.getByRole('menuitem', { name: 'Export session package' }).click()
  const dialog = page.getByRole('dialog', { name: 'Export session package' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('radio', { name: /Essentials only/ })).toBeChecked()
  await expect(dialog.getByRole('radio', { name: /Everything/ })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()

  // The sibling text export sits in the same menu, so its own close path is checked here rather than
  // assumed: a retained-dialog value that drives `open` would leave the panel on screen.
  await page.getByRole('button', { name: `Open actions for ${USER_MESSAGE}` }).click()
  await page.getByRole('menuitem', { name: 'Export conversation' }).click()
  const textDialog = page.getByRole('dialog', { name: 'Export conversation' })
  await expect(textDialog).toBeVisible()
  await textDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(textDialog).toBeHidden()

  // 2. Real bytes, through the same channel the dialog calls.
  const destination = join(await app.createTestDirectory('session-package'), 'round-trip.science')
  const exported = await page.evaluate(
    async ({ message, destinationPath }) => {
      const { api } = globalThis as unknown as {
        api: SessionsApi & { projects: { list: () => Promise<Array<{ id: string }>> } }
      }
      const raw = await api.sessions.loadAll()
      const sessions = (
        Array.isArray(raw) ? raw : ((raw as { sessions?: unknown[] }).sessions ?? [])
      ) as Array<{
        id: string
        title?: string
        projectId?: string
      }>
      const session = sessions.find((candidate) => (candidate.title ?? '').includes(message))
      if (!session) return { found: false as const, count: sessions.length }

      return {
        found: true as const,
        projectId: session.projectId ?? '',
        sessionId: session.id,
        result: await api.sessions.exportPackage({
          projectId: session.projectId ?? '',
          sessionId: session.id,
          mode: 'full',
          destinationPath
        })
      }
    },
    { message: USER_MESSAGE, destinationPath: destination }
  )

  expect(exported.found).toBe(true)
  if (!exported.found) return
  expect(exported.result.ok).toBe(true)
  if (!exported.result.ok) return

  // The file is really on disk, and really an archive.
  expect(existsSync(destination)).toBe(true)
  expect(statSync(destination).size).toBe(exported.result.bytes)
  expect(readFileSync(destination).subarray(0, 2).toString('latin1')).toBe('PK')

  // 3. Reading it back: a preview describes what it holds and claims nothing it cannot prove.
  const preview = await page.evaluate(async (packagePath) => {
    const { api } = globalThis as unknown as { api: SessionsApi }
    return api.sessions.previewPackage({ packagePath })
  }, destination)
  expect(preview.accepted).toBe(true)
  if (!preview.accepted) return
  expect(preview.described.counts.messages).toBeGreaterThanOrEqual(2)
  expect(preview.described.mode).toBe('full')
  expect(preview.described.assertion).toEqual({ origin: 'source-party', locallyVerified: false })

  // 4. And importing it lands a session of its own — the round trip is closed.
  const imported = await page.evaluate(
    async ({ packagePath, targetProjectId }) => {
      const { api } = globalThis as unknown as { api: SessionsApi }
      const result = await api.sessions.importPackage({ packagePath, confirm: { targetProjectId } })
      const raw = await api.sessions.loadAll()
      const sessions = (
        Array.isArray(raw) ? raw : ((raw as { sessions?: unknown[] }).sessions ?? [])
      ) as Array<{
        id: string
      }>

      return {
        result,
        arrived: sessions.some((session) => session.id === (result.ok ? result.sessionId : ''))
      }
    },
    { packagePath: destination, targetProjectId: exported.projectId }
  )
  expect(imported.result.ok).toBe(true)
  expect(imported.arrived).toBe(true)

  rmSync(destination, { force: true })
})
