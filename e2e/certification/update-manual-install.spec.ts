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

// The console mirror of the app's logger is `[scope] msg` (plus the record's data on the next line), and
// it wraps with colour escapes. Both helpers work on this launch's own captured output — the only log a
// spec can attribute to *this* instance — never on `~/Library/Logs/…/main.log`, which a developer instance
// on the same machine also appends to.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

const launchLogLines = async (logPath: string): Promise<string[]> =>
  (await readFile(logPath, 'utf8')).replace(ANSI, '').split('\n')

// One line per manifest fetch: the app's correlated-fetch wrapper logs `req-… <url> -> <status>`.
const manifestRequestLines = (lines: readonly string[]): string[] =>
  lines.filter((line) => line.includes('[http-request]') && line.includes('/version.json'))

// Anything the update scope calls a failure. The mirror carries no level field, so this is the wording the
// scope would have to use to report one; a `ready` status plus zero such lines is what "no error-level
// record on one check" can honestly be read as here.
const updateFailureLines = (lines: readonly string[]): string[] =>
  lines.filter((line) => line.includes('[update]') && /error|failed|refus/i.test(line))

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

// Which updater this launch gets. A Developer-ID-signed stable build is routed to the in-place updater,
// so on the release lane the manifest flow below would never run and its cold-start count would stay at
// zero (measured: release runs 43384543262 and 43394830799 both failed here on `macos-arm64` for exactly
// that reason). Ask for the installer flow by name: it is still what nightly and ad-hoc builds ship and
// what every install falls back to when the bundle's signature cannot be attributed, so it keeps its own
// end-to-end certification on a signed bundle. The switch itself is pinned in
// `src/main/update/create-strategy.test.ts`; the in-place flow's real-machine reading is its own item.
process.env.PURESCIENCE_UPDATE_FLOW = 'installer'

test.afterAll(() => {
  // Module scope runs once per worker: leave nothing behind for whichever spec runs next.
  delete process.env.PURESCIENCE_UPDATE_FLOW
})

test('the update installer downloads, verifies, and tells a macOS reader to replace it by hand', async ({
  app
}) => {
  const page = await app.completeOnboarding()
  // This launch's own captured output: the app's logger mirror. A record here cannot belong to another
  // process, which `~/Library/Logs/…/main.log` cannot promise on a developer's machine.
  const launchLogPath = app.currentLaunchLogPath
  expect(launchLogPath).toBeTruthy()
  const logPath = launchLogPath as string
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
  // The launch's own automatic check (the update scheduler fires one at start) is the first half of the
  // criterion: a cold start must cost exactly one manifest request and record no failure. Counted on this
  // launch's own output, and waited for — onboarding can finish before the scheduler's request lands.
  await expect
    .poll(async () => manifestRequestLines(await launchLogLines(logPath)).length, {
      timeout: 30_000
    })
    .toBe(1)
  const coldStartRequests = manifestRequestLines(await launchLogLines(logPath)).length
  const coldStartFailures = updateFailureLines(await launchLogLines(logPath))
  expect(coldStartRequests).toBe(1)
  expect(coldStartFailures).toEqual([])
  // Where the count starts for the reader's own check: everything above belongs to the cold start.
  const requestsBefore = manifestRequestLines(await launchLogLines(logPath)).length
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

  // --- The unit's completion criterion: one check → one network request, no failure record -------------
  // Poll rather than read once: the logger appends on a promise chain, so the record lands a moment after
  // the UI already shows `ready`.
  await expect
    .poll(async () => manifestRequestLines(await launchLogLines(logPath)).length - requestsBefore, {
      timeout: 30_000
    })
    .toBe(1)
  // And still one after the download: a second manifest fetch here would be a check the reader never asked
  // for (a retry storm), which is exactly what the criterion rules out.
  const appendedRequests = manifestRequestLines(await launchLogLines(logPath))
  expect(appendedRequests.length - requestsBefore).toBe(1)
  expect(appendedRequests[appendedRequests.length - 1]).toContain('-> 200')
  const updateFailures = updateFailureLines(await launchLogLines(logPath))
  expect(updateFailures).toEqual([])

  console.log(
    `[update-cert] state=ready artifact=${host.file} bytes=${written.byteLength} sha256=${writtenDigest.slice(0, 12)} installer=${'yes'} coldStartRequests=${coldStartRequests} coldStartFailures=${coldStartFailures.length} manifestRequests=${appendedRequests.length - requestsBefore} updateFailures=${updateFailures.length}`
  )

  await rm(downloadDir, { recursive: true, force: true })
})
