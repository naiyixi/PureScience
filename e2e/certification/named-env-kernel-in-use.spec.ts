import { existsSync, linkSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// V6, second attempt. The first attempt reached the last step and produced a NEGATIVE result: the kernel
// was started on the environment (`notebook.execute` returned ok with a real runId) and the removal still
// SUCCEEDED (`Removed "lock-import-env".`), i.e. `isLive` was false at that moment. See
// `docs/evidence/2026-10-04-v6-kernel-in-use-recipe-refuted.md`.
//
// Static reading has since killed two explanations:
//   · the process key cannot be the problem — it is `${python|r}:${resolveEnvName(...)}`
//     (`data-execution-admission.ts:67`) and the app's own read model parses it the same way `isLive` does
//     (`session-read-model.ts:198-210`), so the suffix IS the environment name;
//   · idle reclaim cannot be the problem by default — `DEFAULT_IDLE_MS = 0` disables it
//     (`kernel-executor.ts:89,101`), so a kernel persists until an explicit teardown.
//
// So this run MEASURES the remaining question instead of guessing: the app already exposes the kernel
// status table to the window (`notebook.state` → `environments: NotebookEnvironmentStatus[]`,
// `shared/notebook.ts:723`), so the spec reads it right after the execution and then drives the removal.
//
// What is asserted is the CONTRACT between those two readings, not one of the outcomes:
//   · a live (non-terminated) entry for this environment  ⇒ the removal MUST be refused, verbatim;
//   · no such entry                                       ⇒ the removal MUST succeed.
// Both paths pass; a run where the status table says "live" and the removal succeeds anyway fails — which
// is the defect this test exists to catch. The reading is printed either way, so the cause names itself.
const REAL_RUNTIME_ROOT = join(homedir(), '.purescience', 'runtime')
const PACK_SUBDIR = process.platform === 'darwin' ? 'osx-arm64' : 'linux-64'
const PACK_DIR = join(REAL_RUNTIME_ROOT, 'packs', '1', PACK_SUBDIR, 'python-3.12')
const PACK_LOCK = join(PACK_DIR, 'python-3.12.lock')
const ENV_NAME = 'lock-import-env'

process.env.PURESCIENCE_MICROMAMBA_BIN = join(REAL_RUNTIME_ROOT, 'micromamba', 'bin', 'micromamba')

test.setTimeout(600_000)

// Verbatim from `environment-management.ts:99-104`; a friendlier rephrasing on screen would mean the reader
// is told something the service did not say.
const REFUSAL =
  `Environment "${ENV_NAME}" is in use by a running kernel — restart the notebook or wait for the run to ` +
  'finish before removing it.'

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
  // (⌘, / Ctrl+, — `App.tsx:170-193`) is the way back in. Wait for the entry rather than counting it: an
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

test('a live kernel on a named environment is refused, and the status table says which case this is', async ({
  app
}) => {
  test.skip(!existsSync(PACK_LOCK), 'no curated pack on this machine')
  const lock = readFileSync(PACK_LOCK, 'utf8')

  let page = await app.completeOnboarding()
  const seeded = seedInstanceCache(app.storageRoot, lock)
  console.log(`[v6b] instanceRoot=${app.storageRoot} seeded=${seeded}`)

  // --- ① the environment exists (the import path the sibling spec proves end to end) --------------------
  let settings = await openRuntimes(page)
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
    timeout: 240_000
  })
  console.log(
    `[v6b] import: ${(await dialog.getByTestId('runtime-import-status').innerText()).replace(/\s+/g, ' ')}`
  )
  // Cancel, then the count reaching zero: Escape does not close this modal (learned the hard way).
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect(existsSync(join(instanceDataRoot(app.storageRoot), 'runtime', 'envs', ENV_NAME))).toBe(
    true
  )

  // --- ①b make it the runtime, the way a reader does -----------------------------------------------
  // This is the step the first attempt skipped, and skipping it is why nothing was ever "in use": a data
  // cell routes through `admission.route()` -> the session's runtime binding (or the persisted Settings
  // selection it adopts), and the app's own agent tool says so in as many words — `mcp-server.ts:53`
  // 「No 'environment': the env is the session's bound runtime (notebook_bind_runtime), not a per-call
  // ...」. Passing `environment` on the execute request therefore never decided any of this.
  const useRow = settings.locator('[data-testid="named-env-row"]', { hasText: ENV_NAME })
  await expect(useRow).toBeVisible({ timeout: 30_000 })
  await useRow.getByTestId('named-env-use').click()
  await expect(settings.getByTestId('runtimes-notice')).toContainText(ENV_NAME, { timeout: 60_000 })
  console.log(
    `[v6b] bound as runtime: ${await settings.getByTestId('runtimes-notice').innerText()}`
  )

  // --- ② a real session, because a kernel belongs to a session -----------------------------------------
  page = await app.configureFakeAgent()
  await createProject(page, 'Kernel in use')
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
    return { count: list.length, id: found?.id ?? '', cwd: found?.cwd ?? '' }
  })
  console.log(`[v6b] sessions=${session.count} id=${session.id} cwd=${session.cwd}`)
  expect(session.id).not.toBe('')
  expect(session.cwd).not.toBe('')

  const readEnvironments = (): Promise<
    Array<{ processKey: string; environment?: string; status: string }>
  > =>
    page.evaluate(
      async ({ sessionId, workspaceCwd }) => {
        const bridge = globalThis as unknown as {
          api: {
            notebook: {
              state: (request: Record<string, unknown>) => Promise<{
                environments?: Array<{ processKey: string; environment?: string; status: string }>
              }>
            }
          }
        }
        const state = await bridge.api.notebook.state({ sessionId, workspaceCwd })
        return state.environments ?? []
      },
      { sessionId: session.id, workspaceCwd: session.cwd }
    )

  console.log(`[v6b] environments BEFORE any run: ${JSON.stringify(await readEnvironments())}`)

  // --- ③ start a REAL kernel on that environment -------------------------------------------------------
  const execution = await page.evaluate(
    async ({ sessionId, workspaceCwd }) => {
      const bridge = globalThis as unknown as {
        api: { notebook: { execute: (request: Record<string, unknown>) => Promise<unknown> } }
      }
      try {
        const result = await bridge.api.notebook.execute({
          sessionId,
          workspaceCwd,
          // No `environment`: exactly as the app's own notebook path calls it. The environment is the
          // session's bound runtime (bound in ①b), and routing reads that — never this request.
          code: 'print("kernel-in-use")',
          language: 'python',
          source: 'user'
        })
        return { ok: true, detail: JSON.stringify(result)?.slice(0, 160) ?? 'undefined' }
      } catch (error) {
        return { ok: false, detail: String(error).replace(/^Error: /, '') }
      }
    },
    { sessionId: session.id, workspaceCwd: session.cwd }
  )
  console.log(`[v6b] kernel start: ok=${execution.ok} ${execution.detail}`)
  expect(execution.ok, `the kernel never started, so nothing is in use: ${execution.detail}`).toBe(
    true
  )

  // The question the previous attempt could not answer: does this environment have a LIVE entry?
  const environments = await readEnvironments()
  console.log(`[v6b] environments AFTER the run: ${JSON.stringify(environments)}`)
  const mine = environments.find((entry) => entry.environment === ENV_NAME)
  const live = mine !== undefined && mine.status !== 'terminated'
  console.log(
    `[v6b] entry for ${ENV_NAME}: ${mine ? JSON.stringify(mine) : '(absent)'} => live=${live}`
  )

  // --- ④ drive the removal, and hold the app to what its own status table just said ---------------------
  settings = await openRuntimes(page)
  const namedRow = settings.locator('[data-testid="named-env-row"]', { hasText: ENV_NAME })
  await expect(namedRow).toBeVisible({ timeout: 30_000 })
  await namedRow.getByTestId('named-env-remove').click()
  await page.getByTestId('named-env-remove-confirm').click()

  const envDir = join(instanceDataRoot(app.storageRoot), 'runtime', 'envs', ENV_NAME)
  const refusal = page.getByTestId('runtimes-error')
  await expect
    .poll(async () => (await refusal.count()) > 0 || (await namedRow.count()) === 0, {
      timeout: 60_000
    })
    .toBe(true)

  if (live) {
    // The table said a kernel is live: the service must refuse, in its own words, and the environment must
    // survive. Anything else here is the defect (this is the branch the first attempt fell into).
    await expect(refusal).toContainText(REFUSAL)
    expect(existsSync(envDir)).toBe(true)
    console.log(`[v6b] REFUSED as the status table required: ${await refusal.innerText()}`)
  } else {
    // No live kernel: the removal is legitimate, so the environment must actually be gone.
    await expect(namedRow).toHaveCount(0)
    console.log('[v6b] removed — no live kernel was recorded, so nothing required a refusal')
  }
})
