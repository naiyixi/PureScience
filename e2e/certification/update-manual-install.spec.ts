import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { expect } from '@playwright/test'

import { test } from '../fixtures/electron-app'

// What this pins, on a real machine: the whole manifest → download → digest → ready chain of the update
// path, and the two sentences a macOS reader needs before they drag a bundle into Applications.
//
// The replaced thing is the BYTES the main process receives over the network (Electron's `net.fetch`),
// which no page-level route can intercept. Everything downstream is shipped code: `UpdateService`, the
// real downloader with its streaming sha256, the status broadcast, the update store, the dialog and a real
// Chromium layout. A wrong digest is still a failed download here — the spec has to reach `ready` by
// serving bytes that hash to the value the manifest pins, not by telling the app it succeeded.
//
// The macOS sentence exists because the builds are ad-hoc signed: macOS refuses to replace a running app
// in place, so the reader is told to replace it by hand rather than discovering it mid-drag. It is only
// rendered in the `ready` state, which is why this spec downloads instead of stopping at `available`.

// The release must be newer than the app under test, or the check answers "up to date" and there is no
// dialog to download from. Derived from the app's own version so a version bump cannot silently turn this
// spec into an assertion about a dialog that never opens.
const APP_VERSION = (
  JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }
).version
const RELEASE_VERSION = `${Number(APP_VERSION.split('.')[0]) + 1}.0.0`
const CDN = `https://github.com/naiyixi/PureScience/releases/download/v${RELEASE_VERSION}`

// Deterministic installer bytes: 64 KiB is enough for the downloader's streaming path (chunks, progress,
// digest) and small enough that the spec stays a few seconds.
const ARTIFACT_BYTES = Buffer.from(
  Array.from({ length: 64 * 1024 }, (_unused, index) => (index * 31) % 251)
)

const ARTIFACTS = {
  'mac-arm64': { file: `PureScience-${RELEASE_VERSION}-arm64.dmg` },
  'mac-x64': { file: `PureScience-${RELEASE_VERSION}-x64.dmg` },
  'win-x64': { file: `PureScience-Setup-${RELEASE_VERSION}.exe` },
  'linux-x64-deb': { file: `PureScience-${RELEASE_VERSION}-amd64.deb` }
} as const

type ArtifactKey = keyof typeof ARTIFACTS

// Mirrors platformDownloadKey in src/shared/update.ts so the artifact served is the one THIS host asks for.
const hostArtifactKey = (): ArtifactKey => {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  if (process.platform === 'win32') return 'win-x64'
  return 'linux-x64-deb'
}

const sha256Of = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const manifestWith = (digest: string): unknown => ({
  version: RELEASE_VERSION,
  releaseDate: new Date().toISOString(),
  notes: { en: '## Fixed\n- A release note the dialog can render.' },
  downloads: Object.fromEntries(
    Object.entries(ARTIFACTS).map(([key, artifact]) => [
      key,
      { url: `${CDN}/${artifact.file}`, size: ARTIFACT_BYTES.byteLength, sha256: digest }
    ])
  )
})

// The sentences the product promises. Copied from the dictionary on purpose: this spec is about what the
// reader sees, so a change to the copy has to be a change here too.
const READY_INSTALLER_HINT = 'Downloaded — click “Open installer” to finish updating.'
const QUIT_BEFORE_INSTALL = 'Quit PureScience before installing — a running app cannot be replaced.'
const MAC_MANUAL_NOTE =
  'macOS builds are ad-hoc signed for now, so macOS refuses to replace a running app in place — download the installer and replace it by hand.'

test.skip(process.platform !== 'darwin', 'the ad-hoc replacement note is a macOS promise')

test('the update installer downloads, verifies, and tells a macOS reader to replace it by hand', async ({
  app
}) => {
  const page = await app.completeOnboarding()
  const host = ARTIFACTS[hostArtifactKey()]
  const downloadDir = join(app.storageRoot, 'update-cert-download')
  const target = join(downloadDir, host.file)
  await mkdir(dirname(target), { recursive: true })

  const digest = sha256Of(ARTIFACT_BYTES)
  await app.stubUpdateManifest(manifestWith(digest), [
    { fileName: host.file, base64: ARTIFACT_BYTES.toString('base64') }
  ])
  await app.stubSaveDialog(target)

  // Real UI path: Settings → General → Check now.
  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'General', exact: true })
    .click()
  const checkNow = settings.getByRole('button', { name: 'Check now' })
  await expect(checkNow).toBeEnabled({ timeout: 60_000 })
  await checkNow.click()
  const updateButton = settings.getByRole('button', { name: `Update to ${RELEASE_VERSION}` })
  await expect(updateButton).toBeVisible({ timeout: 30_000 })
  await updateButton.click()

  const dialog = page.getByRole('dialog', { name: 'Update available' })
  await expect(dialog).toBeVisible()

  // --- Reverse control: none of the ready-state sentences belong to `available` ---------------------
  await expect(dialog.getByTestId('update-ready-hint')).toHaveCount(0)
  await expect(dialog).not.toContainText(READY_INSTALLER_HINT)
  await expect(dialog).not.toContainText(QUIT_BEFORE_INSTALL)
  await expect(dialog).not.toContainText(MAC_MANUAL_NOTE)
  await expect(dialog.getByRole('button', { name: 'Open installer' })).toHaveCount(0)

  // --- The real download: the app's own downloader, its own digest check --------------------------
  const downloadButton = dialog.getByRole('button', { name: /^Download update/ })
  await expect(downloadButton).toBeEnabled()
  await downloadButton.click()
  const readyHint = dialog.getByTestId('update-ready-hint')
  await expect(readyHint).toBeVisible({ timeout: 60_000 })

  // --- What the reader is told, and what finishes the install --------------------------------------
  await expect(readyHint).toContainText(READY_INSTALLER_HINT)
  await expect(readyHint).toContainText(QUIT_BEFORE_INSTALL)
  await expect(readyHint).toContainText(MAC_MANUAL_NOTE)
  // Installer, not restart: the button says which action finishes the job, and the in-place path is not
  // offered on a bundle the OS will refuse to swap.
  await expect(dialog.getByRole('button', { name: 'Open installer' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Restart to update' })).toHaveCount(0)

  // --- The bytes on disk are the bytes served, and they hash to the pinned digest ------------------
  const written = await readFile(target)
  const writtenDigest = sha256Of(written)
  expect(written.byteLength).toBe(ARTIFACT_BYTES.byteLength)
  expect(writtenDigest).toBe(digest)
  // No half-written sibling left behind by the streaming write.
  await expect(readFile(`${target}.part`)).rejects.toThrow()

  console.log(
    `[update-cert] state=ready artifact=${host.file} bytes=${written.byteLength} sha256=${writtenDigest.slice(0, 12)} installer=${'yes'}`
  )

  await rm(downloadDir, { recursive: true, force: true })
})
