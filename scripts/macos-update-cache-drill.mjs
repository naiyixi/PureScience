/* eslint-disable @typescript-eslint/explicit-function-return-type */
// macOS real-machine drill for issue #17's U3: the downloaded update package must be cleaned up once
// the install it belongs to has landed, while a package that is still installable (failed install,
// rollback, or a download the user has not applied) must be left byte-for-byte alone.
//
// What is REAL here: a real Electron app running the real built main bundle from this working tree, the
// real `app.getPath` / `os.homedir()` / app-update.yml resolution the app performs at startup, real
// files on a real disk, and the shipped sweep code running on every launch. Two launch modes:
//
//   packaged-app  `--app dist/mac-arm64/PureScience.app` — the shipped bundle (used when it exists).
//                 electron-builder only writes app-update.yml for a distributable build, so the drill
//                 writes the same file a release carries (and removes it again if it created it).
//   dev-app-root  fallback when no packaged bundle is available: Electron launched with the project
//                 root as the app path, which runs `out/main/index.js` (the same bundle the packaged
//                 app runs) against the repo's own dev-app-update.yml. Same code, same cache layout,
//                 same resolution — only the asar wrapper and the bundle's Info.plist differ.
//
// What is NOT reproducible on a local machine: macOS in-place installs need the app signed with the
// shipping Developer ID (create-strategy.ts -> macCanAutoUpdate), while locally packaged builds are
// ad-hoc signed — so nothing local can make Squirrel.Mac replace the .app. The two facts that are
// therefore simulated are the ones a PREVIOUS version would have left on disk: the downloaded package
// in electron-updater's cache directory, and the `install-pending.json` marker the in-place strategy
// writes right before quitAndInstall. Both use the app's documented formats; everything after that
// (read the marker, compare with the running version, purge, retry, keep a pending package) is shipped
// code. `scripts/windows-updater-certification.mjs` covers the real handoff + real install on Windows
// and now asserts the same purge on that path.
//
// Usage: node scripts/macos-update-cache-drill.mjs [--app <PureScience.app>] [--output <path>]
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { dump, load } from 'js-yaml'
import { _electron as electron } from 'playwright'

const SMOKE_ROOT_PREFIX = 'purescience-update-cache-drill-'
const APP_ROOT = resolve(process.cwd())
const STARTUP_TIMEOUT_MS = 90_000
const SWEEP_TIMEOUT_MS = 60_000
const DEFAULT_APP = 'dist/mac-arm64/PureScience.app'
const CACHE_DIR_NAME = 'purescience-updater'
const MARKER_FILE = 'install-pending.json'
const ARTIFACT_BYTES = 32 * 1024 * 1024
const DIFFERENTIAL_BASE_BYTES = 8 * 1024 * 1024
const PARTIAL_BYTES = 1024 * 1024

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const parseArguments = (argv) => {
  const valueFor = (name) => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  const app = valueFor('--app') ?? DEFAULT_APP
  return {
    app: resolve(app),
    output: valueFor('--output') ? resolve(valueFor('--output')) : undefined
  }
}

const waitFor = async (description, check, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await check().catch(() => undefined)
    if (last !== undefined && last !== false) return last
    await delay(250)
  }
  throw new Error(
    `Timed out waiting for ${description} (last observation: ${JSON.stringify(last)})`
  )
}

const fileExists = (path) =>
  stat(path).then(
    () => true,
    () => false
  )

// Every file under the cache directory (two levels is all electron-updater uses) with its size, so the
// evidence records a byte count and a file list rather than a boolean.
const snapshotDirectory = async (root, directory = root, depth = 0) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined)
  if (!entries) return { exists: false, files: [], bytes: 0 }
  const files = []
  let bytes = 0
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && depth < 2) {
      const nested = await snapshotDirectory(root, path, depth + 1)
      files.push(...nested.files)
      bytes += nested.bytes
    } else if (entry.isFile()) {
      const size = await stat(path).then(
        (info) => info.size,
        () => 0
      )
      // Names are relative to the ROOT of the snapshot (so `pending/<artifact>` keeps its directory),
      // which keeps the evidence machine-independent and unambiguous.
      files.push({ name: path.slice(root.length + 1), bytes: size })
      bytes += size
    }
  }
  return {
    exists: true,
    files: files.sort((left, right) => left.name.localeCompare(right.name)),
    bytes
  }
}

// Picks how this machine can run the app: the shipped bundle when one exists, otherwise the project
// root (Electron runs package.json's main = out/main/index.js, the same bundle).
const resolveLaunchMode = async (options) => {
  const packagedExecutable = join(options.app, 'Contents', 'MacOS', 'PureScience')
  if (await fileExists(packagedExecutable)) {
    return {
      mode: 'packaged-app',
      executablePath: packagedExecutable,
      args: [],
      configPath: join(options.app, 'Contents', 'Resources', 'app-update.yml'),
      writesConfig: true
    }
  }
  const bundle = join(APP_ROOT, 'out', 'main', 'index.js')
  if (!(await fileExists(bundle))) {
    throw new Error(
      `No packaged app at ${options.app} and no built bundle at ${bundle}. ` +
        'Run `npm run build` (or `npm run build:unpack`) first.'
    )
  }
  return {
    mode: 'dev-app-root',
    executablePath: undefined,
    args: [APP_ROOT],
    configPath: join(APP_ROOT, 'dev-app-update.yml'),
    writesConfig: false
  }
}

const markerSource = (version) =>
  `${JSON.stringify({ version, recordedAt: new Date().toISOString() })}\n`

// Everything a completed download leaves behind: the package in pending/, its update-info.json, the
// differential base + blockmap in the cache root, and a partial from an interrupted transfer.
const seedDownloadedCache = async ({ cacheDir, version, withMarker, markerVersion }) => {
  const artifact = `PureScience-${version}-arm64-mac.zip`
  const partial = `temp-${artifact}`
  await mkdir(join(cacheDir, 'pending'), { recursive: true })
  await writeFile(join(cacheDir, 'pending', artifact), Buffer.alloc(ARTIFACT_BYTES))
  await writeFile(
    join(cacheDir, 'pending', 'update-info.json'),
    `${JSON.stringify({ fileName: artifact, sha512: 'seeded', isAdminRightsRequired: false })}\n`
  )
  await writeFile(join(cacheDir, 'pending', partial), Buffer.alloc(PARTIAL_BYTES))
  await writeFile(join(cacheDir, 'update.zip'), Buffer.alloc(DIFFERENTIAL_BASE_BYTES))
  await writeFile(join(cacheDir, 'current.blockmap'), 'seeded-blockmap')
  if (withMarker) await writeFile(join(cacheDir, MARKER_FILE), markerSource(markerVersion))
  return { artifact, partial }
}

// Each launch gets its own Electron profile (the app takes a single-instance lock per profile) while
// sharing the same HOME, which is where the updater cache lives.
const launchApp = async ({ mode, home, profile, storageRoot }) => {
  const client = await electron.launch({
    ...(mode.executablePath ? { executablePath: mode.executablePath } : {}),
    args: ['--lang=en-US', `--user-data-dir=${profile}`, ...mode.args],
    env: { ...process.env, HOME: home, PURESCIENCE_E2E_STORAGE_ROOT: storageRoot },
    timeout: STARTUP_TIMEOUT_MS
  })
  const page = await client.firstWindow({ timeout: STARTUP_TIMEOUT_MS })
  await page.waitForFunction(() => Boolean(globalThis.window?.api?.update), undefined, {
    timeout: STARTUP_TIMEOUT_MS
  })
  const appInfo = await page.evaluate(() => globalThis.window.api.update.getAppInfo())
  return { client, page, appInfo }
}

// Waits for the process to actually exit: the next launch shares the profile, and the app takes a
// single-instance lock on it.
const closeApp = async (client) => {
  if (!client) return
  const process = client.process()
  const exited = new Promise((resolveExit) =>
    process.exitCode !== null ? resolveExit() : process.once('exit', resolveExit)
  )
  await client.close().catch(() => {})
  await Promise.race([exited, delay(30_000)])
}

// The app's own resolution is the authority: ask the running main process which cache directory
// electron-updater would use. Best-effort — an unavailable internal means the drill says so instead of
// pretending it cross-checked.
const readUpdaterCacheDirFromApp = async (client) =>
  client
    .evaluate(async () => {
      try {
        // Playwright runs this inside the main process, where `require` is not on globalThis.
        const request = globalThis.require ?? process.mainModule?.require
        if (!request) return 'unavailable: no require in the main process'
        const { autoUpdater } = request('electron-updater')
        const helper = await autoUpdater.getOrCreateDownloadHelper?.()
        return helper?.cacheDir ?? 'unavailable: no download helper'
      } catch (error) {
        return `unavailable: ${error instanceof Error ? error.message : String(error)}`
      }
    })
    .catch((error) => `unavailable: ${error instanceof Error ? error.message : String(error)}`)

// The app's OWN log names the directory it purged and how many bytes it removed — the strongest
// cross-check available without a signed build: the app itself says which cache it cleaned.
const readAppPurgeLogLines = async ({ home, cacheDir }) => {
  const candidates = [
    join(home, 'Library', 'Logs', 'PureScience'),
    join(homedir(), 'Library', 'Logs', 'PureScience')
  ]
  const matched = []
  for (const directory of candidates) {
    const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.log'))
    for (const name of names) {
      const text = await readFile(join(directory, name), 'utf8').catch(() => '')
      for (const line of text.split('\n').slice(-400)) {
        if (line.includes('update cache:') && line.includes(cacheDir)) {
          matched.push({ file: join(directory, name), line: line.trim() })
        }
      }
    }
  }
  return matched.slice(-6)
}

const main = async () => {
  if (process.platform !== 'darwin') throw new Error('The macOS update-cache drill requires macOS.')
  const options = parseArguments(process.argv.slice(2))
  const mode = await resolveLaunchMode(options)
  const existingConfig = await readFile(mode.configPath, 'utf8').catch(() => undefined)
  if (mode.writesConfig) {
    // electron-builder only writes app-update.yml for a distributable build; a `--dir` build has none.
    // Write the same file the shipped build carries, so the app resolves its cache directory exactly as
    // it does in production.
    await writeFile(
      mode.configPath,
      dump({
        provider: 'generic',
        url: 'https://statics.zerolink.com/purescience/app/stable',
        channel: 'latest',
        updaterCacheDirName: CACHE_DIR_NAME
      }),
      'utf8'
    )
  }
  const configSource = await readFile(mode.configPath, 'utf8').catch(() => undefined)
  if (!configSource) throw new Error(`No updater config at ${mode.configPath}.`)
  const cacheDirName = String(load(configSource)?.updaterCacheDirName ?? CACHE_DIR_NAME)

  const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), SMOKE_ROOT_PREFIX))
  const home = join(root, 'home')
  const profile1 = join(root, 'electron-profile-1')
  const profile2 = join(root, 'electron-profile-2')
  const profile3 = join(root, 'electron-profile-3')
  const storageRoot = join(root, 'storage')
  const cacheDir = join(home, 'Library', 'Caches', cacheDirName)
  const evidence = {
    schemaVersion: 1,
    mode: 'macos-update-cache-sweep',
    launchMode: mode.mode,
    appPath: mode.mode === 'packaged-app' ? options.app : APP_ROOT,
    updaterConfig: { path: mode.configPath, existed: existingConfig !== undefined, cacheDirName },
    cacheDir,
    scenarios: []
  }
  let application
  try {
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(profile1),
      mkdir(profile2),
      mkdir(profile3),
      mkdir(storageRoot)
    ])

    // ── Scenario 1: the install landed ────────────────────────────────────────────────────────────
    // The marker names the version we are running, which is what the app proves the install by.
    const first = await launchApp({ mode, home, profile: profile1, storageRoot })
    application = first
    const appVersion = String(first.appInfo.version)
    const newerVersion = (() => {
      const parts = appVersion.split('.').map((part) => Number.parseInt(part, 10) || 0)
      parts[parts.length - 1] += 1
      return parts.join('.')
    })()
    evidence.appVersion = appVersion
    evidence.newVersion = newerVersion
    const resolvedByApp = await readUpdaterCacheDirFromApp(first.client)
    console.log(`[drill] launch mode=${mode.mode} app version=${appVersion}`)
    console.log(`[drill] app resolved cache dir: ${JSON.stringify(resolvedByApp)}`)
    await closeApp(first.client)

    await seedDownloadedCache({
      cacheDir,
      version: appVersion,
      withMarker: true,
      markerVersion: appVersion
    })
    const before1 = await snapshotDirectory(cacheDir)
    console.log(`[drill] seeded cache: ${before1.files.length} files, ${before1.bytes} bytes`)
    for (const file of before1.files) console.log(`  ${file.name} ${file.bytes}B`)

    application = await launchApp({ mode, home, profile: profile1, storageRoot })
    const purgeStartedAt = Date.now()
    await waitFor(
      'the cache directory to be purged after the landed install',
      async () => {
        const snapshot = await snapshotDirectory(cacheDir)
        return snapshot.exists && snapshot.files.length === 0 ? snapshot : false
      },
      SWEEP_TIMEOUT_MS
    ).catch(async (error) => {
      const snapshot = await snapshotDirectory(cacheDir)
      throw new Error(
        `${error.message}; cache still holds ${snapshot.files.length} files / ${snapshot.bytes} bytes`
      )
    })
    const after1 = await snapshotDirectory(cacheDir)
    evidence.scenarios.push({
      name: 'landed-install-purges-the-downloaded-package',
      appVersion,
      markerVersion: appVersion,
      before: before1,
      after: after1,
      purgeObservedAfterMs: Date.now() - purgeStartedAt,
      cacheDirResolvedByApp: resolvedByApp,
      passed: after1.files.length === 0 && after1.bytes === 0
    })
    const appLogLines = await readAppPurgeLogLines({ home, cacheDir })
    evidence.scenarios[0].appLogLines = appLogLines
    console.log(
      `[drill] scenario 1: cache ${before1.bytes} B -> ${after1.bytes} B (${after1.files.length} files) ` +
        `in ${Date.now() - purgeStartedAt}ms`
    )
    for (const entry of appLogLines) console.log(`[drill] app log: ${entry.line}`)
    if (appLogLines.length === 0) console.log('[drill] app log: no purge line found')
    await closeApp(application.client)

    // ── Scenario 2: relaunch is a no-op, and a refused purge is retried ───────────────────────────
    // Re-seeding models an install that landed while the previous purge was refused by the filesystem
    // (a lock, a permission error): the marker is still there, so the next launch must finish the job.
    await seedDownloadedCache({
      cacheDir,
      version: appVersion,
      withMarker: true,
      markerVersion: appVersion
    })
    const before2 = await snapshotDirectory(cacheDir)
    application = await launchApp({ mode, home, profile: profile2, storageRoot })
    const relaunchStartedAt = Date.now()
    await waitFor(
      'the retried purge to finish',
      async () => {
        const snapshot = await snapshotDirectory(cacheDir)
        return snapshot.exists && snapshot.files.length === 0 ? snapshot : false
      },
      SWEEP_TIMEOUT_MS
    )
    const after2 = await snapshotDirectory(cacheDir)
    evidence.scenarios.push({
      name: 're-entrant-purge-on-a-later-launch',
      before: before2,
      after: after2,
      purgeObservedAfterMs: Date.now() - relaunchStartedAt,
      passed: after2.files.length === 0
    })
    console.log(`[drill] scenario 2: re-entrant purge ${before2.bytes} B -> ${after2.bytes} B`)

    // A further launch with an already-empty cache must stay clean (idempotent, and it must not crash).
    await closeApp(application.client)
    application = await launchApp({ mode, home, profile: profile2, storageRoot })
    await delay(3000)
    const after2b = await snapshotDirectory(cacheDir)
    evidence.scenarios.push({
      name: 'empty-cache-stays-empty',
      after: after2b,
      passed: after2b.files.length === 0
    })
    console.log(`[drill] scenario 2b: cache stayed at ${after2b.bytes} B`)
    await closeApp(application.client)

    // ── Scenario 3: nothing installable is ever removed ───────────────────────────────────────────
    // The install did NOT land (the app came back on the old version) — the package must survive
    // byte-identical so the user can retry, while a never-usable partial download goes.
    const seeded = await seedDownloadedCache({
      cacheDir,
      version: newerVersion,
      withMarker: true,
      markerVersion: newerVersion
    })
    const artifactPath = join('pending', seeded.artifact)
    const partialPath = join('pending', seeded.partial)
    const before3 = await snapshotDirectory(cacheDir)
    application = await launchApp({ mode, home, profile: profile3, storageRoot })
    await waitFor(
      'the orphaned partial download to be removed',
      async () => {
        const snapshot = await snapshotDirectory(cacheDir)
        return snapshot.files.some((file) => file.name === partialPath) ? false : snapshot
      },
      SWEEP_TIMEOUT_MS
    )
    await delay(3000)
    const after3 = await snapshotDirectory(cacheDir)
    const artifactBefore = before3.files.find((file) => file.name === artifactPath)
    const artifactAfter = after3.files.find((file) => file.name === artifactPath)
    const markerStillThere = after3.files.some((file) => file.name === MARKER_FILE)
    const partialRemoved = !after3.files.some((file) => file.name === partialPath)
    evidence.scenarios.push({
      name: 'rollback-keeps-the-installable-package',
      artifact: artifactPath,
      before: artifactBefore,
      after: artifactAfter,
      markerStillThere,
      before3,
      after3,
      passed:
        artifactAfter?.bytes === artifactBefore?.bytes &&
        artifactAfter?.bytes === ARTIFACT_BYTES &&
        partialRemoved &&
        markerStillThere
    })
    console.log(
      `[drill] scenario 3: pending package ${artifactBefore?.bytes} B -> ${artifactAfter?.bytes} B, ` +
        `marker kept=${markerStillThere}, partial removed=${partialRemoved}`
    )
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    await closeApp(application?.client)
    if (options.output)
      await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    console.log(
      `[drill] scenarios: ${evidence.scenarios
        .map((scenario) => `${scenario.name}=${scenario.passed ? 'passed' : 'FAILED'}`)
        .join(', ')}`
    )
    await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 })
    if (mode.writesConfig && existingConfig === undefined) {
      await rm(mode.configPath, { force: true })
    }
  }
  const failed = evidence.scenarios.filter((scenario) => !scenario.passed)
  if (failed.length > 0) {
    throw new Error(`Update-cache drill failed: ${failed.map((s) => s.name).join(', ')}`)
  }
  console.log('macOS update-cache drill completed successfully.')
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

export {
  parseArguments,
  readUpdaterCacheDirFromApp,
  resolveLaunchMode,
  seedDownloadedCache,
  snapshotDirectory,
  markerSource,
  DEFAULT_APP,
  MARKER_FILE
}
