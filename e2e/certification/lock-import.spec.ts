import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'

// A7 real-window acceptance for the Runtimes lock-import entry.
//
// The render suite proves the dialog's wiring against a mocked bridge; this proves the contract a real
// user gets: the panel's own button, the real `runtime:import-lock` channel, a REAL environment built by
// the app's provisioner, and — on the failing path — the app's own named per-entry reasons on screen.
//
// Fixture choice: an @EXPLICIT lock plus its tarballs. This machine's download caches only retain a
// partial interpreter closure, so the self-contained curated pack is the one complete, checksum-consistent
// archive set; it is hard-linked (read-only) into the ISOLATED instance's flat pkgs cache so the import
// runs with zero downloads.
const REAL_RUNTIME_ROOT = join(homedir(), '.purescience', 'runtime')
const PACK_SUBDIR = process.platform === 'darwin' ? 'osx-arm64' : 'linux-64'
const PACK_DIR = join(REAL_RUNTIME_ROOT, 'packs', '1', PACK_SUBDIR, 'python-3.12')
const PACK_LOCK = join(PACK_DIR, 'python-3.12.lock')

// The isolated instance is not a packaged build, so it ships no micromamba of its own and the provisioner
// refuses every environment command with "provisioning unavailable". Point it at the real binary through
// the documented override BEFORE the fixture launches the app (the fixture inherits this process's env).
process.env.PURESCIENCE_MICROMAMBA_BIN = join(REAL_RUNTIME_ROOT, 'micromamba', 'bin', 'micromamba')

test.setTimeout(300_000)

const openRuntimes = async (page: Page): Promise<ReturnType<Page['getByRole']>> => {
  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Runtimes' })
    .click()

  return settings
}

// The isolated instance's DATA root is derived, not equal to the fixture's storage root: a dev
// (unpackaged) run appends its data-folder name, so the runtime tree lives under `PureScience-DEV/`.
// Seeding the storage root directly put the archives one segment too high and the import silently fell
// back to downloading all 82 packages — the real-window run is what showed that.
const instanceDataRoot = (storageRoot: string): string => join(storageRoot, 'PureScience-DEV')

// Hard-links every lock entry from the curated pack into the isolated instance's flat pkgs cache (the
// layout the app's own offline pack seeding produces). Read-only against the real runtime root.
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

// Downloads OFF: every entry must come from the cache, so both cases are deterministic and take no
// network bytes (the lock's URLs point at a public host that is slow from here).
const disableDownloads = async (dialog: ReturnType<Page['getByTestId']>): Promise<void> => {
  const toggle = dialog.getByRole('switch', {
    name: 'Download packages missing from the local cache'
  })
  if (await toggle.isChecked()) await toggle.click()
}

test('the panel imports an environment from an external lock, with zero downloads', async ({
  app
}) => {
  test.skip(!existsSync(PACK_LOCK), 'no curated pack on this machine')
  const lock = readFileSync(PACK_LOCK, 'utf8')
  const expectedEntries = lock.split('\n').filter((line) => /^https?:\/\//.test(line.trim())).length

  const page = await app.completeOnboarding()
  const seeded = seedInstanceCache(app.storageRoot, lock)
  console.log(`[a7-window] instanceRoot=${app.storageRoot} seeded=${seeded}/${expectedEntries}`)

  const settings = await openRuntimes(page)
  await settings.getByTestId('runtime-import-lock-python').click()
  const dialog = page.getByTestId('runtime-import-dialog')
  await expect(dialog).toBeVisible()

  await dialog.getByTestId('runtime-import-name').fill('lock-import-env')
  await dialog.getByTestId('runtime-import-lock').fill(lock)
  await disableDownloads(dialog)
  await dialog.getByTestId('runtime-import-submit').click()

  await expect(dialog.getByTestId('runtime-import-status')).toContainText('lock-import-env', {
    timeout: 240_000
  })
  const status = await dialog.getByTestId('runtime-import-status').innerText()
  const missing = await dialog.getByTestId('runtime-import-missing-entry').count()
  console.log(`[a7-window] success: ${status.replace(/\s+/g, ' ')}`)
  console.log(`[a7-window] missingEntries=${missing}`)
  expect(missing).toBe(0)
  // "0 downloaded" is the claim that matters: the import took no network bytes.
  expect(status).toContain(`${expectedEntries} from cache`)
  expect(status).toContain('0 downloaded')

  // The created environment is REAL: its interpreter is on disk under the instance's own data root and
  // it runs. NOTE (recorded, not asserted away): a named env does NOT appear as a Settings runtime card —
  // those cards come from interpreter DISCOVERY, while this env lives in the notebook runtime root as a
  // named environment (the list notebooks select from). Whether it should also surface there is a product
  // decision, tracked in the evidence file rather than claimed here.
  const cardCount = await settings
    .locator('[data-testid="runtime-card"]', { hasText: 'lock-import-env' })
    .count()
  console.log(`[a7-window] runtimeCardsForImportedEnv=${cardCount}`)
  const bin = join(
    instanceDataRoot(app.storageRoot),
    'runtime',
    'envs',
    'lock-import-env',
    'bin',
    'python'
  )
  expect(existsSync(bin)).toBe(true)
  const printed = execFileSync(
    bin,
    ['-c', 'import json,sys; print(json.dumps(list(sys.version_info[:3])))'],
    { encoding: 'utf8' }
  ).trim()
  console.log(`[a7-window] interpreter=${printed}`)
  expect(JSON.parse(printed)).toEqual([3, 12, 13])

  // Audit P0-8: the env this dialog just built must be MANAGEABLE from the panel — visible in the
  // named-environment list (0 runtime CARDS is correct and expected: cards come from interpreter
  // discovery) and removable, with its files actually gone afterwards. The import dialog is closed
  // first: it is a modal, so the list behind it is not the reading we want.
  const serviceEnvs = await page.evaluate(async () => {
    const { api } = globalThis as unknown as {
      api: {
        runtime: {
          manageNamedEnvironments: (request: unknown) => Promise<{
            environments: Array<{ name: string; interpreterPath?: string }>
          }>
        }
      }
    }
    const result = await api.runtime.manageNamedEnvironments({ action: 'list' })
    return result.environments.map((env) => env.name)
  })
  console.log(`[a7-window] serviceNamedEnvs=${JSON.stringify(serviceEnvs)}`)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)

  const namedRow = settings.locator('[data-testid="named-env-row"]', { hasText: 'lock-import-env' })
  await expect(namedRow).toBeVisible()
  console.log(
    `[a7-window] namedEnvRows=${await settings.locator('[data-testid="named-env-row"]').count()}`
  )
  await namedRow.getByTestId('named-env-remove').click()
  await page.getByTestId('named-env-remove-confirm').click()
  await expect(namedRow).toHaveCount(0)
  const envDir = join(instanceDataRoot(app.storageRoot), 'runtime', 'envs', 'lock-import-env')
  expect(existsSync(envDir)).toBe(false)
  console.log('[a7-window] namedEnvRemoved=true dirGone=true')
})

test('the dialog prints every unsatisfied entry and creates nothing', async ({ app }) => {
  test.skip(!existsSync(PACK_LOCK), 'no curated pack on this machine')
  const lines = readFileSync(PACK_LOCK, 'utf8').split('\n')
  const targetIndex = lines.findIndex((line) => /^https?:\/\//.test(line.trim()))
  const targetUrl = lines[targetIndex].split('#')[0]
  const targetFile = targetUrl.slice(targetUrl.lastIndexOf('/') + 1)
  // The archive IS in the cache; the lock's published md5 is what cannot be honoured.
  lines[targetIndex] = `${targetUrl}#${'0'.repeat(32)}`
  const corrupted = lines.join('\n')

  const page = await app.completeOnboarding()
  seedInstanceCache(app.storageRoot, readFileSync(PACK_LOCK, 'utf8'))

  const settings = await openRuntimes(page)
  await settings.getByTestId('runtime-import-lock-python').click()
  const dialog = page.getByTestId('runtime-import-dialog')
  await dialog.getByTestId('runtime-import-name').fill('bad-lock-env')
  await dialog.getByTestId('runtime-import-lock').fill(corrupted)
  await disableDownloads(dialog)
  await dialog.getByTestId('runtime-import-submit').click()

  await expect(dialog.getByTestId('runtime-import-status')).toContainText('Nothing was created', {
    timeout: 120_000
  })
  const entries = dialog.getByTestId('runtime-import-missing-entry')
  await expect(entries).toHaveCount(1)
  const reason = await entries.first().innerText()
  console.log(`[a7-window] refusal: ${reason.replace(/\s+/g, ' ')}`)
  expect(reason).toContain(targetFile)
  // The cached copy failed verification — that is NOT the same fact as "not in the cache".
  expect(reason).toContain('cached copy does not match the md5')

  // Fail-closed: no environment, and the card list never gained one.
  expect(
    existsSync(join(instanceDataRoot(app.storageRoot), 'runtime', 'envs', 'bad-lock-env'))
  ).toBe(false)
  await expect(
    settings.locator('[data-testid="runtime-card"]', { hasText: 'bad-lock-env' })
  ).toHaveCount(0)
})
