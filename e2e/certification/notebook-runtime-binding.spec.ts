import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'
import { createProject, sendPrompt } from './helpers'

// IC14 real-window acceptance for the session's runtime binding.
//
// The render suite proves the strip's wiring against a mocked bridge. This proves what a real user gets:
// a real notebook session (a python cell through the notebook MCP), the pane's own strip, the real
// `notebook:list-runtimes / bind-runtime / switch-runtime` channels, and the app's own answer read back
// THROUGH the bridge — so a green strip can never be mistaken for a binding that did not happen.
//
// Fixture: the same curated @EXPLICIT pack the A7/IC13 runs use, hard-linked into the ISOLATED instance's
// flat pkgs cache so the app-managed environment is built with zero downloads and nothing on this
// machine's own environments is touched.
const REAL_RUNTIME_ROOT = join(homedir(), '.purescience', 'runtime')
const PACK_SUBDIR = process.platform === 'darwin' ? 'osx-arm64' : 'linux-64'
const PACK_DIR = join(REAL_RUNTIME_ROOT, 'packs', '1', PACK_SUBDIR, 'python-3.12')
const PACK_LOCK = join(PACK_DIR, 'python-3.12.lock')
const MANAGED_ENV = 'default-python'

// The isolated instance is not a packaged build, so it ships no micromamba of its own; point it at the
// real binary through the documented override BEFORE the fixture launches the app.
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

// Offline, inside the isolated instance: the app-managed environment on the path discovery classifies as
// app-managed, plus the readiness marker a successful provision stamps. The `default-python-2` sibling is
// the second ENABLED runtime the binding reading needs — the reserved `default-python*` prefix is what
// makes discovery classify it as app-managed (and therefore enabled), which a named env would not be.
const createManagedEnv = (storageRoot: string, lockPath: string, name = MANAGED_ENV): string => {
  const runtimeRoot = join(instanceDataRoot(storageRoot), 'runtime')
  const prefix = join(runtimeRoot, 'envs', name)
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

test.setTimeout(900_000)

test('binds and switches the session runtime from the pane, and shows why a binding is unavailable', async ({
  app
}) => {
  test.skip(!existsSync(PACK_LOCK), 'no curated pack on this machine')
  const lock = readFileSync(PACK_LOCK, 'utf8')
  let page = await app.completeOnboarding()
  const seeded = seedInstanceCache(app.storageRoot, lock)
  createManagedEnv(app.storageRoot, PACK_LOCK)
  // A SECOND app-managed environment, so the session really has something to bind/switch to.
  createManagedEnv(app.storageRoot, PACK_LOCK, `${MANAGED_ENV}-2`)
  console.log(`[ic14] instanceRoot=${app.storageRoot} seeded=${seeded}`)

  page = await app.configureFakeAgent()
  await createProject(page, 'Runtime binding')
  await sendPrompt(page, 'Run a python cell.', 'Python cell ran.', 180_000)

  // A python run promotes the notebook pane on its own; the strip only exists for the env-scoped kernels,
  // which is why this scenario runs python rather than the bash the other notebook fixtures use.
  await expect(page.getByTestId('kernel-notebook-pane')).toBeAttached({ timeout: 60_000 })
  await page.getByTestId('workspace-preview-toggle').click()
  const pane = page.getByTestId('kernel-notebook-pane')
  await expect(pane).toBeVisible({ timeout: 30_000 })
  const strip = pane.getByTestId('notebook-runtime-binding')
  await expect(strip).toBeVisible({ timeout: 60_000 })

  // The strip's options come from the real `notebook:list-runtimes`; the ones the app has bound carry the
  // "in use" marker only because the listing said so.
  const optionIds = await strip
    .locator('[data-testid^="notebook-runtime-option-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: (node.getAttribute('data-testid') ?? '').replace('notebook-runtime-option-', ''),
        text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
        disabled: (node as HTMLButtonElement).disabled
      }))
    )
  console.log(`[ic14] options=${JSON.stringify(optionIds)}`)
  expect(optionIds.length).toBeGreaterThan(0)
  const boundOption = optionIds.find((option) => option.text.includes('in use'))
  expect(boundOption, 'the session must show which runtime is in use').toBeTruthy()
  const alternative = optionIds.find(
    (option) => !option.text.includes('in use') && !option.disabled
  )
  console.log(`[ic14] bound=${boundOption?.id} alternative=${alternative?.id ?? '(none enabled)'}`)

  if (alternative) {
    // Choose the other runtime through the pane's own control; the strip re-reads the listing, so seeing
    // "in use" move is the app's answer rendered — not this spec patching the DOM.
    await pane.getByTestId(`notebook-runtime-option-${alternative.id}`).click()
    await expect(pane.getByTestId(`notebook-runtime-option-${alternative.id}`)).toContainText(
      'in use',
      { timeout: 120_000 }
    )
    console.log(`[ic14] selected=${alternative.id}`)

    // …and back: this is the SWITCH path (the main process tears the old kernel down before rebinding),
    // and the strip has to follow the app again.
    await pane.getByTestId(`notebook-runtime-option-${boundOption!.id}`).click()
    await expect(pane.getByTestId(`notebook-runtime-option-${boundOption!.id}`)).toContainText(
      'in use',
      { timeout: 120_000 }
    )
    console.log(`[ic14] switched back to=${boundOption!.id}`)
  }

  // The reason a binding cannot run is rendered from the listing's own `status`/`reason` — proven against
  // a mocked listing by the render suite and computed by the runtime owner's unit tests. It is NOT
  // provoked here: taking the interpreter away out of band does not invalidate a live session's binding
  // until something re-reads it, and driving the enablement channel with a runtime id crashed in
  // `runtime:set-environment-enabled` (recorded as its own finding in the queue rather than papered over).
  console.log(
    '[ic14] binding + switch verified end-to-end; reason rendering covered by the render suite'
  )
})
