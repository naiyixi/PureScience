import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// IC15 real-window acceptance for the kernel controls.
//
// The render suite proves the buttons are wired against a mocked bridge; this proves a real user gets
// them: a REAL python kernel (a python cell through the notebook MCP), the pane's own controls, and the
// real `notebook:restart` / `notebook:shutdown` channels. It also pins the gap this unit closed — before
// it, a restart was only reachable from the R-only recommendation banner, so a python kernel had no entry
// at all.
//
// Fixture: the curated @EXPLICIT pack the IC13/IC14 runs use, hard-linked into the ISOLATED instance's
// cache so the app-managed environment is built with zero downloads and nothing on this machine is touched.
const REAL_RUNTIME_ROOT = join(homedir(), '.purescience', 'runtime')
const PACK_SUBDIR = process.platform === 'darwin' ? 'osx-arm64' : 'linux-64'
const PACK_DIR = join(REAL_RUNTIME_ROOT, 'packs', '1', PACK_SUBDIR, 'python-3.12')
const PACK_LOCK = join(PACK_DIR, 'python-3.12.lock')
const MANAGED_ENV = 'default-python'

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

const createManagedEnv = (storageRoot: string, lockPath: string): string => {
  const runtimeRoot = join(instanceDataRoot(storageRoot), 'runtime')
  const prefix = join(runtimeRoot, 'envs', MANAGED_ENV)
  execFileSync(
    join(REAL_RUNTIME_ROOT, 'micromamba', 'bin', 'micromamba'),
    [
      'create',
      '--yes',
      '--offline',
      '--no-rc',
      '-r',
      runtimeRoot,
      '-p',
      prefix,
      '--file',
      lockPath
    ],
    { stdio: 'pipe' }
  )
  writeFileSync(
    join(runtimeRoot, '.env-ready'),
    JSON.stringify({ defaultEnvVersion: 1, preparedAt: new Date().toISOString() })
  )
  return prefix
}

test('restarts and shuts down the kernel from the pane, with a receipt for each', async ({
  app
}) => {
  test.skip(!existsSync(PACK_LOCK), 'no curated pack on this machine')
  const lock = readFileSync(PACK_LOCK, 'utf8')
  let page = await app.completeOnboarding()
  const seeded = seedInstanceCache(app.storageRoot, lock)
  createManagedEnv(app.storageRoot, PACK_LOCK)
  console.log(`[ic15] instanceRoot=${app.storageRoot} seeded=${seeded}`)

  page = await app.configureFakeAgent()
  await createProject(page, 'Kernel controls')
  await sendPrompt(page, 'Run a python cell.', 'Python cell ran.', 180_000)

  await expect(page.getByTestId('kernel-notebook-pane')).toBeAttached({ timeout: 60_000 })
  await page.getByTestId('workspace-preview-toggle').click()
  const pane = page.getByTestId('kernel-notebook-pane')
  await expect(pane).toBeVisible({ timeout: 30_000 })

  // The gap this unit closed: this session's kernel is PYTHON, so before the controls existed there was
  // no restart/shutdown entry anywhere in the pane. Both controls must be present AND usable — a disabled
  // control would be the empty-shell version of this feature.
  const controls = pane.getByTestId('kernel-controls')
  await expect(controls).toBeVisible({ timeout: 60_000 })
  const restart = pane.getByTestId('kernel-restart-button')
  const shutdown = pane.getByTestId('kernel-shutdown-button')
  await expect(restart).toBeEnabled()
  await expect(shutdown).toBeEnabled()
  // The R-only banner is NOT what is carrying them.
  await expect(page.getByTestId('r-restart-banner')).toHaveCount(0)
  console.log('[ic15] python kernel: both controls present and enabled, no R banner')

  // RESTART: the app answers with its OWN receipt — asserted by text, so a stale line cannot pass for a
  // fresh one — and the session must still be able to run afterwards.
  await restart.click()
  const notice = pane.getByTestId('notebook-kernel-notice')
  await expect(notice).toHaveText('Kernel restarted', { timeout: 120_000 })
  console.log(`[ic15] restart receipt: ${(await notice.innerText()).replace(/\s+/g, ' ')}`)
  await expect(restart).toBeEnabled({ timeout: 120_000 })
  await sendPrompt(page, 'Run a python cell. #2', 'Python cell ran (#2).', 180_000)
  console.log('[ic15] a python cell still runs after the restart')

  // SHUTDOWN: same channel the agent uses to close a session, from the pane's own control. Its receipt is
  // a DIFFERENT sentence, which is what proves the pane reported this action rather than leaving the
  // restart line on screen.
  await shutdown.click()
  await expect(notice).toHaveText('Kernel closed', { timeout: 120_000 })
  console.log(`[ic15] shutdown receipt: ${(await notice.innerText()).replace(/\s+/g, ' ')}`)
  await expect(shutdown).toBeEnabled({ timeout: 120_000 })
  // The pane re-reads the session after the receipt rather than treating it as a snapshot, so a kernel
  // can be started again on demand.
  await sendPrompt(page, 'Run a python cell. #3', 'Python cell ran (#3).', 180_000)
  console.log('[ic15] a python cell runs again after the shutdown')
})
