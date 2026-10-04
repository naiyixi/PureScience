import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from '../fixtures/electron-app'

// IC13 real-window acceptance for the Settings "Packages" dialog's install/uninstall.
//
// The render suite proves the dialog's wiring against a mocked bridge. This proves what a real user
// gets: the panel's own dialog, the real `runtime:manage-packages` channel, and the app's OWN package
// admission deciding — a real install, a real removal, and a real refusal, each verified against the
// environment itself rather than against the string the UI happened to print.
//
// Fixture choice (same one as the A7 lock-import run): the curated @EXPLICIT pack + its tarballs, which
// this machine already holds, hard-linked read-only into the ISOLATED instance's flat pkgs cache, so the
// environment is built with ZERO downloads. The environment is imported under the app-managed default's
// name (`default-python`) so it lands on the path discovery classifies as app-managed — the Packages
// dialog is reachable from a real card, and nothing on this machine's own environments is touched.
const REAL_RUNTIME_ROOT = join(homedir(), '.purescience', 'runtime')
const PACK_SUBDIR = process.platform === 'darwin' ? 'osx-arm64' : 'linux-64'
const PACK_DIR = join(REAL_RUNTIME_ROOT, 'packs', '1', PACK_SUBDIR, 'python-3.12')
const PACK_LOCK = join(PACK_DIR, 'python-3.12.lock')

const MANAGED_ENV = 'default-python'
// The environment the REMOVAL reading acts on. The app's own rule makes the default environment
// additive-only ("uninstall, ranges, URLs, extras, and downgrades require a named environment"), so a
// removal can only ever succeed in a named one — which is why the panel now reaches those too.
const REMOVE_ENV = 'ic13-remove-env'
// A distribution no conda channel carries, so the installer's conda attempt cannot satisfy it and the
// pip fallback (against the local index below) is what must produce it — the reading stays hermetic.
const PROBE_DIST = 'purescience-probe'
const PROBE_MODULE = 'purescience_probe'
const PROBE_VERSION = '1.0.0'
// A lock entry that is plainly not interpreter-protected, so removing it exercises the ordinary path.
const REMOVE_PACKAGE = 'matplotlib'

// The isolated instance is not a packaged build, so it ships no micromamba of its own and the provisioner
// refuses every environment command with "provisioning unavailable". Point it at the real binary through
// the documented override BEFORE the fixture launches the app (the fixture inherits this process's env).
process.env.PURESCIENCE_MICROMAMBA_BIN = join(REAL_RUNTIME_ROOT, 'micromamba', 'bin', 'micromamba')

test.setTimeout(900_000)

// A dev (unpackaged) run appends its data-folder name, so the runtime tree lives under `PureScience-DEV/`.
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

// Downloads OFF: every entry must come from the cache, so the import is deterministic and takes no
// network bytes (the lock's URLs point at a public host that is slow from here).
const disableDownloads = async (dialog: ReturnType<Page['getByTestId']>): Promise<void> => {
  const toggle = dialog.getByRole('switch', {
    name: 'Download packages missing from the local cache'
  })
  if (await toggle.isChecked()) await toggle.click()
}

const openRuntimes = async (page: Page): Promise<ReturnType<Page['getByRole']>> => {
  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Runtimes' })
    .click()

  return settings
}

// Writes a minimal, real PEP 427 wheel plus a PEP 503 `/simple/<name>/` index beside it. Built with the
// interpreter's own stdlib so the archive is a genuine wheel (METADATA + WHEEL + RECORD with real
// hashes) rather than a hand-rolled zip — the installer's pip is the thing under test, so its input has
// to be valid on its own terms.
const buildProbeIndex = (root: string): string => {
  const simpleDir = join(root, 'simple')
  const projectDir = join(simpleDir, PROBE_DIST)
  mkdirSync(projectDir, { recursive: true })
  const wheelName = `${PROBE_MODULE}-${PROBE_VERSION}-py3-none-any.whl`
  execFileSync(
    'python3',
    [
      '-c',
      `
import base64, hashlib, os, sys, zipfile
out, module, version, dist = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
distinfo = f"{module}-{version}.dist-info"
files = {
    f"{module}/__init__.py": "PROBE = 'purescience-ic13-probe'\\n",
    f"{distinfo}/METADATA": f"Metadata-Version: 2.1\\nName: {dist}\\nVersion: {version}\\n",
    f"{distinfo}/WHEEL": "Wheel-Version: 1.0\\nGenerator: purescience-ic13\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
}
record = []
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
    for name, text in files.items():
        archive.writestr(name, text)
        digest = base64.urlsafe_b64encode(hashlib.sha256(text.encode()).digest()).rstrip(b"=").decode()
        record.append(f"{name},sha256={digest},{len(text.encode())}")
    record.append(f"{distinfo}/RECORD,,")
    archive.writestr(f"{distinfo}/RECORD", "\\n".join(record) + "\\n")
print("built", out)
`,
      join(projectDir, wheelName),
      PROBE_MODULE,
      PROBE_VERSION,
      PROBE_DIST
    ],
    { encoding: 'utf8' }
  )
  writeFileSync(
    join(projectDir, 'index.html'),
    `<!DOCTYPE html><html><body><a href="${wheelName}">${wheelName}</a></body></html>\n`
  )
  return `file://${simpleDir}`
}

// The environment's OWN interpreter, so the assertion is about the environment rather than the dialog.
const envPython = (storageRoot: string, name: string): string =>
  join(instanceDataRoot(storageRoot), 'runtime', 'envs', name, 'bin', 'python')

const canImport = (python: string, module: string): boolean => {
  try {
    execFileSync(python, ['-c', `import ${module}`], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

// Builds the environment the dialog will act on, at the app-managed path, from the same local pack —
// offline, inside the isolated instance, and without touching this machine's environments. The import
// DIALOG is deliberately not used here: it reserves the app-managed names (`default-python` and
// `default-python-*` are refused by design, environment-management.ts' assertSafeEnvName callers), so the
// environment on the path discovery classifies as app-managed can only be produced the way the app's own
// provisioner produces it. Provisioning is not this unit's subject; the dialog is.
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
  // The readiness marker a successful provision stamps at the runtime root, so the instance looks
  // provisioned rather than permanently mid-setup.
  writeFileSync(
    join(runtimeRoot, '.env-ready'),
    JSON.stringify({ defaultEnvVersion: 1, preparedAt: new Date().toISOString() })
  )
  return prefix
}

test('the Packages dialog installs and removes through the app admission', async ({ app }) => {
  test.skip(!existsSync(PACK_LOCK), 'no curated pack on this machine')
  const lock = readFileSync(PACK_LOCK, 'utf8')
  const searchRoot = join(app.storageRoot, 'ic13-probe-index')
  const indexUrl = buildProbeIndex(searchRoot)

  const page = await app.completeOnboarding()
  // Capture the renderer's own diagnostics: the question here is which code path opened the dialog.
  page.on('console', (message) => {
    if (message.text().includes('[ic13-ui]')) console.log(message.text())
  })
  const seeded = seedInstanceCache(app.storageRoot, lock)
  const python = envPython(app.storageRoot, MANAGED_ENV)
  console.log(`[ic13] instanceRoot=${app.storageRoot} seeded=${seeded} index=${indexUrl}`)

  // 1. The environment the dialog acts on, built offline from the pack at the app-managed path.
  createManagedEnv(app.storageRoot, PACK_LOCK)
  expect(existsSync(python)).toBe(true)
  console.log(
    `[ic13] managed env built: ${execFileSync(python, ['-c', 'import sys; print(sys.version.split()[0])'], { encoding: 'utf8' }).trim()}`
  )
  const settings = await openRuntimes(page)

  // 2. The environment the REMOVAL reading acts on: a named one, built through the panel's own import
  //    dialog from the same cached pack. The app's rule ("uninstall … require a named environment") is
  //    why this env exists at all — removals in the app-managed default are refused by design.
  await settings.getByTestId('runtime-import-lock-python').click()
  const importDialog = page.getByTestId('runtime-import-dialog')
  await importDialog.getByTestId('runtime-import-name').fill(REMOVE_ENV)
  await importDialog.getByTestId('runtime-import-lock').fill(lock)
  await disableDownloads(importDialog)
  await importDialog.getByTestId('runtime-import-submit').click()
  await expect(importDialog.getByTestId('runtime-import-status')).toContainText(REMOVE_ENV, {
    timeout: 300_000
  })
  console.log(
    `[ic13] named env imported: ${(await importDialog.getByTestId('runtime-import-status').innerText()).replace(/\s+/g, ' ')}`
  )
  await importDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(importDialog).toHaveCount(0)
  const namedInterpreter = await page.evaluate(async (name: string) => {
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
    return result.environments.find((env) => env.name === name)?.interpreterPath
  }, REMOVE_ENV)
  console.log(`[ic13] named interpreter=${namedInterpreter}`)
  expect(namedInterpreter, 'the imported environment must report its interpreter').toBeTruthy()

  // 2. Point THIS instance's pypi index at the local one. A fixture, not a subject: the request under
  //    test is the window's install, and the app resolves its mirror from its own settings.
  await page.evaluate(async (pypiIndex: string) => {
    const { api } = globalThis as unknown as {
      api: {
        settings: {
          getPackageMirror: () => Promise<Record<string, unknown>>
          setPackageMirror: (request: Record<string, unknown>) => Promise<unknown>
        }
      }
    }
    const current = await api.settings.getPackageMirror()
    await api.settings.setPackageMirror({ ...current, pypiIndex })
  }, indexUrl)

  // 3. Find the card discovery built for that environment, and open its Packages dialog.
  const discovered = await page.evaluate(async () => {
    const { api } = globalThis as unknown as {
      api: {
        runtime: {
          listEnvironments: () => Promise<{
            python: Array<{
              envId: string
              label: string
              interpreterPath: string
              condaEnv?: string
              runnable: boolean
            }>
          }>
        }
      }
    }
    const envs = await api.runtime.listEnvironments()
    return envs.python
  })
  console.log(`[ic13] discovered=${JSON.stringify(discovered)}`)
  const managed = discovered.find((env) => env.envId === python || env.condaEnv === MANAGED_ENV)
  expect(managed, 'discovery must see the environment the dialog acts on').toBeTruthy()
  // The app's own answer for the interpreter, not an assumed path: discovery reports the REALPATH
  // (`.../bin/python3.12` under macOS' `/private` projection), while the prefix I built exposes
  // `.../bin/python` — both run, but only one of them is what the app is holding.
  const interpreter = managed!.interpreterPath
  console.log(`[ic13] interpreter=${interpreter} envId=${managed!.envId}`)

  const card = settings.locator('[data-testid="runtime-card"]', { hasText: managed!.label })
  await expect(card).toBeVisible({ timeout: 60_000 })
  await card.getByTestId('runtime-packages-button').click()
  const dialog = page.getByTestId('runtime-packages-dialog')
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  await expect(dialog.getByTestId('runtime-package-row').first()).toBeVisible({ timeout: 120_000 })
  const listed = await dialog.getByTestId('runtime-package-row').allInnerTexts()
  console.log(
    `[ic13] rows=${listed.length} hasTarget=${listed.some((row) => row.includes(REMOVE_PACKAGE))}`
  )
  expect(listed.some((row) => row.includes(REMOVE_PACKAGE))).toBe(true)

  // 4. INSTALL. The dialog asks; the app's admission decides; pip has to actually produce it. The pip
  //    switch is part of the reading: the installer's conda-first path cannot carry a pypi-only name at
  //    all (the first attempt below failed with "conda install failed." before this switch existed), so
  //    the dialog's ability to ask for pip is exactly what makes this install reachable from the window.
  expect(canImport(interpreter, PROBE_MODULE)).toBe(false)
  await dialog.getByTestId('runtime-package-use-pip').click()
  await dialog.getByTestId('runtime-package-spec').fill(PROBE_DIST)
  await dialog.getByTestId('runtime-package-install').click()
  await expect(dialog.getByTestId('runtime-package-notice')).toContainText(PROBE_DIST, {
    timeout: 300_000
  })
  console.log(
    `[ic13] install notice: ${(await dialog.getByTestId('runtime-package-notice').innerText()).replace(/\s+/g, ' ')}`
  )
  // The independent check: the environment itself can now import it.
  expect(canImport(interpreter, PROBE_MODULE)).toBe(true)
  await expect(
    dialog.getByTestId('runtime-package-row').filter({ hasText: PROBE_DIST })
  ).toHaveCount(1, { timeout: 120_000 })
  console.log('[ic13] installed=true importable=true listed=true')

  // 5. REMOVAL IS NOT AVAILABLE IN THIS SURFACE, and the reading says so in the app's own words. The
  //    default environment is additive-only by design, and the admission resolves the target from a
  //    session binding the window does not have — so the window can only ever ask the default env, where
  //    a removal is refused. Asserted verbatim; nothing here rewords it.
  const removeDialog = dialog
  await removeDialog
    .getByTestId('runtime-package-row')
    .filter({ hasText: REMOVE_PACKAGE })
    .first()
    .getByTestId('runtime-package-uninstall')
    .click()
  await expect(removeDialog.getByTestId('runtime-package-error')).toContainText(
    'additive-only, so uninstalling is not allowed',
    { timeout: 300_000 }
  )
  const removalRefusal = await removeDialog.getByTestId('runtime-package-error').innerText()
  console.log(`[ic13] removal refused: ${removalRefusal.replace(/\s+/g, ' ')}`)
  // Fail-closed: the refused click changed nothing.
  expect(canImport(interpreter, REMOVE_PACKAGE)).toBe(true)

  // 6. A NAMED environment must be refused BY NAME, never silently applied to the default — the
  //    mis-target this resolution exists to prevent. The dialog is read-only for such an env, and the
  //    reading proves the default env did NOT receive the request.
  const managedClose = removeDialog.getByRole('button', { name: 'Close' })
  if (await managedClose.count()) await managedClose.click()
  const namedRow = settings.locator('[data-testid="named-env-row"]', { hasText: REMOVE_ENV })
  await expect(namedRow).toBeVisible({ timeout: 60_000 })
  await namedRow.getByTestId('named-env-packages').click()
  const namedDialog = page.getByTestId('runtime-packages-dialog')
  await expect(namedDialog).toBeVisible({ timeout: 60_000 })
  await expect(namedDialog.getByTestId('runtime-package-row').first()).toBeVisible({
    timeout: 120_000
  })
  await namedDialog.getByTestId('runtime-package-use-pip').click()
  await namedDialog.getByTestId('runtime-package-spec').fill(PROBE_DIST)
  await namedDialog.getByTestId('runtime-package-install').click()
  await expect(namedDialog.getByTestId('runtime-package-error')).toContainText(
    'manages the app-managed default environment',
    { timeout: 120_000 }
  )
  const namedRefusal = await namedDialog.getByTestId('runtime-package-error').innerText()
  console.log(`[ic13] named env refused: ${namedRefusal.replace(/\s+/g, ' ')}`)
  expect(namedRefusal).toContain(REMOVE_ENV)
  // The independent check for the safety property: the named env did not get anything, AND the default
  // env was not touched on its behalf.
  expect(canImport(namedInterpreter!, PROBE_MODULE)).toBe(false)
  expect(canImport(interpreter, PROBE_MODULE)).toBe(true)

  // 7. The default environment's INSTALL side has its own rule, and it answers without needing any
  //    precondition from this spec: only a bare name or an exact `name==version` pin is additive. A
  //    version range is refused by the app, in its own words.
  const namedClose = namedDialog.getByRole('button', { name: 'Close' })
  if (await namedClose.count()) await namedClose.click()
  await card.getByTestId('runtime-packages-button').click()
  const gateDialog = page.getByTestId('runtime-packages-dialog')
  await expect(gateDialog).toBeVisible({ timeout: 60_000 })
  await gateDialog.getByTestId('runtime-package-spec').fill(`${REMOVE_PACKAGE}>=2`)
  await gateDialog.getByTestId('runtime-package-install').click()
  await expect(gateDialog.getByTestId('runtime-package-error')).toContainText('additive-only', {
    timeout: 120_000
  })
  const rangeRefusal = await gateDialog.getByTestId('runtime-package-error').innerText()
  console.log(`[ic13] range refused: ${rangeRefusal.replace(/\s+/g, ' ')}`)
  expect(rangeRefusal).toContain('a bare package name or an exact')
  // Fail-closed: the refused click changed nothing.
  expect(canImport(interpreter, PROBE_MODULE)).toBe(true)
})
