import { existsSync, linkSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// A run cut off by the user quitting the app must be recorded as INTERRUPTED, not as a failure —
// `repository.ts:271-287`: "on the first load of a session in a fresh process, any run still marked
// 'running' (or 'queued') was in flight when the previous process died … mark it 'interrupted' with
// interruptionReason 'app-terminated' (NOT failed — the code may have been fine)".
//
// The trigger is the app's OWN quit path, which is the only path the contract is about: request quit
// (`app.quit()`, what the tray/menu Quit does), answer the app's own "work is still running and will be
// interrupted if you quit." confirmation with Quit, and the app runs its bounded backend teardown.
//
// Two things this spec deliberately does NOT do, because each measured nothing (see
// docs/evidence/2026-10-04-notebook-crash-recovery-contract.md, 追加四):
//   - taking the app away with the harness's close()/restart(): it first quits an instance that has no
//     notebook session at all, then force-kills the instance that is running one, so the reading belongs to
//     neither the contract's trigger nor a product defect;
//   - closing the main window: on macOS that classifies as 'hide' (windows.ts), so the app never quits.
//
// The arbiter is the PERSISTED record (run.json): it is what the domain rule, the crash-recovery
// reconciler and the badge all read. The window is gone by then, so it is read from this process.
//
// Why the curated pack instead of the default environment: the isolated instance provisions its default env
// by DOWNLOADING, which this machine's network cannot complete — every attempt came back with the app's own
// words "The Python environment is still being prepared — retry shortly." for forty-five seconds straight.
// The pack plus its cache is the path the sibling specs use for that reason, and a cell really runs on the
// imported env (proved by the V6 acceptance in this same suite).

const REAL_RUNTIME_ROOT = join(homedir(), '.purescience', 'runtime')
const PACK_SUBDIR = process.platform === 'darwin' ? 'osx-arm64' : 'linux-64'
const PACK_DIR = join(REAL_RUNTIME_ROOT, 'packs', '1', PACK_SUBDIR, 'python-3.12')
const PACK_LOCK = join(PACK_DIR, 'python-3.12.lock')
const ENV_NAME = 'lock-import-env'

process.env.PURESCIENCE_MICROMAMBA_BIN = join(REAL_RUNTIME_ROOT, 'micromamba', 'bin', 'micromamba')

test.setTimeout(900_000)

const instanceDataRoot = (storageRoot: string): string => join(storageRoot, 'PureScience-DEV')

const seedInstanceCache = (storageRoot: string, lockText: string): number => {
  const cache = join(instanceDataRoot(storageRoot), 'runtime', 'pkgs')
  mkdirSync(cache, { recursive: true })
  let seeded = 0
  for (const raw of lockText.split('\n')) {
    const line = raw.trim()
    if (!/^https?:\/\//.test(line)) continue
    const url = line.split('#')[0]
    const file = url.slice(url.lastIndexOf('/') + 1)
    linkSync(join(PACK_DIR, file), join(cache, file))
    seeded += 1
  }
  return seeded
}

const openRuntimes = async (page: Page): Promise<ReturnType<Page['getByRole']>> => {
  // The home screen has a named entry; inside a workspace it is not on screen, and the app's own shortcut
  // (⌘, / Ctrl+, — App.tsx:170-193) is the way back in. Wait for the entry rather than counting it: an
  // instantaneous count on a page that has not painted reads zero and takes the shortcut path before the
  // app is hydrated, where that shortcut is guarded off.
  const entry = page.getByRole('button', { name: 'Model settings' })
  const entryIsThere = await entry
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (entryIsThere) {
    await entry.first().click()
  } else {
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+,`)
  }
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Runtimes' })
    .click()

  return settings
}

type StoredRun = {
  runId: string
  status: string
  interruptionReason?: string
  text?: { traceback?: string; stderr?: string }
}

const readStoredRuns = (runJsonPath: string): StoredRun[] =>
  (JSON.parse(readFileSync(runJsonPath, 'utf8')) as { runs?: StoredRun[] }).runs ?? []

test('a run cut off by the user quitting the app is recorded as interrupted, not as a failure', async ({
  app
}) => {
  test.skip(!existsSync(PACK_LOCK), 'no curated pack on this machine')
  const lock = readFileSync(PACK_LOCK, 'utf8')

  let page = await app.completeOnboarding()
  const seeded = seedInstanceCache(app.storageRoot, lock)
  console.log(`[interrupt] instanceRoot=${app.storageRoot} seeded=${seeded}`)

  // --- an environment that can actually run a cell here (pack + cache, zero downloads) ---------------
  const settings = await openRuntimes(page)
  await settings.getByTestId('runtime-import-lock-python').click()
  const dialog = page.getByTestId('runtime-import-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('runtime-import-name').fill(ENV_NAME)
  await dialog.getByTestId('runtime-import-lock').fill(lock)
  const downloadToggle = dialog.getByRole('switch', {
    name: 'Download packages missing from the local cache'
  })
  if (await downloadToggle.isChecked()) await downloadToggle.click()
  await dialog.getByTestId('runtime-import-submit').click()
  await expect(dialog.getByTestId('runtime-import-status')).toContainText(ENV_NAME, {
    timeout: 300_000
  })
  console.log(
    `[interrupt] import: ${(await dialog.getByTestId('runtime-import-status').innerText()).replace(/\s+/g, ' ')}`
  )
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)

  // Bind it as the session's runtime: a cell routes through the session binding, never the request.
  const useRow = settings.locator('[data-testid="named-env-row"]', { hasText: ENV_NAME })
  await expect(useRow).toBeVisible({ timeout: 30_000 })
  await useRow.getByTestId('named-env-use').click()
  await expect(settings.getByTestId('runtimes-notice')).toContainText(ENV_NAME, { timeout: 60_000 })

  // --- a real session -------------------------------------------------------------------------------
  page = await app.configureFakeAgent()
  const projectName = 'interrupted-run'
  await createProject(page, projectName)
  await sendPrompt(
    page,
    'Create a provenance artifact.',
    'Artifact provenance verified for session',
    90_000
  )

  const session = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: { sessions: { loadAll: () => Promise<unknown> } }
    }
    const loaded = (await bridge.api.sessions.loadAll()) as
      { sessions?: Array<{ id?: string; cwd?: string }> } | Array<{ id?: string; cwd?: string }>
    const list = Array.isArray(loaded) ? loaded : (loaded.sessions ?? [])
    const found = list.find((entry) => typeof entry.cwd === 'string' && entry.cwd !== '')
    return { id: found?.id ?? '', cwd: found?.cwd ?? '' }
  })
  console.log(`[interrupt] session=${session.id}`)
  expect(session.id).not.toBe('')

  // --- fire the cell, and verify the premise instead of assuming it ---------------------------------
  let inFlight = false
  let lastText = ''
  for (let attempt = 1; attempt <= 20 && !inFlight; attempt += 1) {
    await page.evaluate(
      ({ sessionId, workspaceCwd, projectName, seconds }) => {
        const bridge = globalThis as unknown as {
          api: { notebook: { execute: (request: Record<string, unknown>) => Promise<unknown> } }
        }
        // Deliberately not awaited: the quit has to land while the cell is still running.
        void bridge.api.notebook
          .execute({
            sessionId,
            workspaceCwd,
            projectName,
            code: `import time\nprint("sleeping")\ntime.sleep(${seconds})\nprint("done")`,
            language: 'python',
            source: 'user'
          })
          .catch((error: unknown) => {
            console.log(`[interrupt] execute rejected with: ${String(error)}`)
            return undefined
          })
      },
      { sessionId: session.id, workspaceCwd: session.cwd, projectName, seconds: 45 }
    )
    await page.waitForTimeout(3_000)
    const reading = await page.evaluate(
      async ({ sessionId, workspaceCwd, projectName }) => {
        const bridge = globalThis as unknown as {
          api: {
            notebook: {
              state: (request: Record<string, unknown>) => Promise<{
                runs?: Array<{ runId: string; status: string; text?: { traceback?: string } }>
              }>
            }
          }
        }
        const state = await bridge.api.notebook.state({ sessionId, workspaceCwd, projectName })
        return state.runs ?? []
      },
      { sessionId: session.id, workspaceCwd: session.cwd, projectName }
    )
    inFlight = reading.some((run) => run.status === 'running')
    lastText = reading
      .map((run) => run.text?.traceback ?? '')
      .join(' | ')
      .slice(0, 200)
    console.log(
      `[interrupt] attempt ${attempt}: running=${inFlight} statuses=${JSON.stringify(reading.map((r) => r.status))}`
    )
    if (!inFlight && attempt > 1 && !/still being prepared/.test(lastText)) break
  }
  expect(inFlight, `nothing was ever running: ${lastText}`).toBe(true)

  // The state names where the history lives; remember it while the process can still answer, so the disk can
  // be read after the quit without guessing the path.
  const runJsonPath = await page.evaluate(
    async ({ sessionId, workspaceCwd, projectName }) => {
      const bridge = globalThis as unknown as {
        api: {
          notebook: {
            state: (request: Record<string, unknown>) => Promise<{ runJsonPath?: string }>
          }
        }
      }
      const state = await bridge.api.notebook.state({ sessionId, workspaceCwd, projectName })
      return state.runJsonPath ?? ''
    },
    { sessionId: session.id, workspaceCwd: session.cwd, projectName }
  )
  console.log(`[interrupt] runJsonPath=${runJsonPath}`)
  expect(runJsonPath).not.toBe('')

  // --- the user's quit, while the cell is still running ----------------------------------------------
  await app.requestQuit()
  const quitButton = page.getByRole('button', {
    name: /^(Quit|Beenden|Salir|Quitter|終了|종료|Выйти|退出)$/
  })
  await expect(quitButton.first()).toBeVisible({ timeout: 30_000 })
  console.log(`[interrupt] confirm action: "${(await quitButton.first().innerText()).trim()}"`)
  await quitButton.first().click()
  console.log('[interrupt] confirmed Quit; the app now runs its own bounded teardown')

  // Wait on the RECORD, not on the page: the page legitimately disappears as the app exits. The wait is on
  // the IN-FLIGHT run reaching a terminal status — "some run is terminal" would be satisfied immediately by
  // the earlier completed run and read the record before the quit path had written it.
  let stored: StoredRun[] = []
  for (let attempt = 0; attempt < 60; attempt += 1) {
    stored = existsSync(runJsonPath) ? readStoredRuns(runJsonPath) : []
    const stillPending = stored.some((run) => run.status === 'running' || run.status === 'queued')
    if (stored.length > 0 && !stillPending) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  console.log(
    `[interrupt] run.json on disk: ${JSON.stringify(
      stored.map((run) => [run.runId, run.status, run.interruptionReason ?? null])
    )}`
  )
  for (const run of stored) {
    if (run.status !== 'failed') continue
    console.log(
      `[interrupt] failed run ${run.runId} says: ${(run.text?.traceback ?? '').slice(0, 200)}`
    )
  }

  const cut = stored.find((run) => run.status === 'interrupted')
  expect(cut, `no interrupted run was recorded: ${JSON.stringify(stored)}`).toBeTruthy()
  expect(cut?.interruptionReason).toBe('app-terminated')
  // The recorder's own distinction, and the one the badge states: this run is NOT a failure.
  expect(stored.some((run) => run.status === 'failed')).toBe(false)
})
