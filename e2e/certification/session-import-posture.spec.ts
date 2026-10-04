import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import type { SessionPackageImportRecord } from '../../src/shared/session-package-import'
import { test } from '../fixtures/electron-app'
import { createProject } from './helpers'

// The window bridge, declared narrowly for what this spec calls (the shared record type is imported
// rather than restated, so a change to the record cannot pass here unnoticed).
type Bridge = {
  api: {
    sessions: {
      loadAll: () => Promise<unknown>
      exportPackage: (request: {
        projectId: string
        sessionId: string
        mode: 'essential' | 'full'
        destinationPath?: string
      }) => Promise<{ ok: boolean; error?: string }>
      importPackage: (request: {
        packagePath: string
        confirm?: { targetProjectId?: string }
      }) => Promise<{ ok: boolean; sessionId?: string; reason?: string }>
      importPosture: (request: {
        projectId: string
        sessionId: string
      }) => Promise<SessionPackageImportRecord | null>
    }
  }
}

// IC11: the read-only / provenance posture of an imported session must be visible on the session
// itself — after a restart, not only in the dialog that imported it.
//
// The acceptance is "reopen the session and read three facts plus the read-only mark", so the spec
// restarts the process before looking: a posture that lived only in the importing window would pass a
// same-process check and fail this one. And because a banner that is simply always on would also pass,
// an ordinary session in the same project is opened first as the control.

const prompt = 'Summarise the IC11 docking run'

const readSourceTurn = async (page: Page, title: string): Promise<{ sessionId: string }> => {
  let found: { sessionId: string } | undefined
  await expect
    .poll(
      async () => {
        found = await page.evaluate(async (wanted) => {
          const bridge = globalThis as unknown as Bridge
          const raw = await bridge.api.sessions.loadAll()
          const list = Array.isArray(raw)
            ? raw
            : ((raw as { sessions?: unknown }).sessions ?? (raw as { items?: unknown }).items)
          const sessions = Array.isArray(list) ? list : []
          const session = (sessions as Array<Record<string, unknown>>).find(
            (candidate) =>
              String(candidate.title ?? '').includes(wanted) &&
              Array.isArray(candidate.messages) &&
              (candidate.messages as unknown[]).length > 0
          )
          return session ? { sessionId: String(session.id) } : undefined
        }, title)
        return found
      },
      { timeout: 60_000 }
    )
    .toBeTruthy()
  return found!
}

const sessionTitle = async (page: Page, sessionId: string): Promise<string> =>
  page.evaluate(async (wanted) => {
    const bridge = globalThis as unknown as Bridge
    const raw = await bridge.api.sessions.loadAll()
    const list = Array.isArray(raw)
      ? raw
      : ((raw as { sessions?: unknown }).sessions ?? (raw as { items?: unknown }).items)
    const sessions = Array.isArray(list) ? list : []
    const session = (sessions as Array<Record<string, unknown>>).find(
      (candidate) => String(candidate.id) === wanted
    )
    return String(session?.title ?? '')
  }, sessionId)

test('an imported session states where it came from after a restart, and an ordinary one says nothing', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  const directory = await app.createTestDirectory('ic11-posture')

  // 1) Source: one project, one completed turn.
  const sourceProjectId = await createProject(page, 'IC11 source')
  await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeEnabled({
    timeout: 120_000
  })
  const source = await readSourceTurn(page, prompt)

  // 2) Export it, then import into a second, empty project that ALSO holds an ordinary session — the
  // control has to live where the banner could plausibly show up.
  const packagePath = `${directory}/ic11.science`
  const exported = await page.evaluate(
    async (request) => {
      const bridge = globalThis as unknown as Bridge
      return bridge.api.sessions.exportPackage(request)
    },
    {
      projectId: sourceProjectId,
      sessionId: source.sessionId,
      mode: 'full' as const,
      destinationPath: packagePath
    }
  )
  expect(exported.ok, `export failed: ${JSON.stringify(exported)}`).toBe(true)

  await page.getByRole('button', { name: 'All projects' }).click()
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()
  const targetProjectId = await createProject(page, 'IC11 target')
  // the control session: an ordinary turn in the target project, so the banner's absence is meaningful
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('An ordinary turn in the target')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeEnabled({
    timeout: 120_000
  })
  const ordinary = await readSourceTurn(page, 'An ordinary turn')

  const imported = await page.evaluate(
    async (payload) => {
      const bridge = globalThis as unknown as Bridge
      return bridge.api.sessions.importPackage({
        packagePath: payload.packagePath,
        confirm: { targetProjectId: payload.targetProjectId }
      })
    },
    { packagePath, targetProjectId }
  )
  expect(imported.ok, `import failed: ${JSON.stringify(imported)}`).toBe(true)
  const importedSessionId = imported.sessionId!

  // The record the import wrote, read through the app's own channel: the banner must state THESE
  // fields, so the expectation is read from the app rather than written by hand here.
  const posture = await page.evaluate(
    async (request) => {
      const bridge = globalThis as unknown as Bridge
      return bridge.api.sessions.importPosture(request)
    },
    { projectId: targetProjectId, sessionId: importedSessionId }
  )
  expect(posture, 'the record beside the imported session must be readable').not.toBeNull()
  console.log(`[ic11] posture: ${JSON.stringify(posture)}`)

  // 3) Restart the process: the posture is on disk, so it must survive the window that imported it.
  page = await app.restart()

  // 4) The control first: the ordinary session says nothing.
  const ordinaryTitle = await sessionTitle(page, ordinary.sessionId)
  await page.locator('button', { hasText: ordinaryTitle }).first().click()
  await expect(page.locator('[data-session-id]')).toHaveAttribute(
    'data-session-id',
    ordinary.sessionId,
    { timeout: 60_000 }
  )
  await expect(page.locator('[data-testid="session-import-posture"]')).toHaveCount(0)

  // 5) Now the imported one, opened the way a reader opens it.
  const importedTitle = await sessionTitle(page, importedSessionId)
  await page.locator('button', { hasText: importedTitle }).first().click()
  await expect(page.locator('[data-session-id]')).toHaveAttribute(
    'data-session-id',
    importedSessionId,
    { timeout: 60_000 }
  )
  const banner = page.locator('[data-testid="session-import-posture"]')
  await expect(banner).toBeVisible({ timeout: 60_000 })
  const text = (await banner.innerText()).replace(/\s+/g, ' ')
  console.log(`[ic11] banner: ${text}`)
  // 导入自 X（源项目 / 源会话 / 发送方应用版本）、导出于 Y、以及「本机未验证」——逐项取自记录本身。
  expect(text).toContain(posture!.importedFrom.projectId)
  expect(text).toContain(posture!.importedFrom.sessionId)
  expect(text).toContain(posture!.importedFrom.appVersion)
  expect(text).toContain(posture!.importedFrom.exportedAt)
  expect(text).toContain('Not verified on this machine')
  // 标只读：徽标在场，且写明只读意味着什么
  await expect(page.locator('[data-testid="session-import-posture-readonly"]')).toBeVisible()
  expect(text).toContain('read-only')
  expect(text).toContain('never run or continue them')
})
