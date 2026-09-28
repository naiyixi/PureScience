import { expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import * as tar from 'tar'

import { test } from './fixtures/electron-app'

// The support bundle is the one artifact a user hands to someone outside their machine, so two properties
// are load-bearing: it is really produced by the running application, and it really carries no home
// directory, no user name and no secret-shaped value. Assembly has unit tests; this drives the path a person
// actually takes — Settings → Diagnostics → the button — through the renderer, preload and IPC to a file on
// disk. The native save dialog is the single seam replaced, because no test can operate a native dialog.

const openGeneralSettings = async (page: Page): Promise<Locator> => {
  // The header entry is labelled "Model settings" in this build; match on the settings word rather than the
  // exact label so a copy change does not silently break the flow.
  await page
    .getByRole('button', { name: /settings/i })
    .first()
    .click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'General', exact: true })
    .click()
  return settings
}

const listEntries = async (bundlePath: string): Promise<string[]> => {
  const entries: string[] = []
  await tar.list({
    file: bundlePath,
    onentry: (entry) => {
      // Files only: the archive also carries directory entries, and reading one as a file is an error.
      if (entry.type === 'File') entries.push(entry.path.replace(/^\.\//, ''))
    }
  })
  return entries
}

test('exports a scrubbed support bundle from the running app', async ({ app }) => {
  const page = await app.completeOnboarding()
  const root = await mkdtemp(join(tmpdir(), 'ps-support-bundle-e2e-'))
  const bundlePath = join(root, 'support-bundle.tar.gz')

  try {
    await app.stubSaveDialog(bundlePath)
    const settings = await openGeneralSettings(page)
    const button = settings.getByRole('button', { name: /Export support bundle/ })
    await expect(button).toBeVisible()
    await button.click()

    // The panel reports where the bundle went, and the file is really there.
    await expect(settings.getByText(bundlePath)).toBeVisible()
    expect((await stat(bundlePath)).size).toBeGreaterThan(0)

    const entries = await listEntries(bundlePath)
    expect(entries).toEqual(
      expect.arrayContaining(['manifest.json', 'environment.json', 'runtime.json', 'README.txt'])
    )
    expect(entries.some((entry) => entry.startsWith('logs/'))).toBe(true)

    const extracted = join(root, 'extracted')
    await mkdir(extracted, { recursive: true })
    await tar.extract({ file: bundlePath, cwd: extracted })

    const manifest: Record<string, unknown> = JSON.parse(
      await readFile(join(extracted, 'manifest.json'), 'utf8')
    )
    expect(String(manifest.application)).toMatch(/^\d+\.\d+\.\d+/)
    expect(manifest.electron).toBeTruthy()
    expect(manifest.packaged).toBe(false)

    // The storage location is recorded as a class, never as a path.
    const runtime = await readFile(join(extracted, 'runtime.json'), 'utf8')
    expect(['default', 'custom']).toContain(JSON.parse(runtime).storageLocation)
    expect(runtime).not.toContain('/')

    // What actually ships must not carry the home directory or the user name, in any file.
    // Portable source of truth: HOME is unset on Windows, so ask the OS instead of reading the environment.
    const home = homedir()
    const userName = userInfo().username
    expect(home).not.toBe('')
    for (const entry of entries) {
      const contents = await readFile(join(extracted, entry), 'utf8')
      expect(contents).not.toContain(home)
      expect(contents).not.toContain(userName)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a cancelled export writes nothing and leaves the panel unchanged', async ({ app }) => {
  const page = await app.completeOnboarding()
  await app.stubSaveDialog(null)

  const settings = await openGeneralSettings(page)
  const button = settings.getByRole('button', { name: /Export support bundle/ })
  await button.click()
  // The button re-enables when the export settles, which is the signal that the cancelled run has finished.
  await expect(button).toBeEnabled()

  await expect(settings.getByText(/Support bundle saved to/)).toHaveCount(0)
  await expect(settings.getByRole('alert')).toHaveCount(0)
})
