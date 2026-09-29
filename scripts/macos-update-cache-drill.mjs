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
//
// Two modes share this file:
//   (default)     the local sweep drill described above — simulates what a previous version left on
//                 disk and verifies the shipped sweep against it. Runs anywhere macOS runs, including
//                 a CI runner with a packaged app, but never performs a real install.
//   --real-update the REAL in-place update (see the section below `snapshotDirectory`): two PUBLISHED
//                 Developer ID signed builds, a local asset server, and the shipped
//                 `quitAndInstall` hand-off actually replacing the .app. macOS-only, and pointless
//                 off a runner that can run the published (notarized) bundles.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { dump, load } from 'js-yaml'
import { _electron as electron } from 'playwright'

import { artifactVersion, findAppBundle } from './macos-package-smoke.mjs'

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
  const previousZip = valueFor('--previous-zip')
  const updateZip = valueFor('--update-zip')
  const updateFeed = valueFor('--update-feed')
  return {
    app: resolve(app),
    output: valueFor('--output') ? resolve(valueFor('--output')) : undefined,
    realUpdate: argv.includes('--real-update'),
    previousZip: previousZip ? resolve(previousZip) : undefined,
    updateZip: updateZip ? resolve(updateZip) : undefined,
    updateFeed: updateFeed ? resolve(updateFeed) : undefined
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

// ── The real in-place update drill (CI) ──────────────────────────────────────────────────────────
// Everything above proves the *sweep*, by handing the shipped code a cache that looks like an
// earlier version had left it. None of it proves the hand-off itself: on macOS the bundle is
// replaced by Squirrel.Mac, which refuses any replacement whose designated requirement does not
// match the running bundle — so a locally packaged (ad-hoc signed) build cannot be replaced at all,
// and no dev machine can exercise this. A CI runner can, because the PUBLISHED stable builds are
// signed with the shipping Developer ID. This mode therefore takes two published mac-arm64 zips,
// serves the newer one from a local asset server, points the older app's app-update.yml at that
// server, and drives the shipped "download -> restart to update -> app quits -> the new version
// launches" path for real, snapshotting the updater cache before and after so the U3 purge is
// measured rather than asserted.
//
// Usage:
//   node scripts/macos-update-cache-drill.mjs --real-update \
//     --previous-zip <zerolink-purescience-<old>-mac-arm64.zip> \
//     --update-zip   <zerolink-purescience-<new>-mac-arm64.zip> \
//     [--update-feed <latest-mac.yml of the new release>] \
//     [--output <path>]
const REAL_DRILL_ROOT_PREFIX = 'purescience-macos-update-drill-'
const UPDATE_OPERATION_TIMEOUT_MS = 240_000
const APP_QUIT_TIMEOUT_MS = 180_000
const BUNDLE_SWAP_TIMEOUT_MS = 180_000
const PURGE_TIMEOUT_MS = 90_000
// The signature the shipped strategy demands before it will auto-update in place
// (src/main/update/create-strategy.ts -> macCanAutoUpdate). Checked early so a signature problem is
// reported as such instead of as a puzzling "the feed offered nothing" a minute later.
const OFFICIAL_MAC_BUNDLE_ID = 'com.zerolink.purescience'
const OFFICIAL_MAC_TEAM_ID = '87G9WFU9H3'

const runProcess = (executable, args, options = {}) =>
  new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => (stdout += chunk))
    child.stderr?.on('data', (chunk) => (stderr += chunk))
    child.once('error', rejectProcess)
    child.once('exit', (code) => {
      if (code === 0) resolveProcess({ stdout, stderr })
      else
        rejectProcess(new Error(`${basename(executable)} exited with ${code}.\n${stdout}${stderr}`))
    })
  })

const extractZip = (zip, destination) =>
  runProcess('/usr/bin/ditto', ['-x', '-k', zip, destination])

const bundleVersionOnDisk = (appBundle) =>
  runProcess('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleShortVersionString',
    join(appBundle, 'Contents', 'Info.plist')
  ]).then((result) => result.stdout.trim())

// `codesign -d` writes its description to stderr and still exits 0. TeamIdentifier is absent on an
// ad-hoc signature (`not set`), which is exactly the state a locally packaged build is in.
const describeBundleSignature = async (appBundle) => {
  const result = await runProcess('/usr/bin/codesign', ['-d', '--verbose=4', appBundle]).catch(
    (error) => ({ stdout: '', stderr: String(error) })
  )
  const text = `${result.stdout}\n${result.stderr}`
  const identifier = text.match(/^Identifier=(.+)$/m)?.[1]?.trim()
  const teamIdentifier = text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim()
  return {
    identifier,
    teamIdentifier,
    adHoc: !teamIdentifier || teamIdentifier === 'not set'
  }
}

const sha512Base64 = (path) =>
  new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha512')
    const stream = createReadStream(path)
    stream.on('error', rejectHash)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('base64')))
  })

// A single `bytes=a-b` range, as electron-updater may ask for. Returns undefined when the header is
// unusable and null when the range lies past the end (a 416, not a 500).
const parseRangeHeader = (header, size) => {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header ?? '')
  if (!match) return undefined
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined
  if (start >= size || end < start) return null
  return { start, end: Math.min(end, size - 1) }
}

// The local asset server: the update feed and the installer bytes, so the drill never needs the CDN
// (and can assert what the app actually fetched).
const startAssetServer = async (routes) => {
  const metrics = { feedRequests: 0, artifactRequests: 0, artifactBytesServed: 0, rangeRequests: 0 }
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
      const path = routes.get(pathname)
      if (!path) {
        response.writeHead(404).end()
        return
      }
      const size = (await stat(path)).size
      const transfersBody = request.method !== 'HEAD'
      const isFeed = pathname === '/latest-mac.yml'
      if (transfersBody && isFeed) metrics.feedRequests += 1
      if (transfersBody && !isFeed) metrics.artifactRequests += 1
      const rangeHeader =
        typeof request.headers.range === 'string' ? request.headers.range : undefined
      let range
      if (rangeHeader) {
        range = parseRangeHeader(rangeHeader, size)
        if (range === undefined || range === null) {
          response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
          return
        }
        metrics.rangeRequests += 1
      }
      const start = range?.start ?? 0
      const end = range?.end ?? size - 1
      const length = end - start + 1
      if (transfersBody && !isFeed) metrics.artifactBytesServed += length
      response.writeHead(range ? 206 : 200, {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Length': length,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
      })
      if (request.method === 'HEAD') response.end()
      else createReadStream(path, { start, end }).pipe(response)
    })().catch((error) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The asset server has no port.')
  return {
    metrics,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      )
  }
}

const withTimeout = (promise, description, timeoutMs = UPDATE_OPERATION_TIMEOUT_MS) =>
  new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`Timed out waiting for ${description}.`)),
      timeoutMs
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        rejectPromise(error)
      }
    )
  })

// Deliberately does NOT override HOME: electron-updater resolves its cache through os.homedir()
// (AppAdapter.getAppCacheDir), so the drill and the app agree on `~/Library/Caches/<dir>` with the
// runner's real HOME, and a fake HOME would be needless risk for the first-run keychain. Only the
// Chromium profile and the storage root are isolated, via args/env the app already honours.
const launchPackagedApp = async ({ executablePath, profile, storageRoot }) => {
  const client = await electron.launch({
    executablePath,
    args: ['--lang=en-US', `--user-data-dir=${profile}`],
    env: { ...process.env, PURESCIENCE_E2E_STORAGE_ROOT: storageRoot },
    timeout: STARTUP_TIMEOUT_MS
  })
  const page = await client.firstWindow({ timeout: STARTUP_TIMEOUT_MS })
  await page.waitForFunction(() => Boolean(globalThis.window?.api?.update), undefined, {
    timeout: STARTUP_TIMEOUT_MS
  })
  const appInfo = await page.evaluate(() => globalThis.window.api.update.getAppInfo())
  return { client, page, appInfo }
}

// Drives apply() the way the user does. The UI path is preferred when the ready dialog happens to be
// on screen; the fallback is the exact IPC the "Restart to update" button's onClick calls
// (src/renderer/src/components/UpdateDialog.tsx), so either way the shipped entry point runs.
const driveRestartToUpdate = async (page, closed) => {
  const attempt = (async () => {
    const button = page.getByRole('button', { name: /restart to update|重启以更新/i })
    if ((await button.count().catch(() => 0)) > 0) {
      const clicked = await button
        .first()
        .click({ timeout: 5_000 })
        .then(
          () => true,
          () => false
        )
      if (clicked) return 'ui-button:restart-to-update'
    }
    const status = await page.evaluate(() => globalThis.window.api.update.apply())
    if (status?.state === 'error') {
      throw new Error(`the app refused to install: ${status.error ?? '(no reason given)'}`)
    }
    return `ipc:window.api.update.apply() (${status?.state ?? 'unknown'})`
  })().then(
    (label) => ({ label }),
    (error) => ({ error })
  )

  const first = await Promise.race([attempt, closed.then(() => undefined)])
  if (first?.error) {
    // apply() refused — but it may also have refused *because* the app is quitting. Only a refusal
    // that leaves the app running is a failure.
    const quitAnyway = await Promise.race([
      closed.then(() => true).catch(() => false),
      delay(10_000).then(() => false)
    ])
    if (!quitAnyway) {
      throw new Error(
        `the restart-to-update hand-off was refused: ` +
          `${first.error instanceof Error ? first.error.message : String(first.error)}`
      )
    }
    return 'app-quit-during-the-apply-hand-off'
  }
  // The app quitting is the success condition; apply()'s own promise often dies with the process.
  await closed
  return first?.label ?? 'app-quit-before-the-apply-status-settled'
}

// Kills anything still running out of the drill's temp root — including the copy Squirrel.Mac
// relaunches after the install, which is deliberately not the instance Playwright owns.
const killDrillAppProcesses = async (root) => {
  await runProcess('/usr/bin/pkill', ['-f', root]).catch(() => undefined)
}

const runRealUpdateDrill = async (options) => {
  // Declared first so even the argument/architecture guards report which step judged the run.
  let step = 'preflight'
  let application
  let server
  const home = homedir()
  const evidence = {
    schemaVersion: 1,
    mode: 'macos-real-in-place-update',
    host: { arch: process.arch, release: process.env.RUNNER_OS ?? process.platform },
    artifacts: { previousZip: options.previousZip, updateZip: options.updateZip },
    scenarios: []
  }
  const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), REAL_DRILL_ROOT_PREFIX))
  const previousDir = join(root, 'previous')
  const updateDir = join(root, 'update')
  const profileRoot = join(root, 'electron-profile')
  const storageRoot = join(root, 'storage')

  try {
    step = 'preflight'
    if (process.platform !== 'darwin') {
      throw new Error('The macOS update-cache drill requires macOS.')
    }
    if (process.arch !== 'arm64') {
      throw new Error(
        `the published arm64 bundle needs an Apple Silicon runner; this host reports ${process.arch}.`
      )
    }
    if (!options.previousZip || !options.updateZip) {
      throw new Error('--real-update needs --previous-zip <zip> and --update-zip <zip>.')
    }

    step = 'prepare'
    await Promise.all(
      [previousDir, updateDir, profileRoot, storageRoot].map((directory) =>
        mkdir(directory, { recursive: true })
      )
    )

    step = 'extract-artifacts'
    await Promise.all([
      extractZip(options.previousZip, previousDir),
      extractZip(options.updateZip, updateDir)
    ])
    const previousApp = await findAppBundle(previousDir)
    const updateApp = await findAppBundle(updateDir)
    const previousVersion = await bundleVersionOnDisk(previousApp)
    const updateVersion = await bundleVersionOnDisk(updateApp)
    evidence.previousVersion = previousVersion
    evidence.updateVersion = updateVersion
    if (previousVersion === updateVersion) {
      throw new Error(`both artifacts are ${updateVersion}; the drill needs an upgrade step.`)
    }
    if (artifactVersion(options.updateZip) !== updateVersion) {
      throw new Error(
        `the update zip is named ${artifactVersion(options.updateZip)} but contains ${updateVersion}.`
      )
    }
    console.log(`[drill] artifacts: ${previousVersion} -> ${updateVersion} (${previousApp})`)

    step = 'verify-signatures'
    const previousSignature = await describeBundleSignature(previousApp)
    const updateSignature = await describeBundleSignature(updateApp)
    evidence.signatures = { previous: previousSignature, update: updateSignature }
    console.log(
      `[drill] signatures: previous=${JSON.stringify(previousSignature)} ` +
        `update=${JSON.stringify(updateSignature)}`
    )
    for (const [label, signature] of [
      ['previous', previousSignature],
      ['update', updateSignature]
    ]) {
      if (signature.identifier !== OFFICIAL_MAC_BUNDLE_ID) {
        throw new Error(
          `the ${label} bundle is not signed as ${OFFICIAL_MAC_BUNDLE_ID} ` +
            `(Identifier=${signature.identifier ?? '<none>'}); mac in-place update is unavailable`
        )
      }
      if (signature.teamIdentifier !== OFFICIAL_MAC_TEAM_ID) {
        throw new Error(
          `the ${label} bundle is not Developer ID signed (TeamIdentifier=` +
            `${signature.teamIdentifier ?? '<none>'}); mac in-place update is unavailable`
        )
      }
    }

    step = 'build-local-feed'
    const updateZipName = basename(options.updateZip)
    const [sha512, updateZipBytes] = await Promise.all([
      sha512Base64(options.updateZip),
      stat(options.updateZip).then((info) => info.size)
    ])
    if (options.updateFeed) {
      const publishedFeed = load(await readFile(options.updateFeed, 'utf8'))
      const publishedVersion =
        publishedFeed?.version != null ? String(publishedFeed.version) : undefined
      evidence.publishedFeed = {
        version: publishedVersion,
        // The published mac feed is what an installed app polls; whether it advertises an arm64 zip
        // is evidence in its own right (a mismatch is a production finding, not a drill failure).
        advertisesArm64: (publishedFeed?.files ?? []).some((file) =>
          String(file?.url ?? '').includes('arm64')
        )
      }
      console.log(`[drill] published mac feed: ${JSON.stringify(evidence.publishedFeed)}`)
      if (publishedVersion && publishedVersion !== updateVersion) {
        throw new Error(
          `the published feed names ${publishedVersion} but the update zip contains ${updateVersion}.`
        )
      }
    }
    const feedPath = join(root, 'latest-mac.yml')
    await writeFile(
      feedPath,
      `version: ${updateVersion}\n` +
        `files:\n` +
        `  - url: ${updateZipName}\n` +
        `    sha512: ${sha512}\n` +
        `    size: ${updateZipBytes}\n` +
        `path: ${updateZipName}\n` +
        `sha512: ${sha512}\n` +
        `releaseDate: '${new Date().toISOString()}'\n`,
      'utf8'
    )
    evidence.updateArtifact = { name: updateZipName, bytes: updateZipBytes, sha512 }

    step = 'serve-assets'
    server = await startAssetServer(
      new Map([
        ['/latest-mac.yml', feedPath],
        [`/${updateZipName}`, options.updateZip]
      ])
    )
    console.log(`[drill] local update feed: ${server.url}/latest-mac.yml`)

    step = 'point-the-old-app-at-the-local-feed'
    const updateConfigPath = join(previousApp, 'Contents', 'Resources', 'app-update.yml')
    const existingConfig = await readFile(updateConfigPath, 'utf8').catch(() => undefined)
    const cacheDirName = String(
      (existingConfig ? load(existingConfig)?.updaterCacheDirName : undefined) ?? CACHE_DIR_NAME
    )
    // Only the feed URL is redirected. The cache directory name is left exactly as the release ships
    // it, because the version that installs itself carries its own app-update.yml: if the two named
    // different directories, the new version's sweep would look somewhere else and the purge below
    // would be unobservable rather than proven.
    await writeFile(
      updateConfigPath,
      dump(
        {
          provider: 'generic',
          url: server.url,
          channel: 'latest',
          updaterCacheDirName: cacheDirName
        },
        { lineWidth: -1 }
      ),
      'utf8'
    )
    const updateBundleConfig = await readFile(
      join(updateApp, 'Contents', 'Resources', 'app-update.yml'),
      'utf8'
    ).catch(() => undefined)
    if (!updateBundleConfig) {
      throw new Error('the update bundle carries no app-update.yml; it cannot resolve its cache.')
    }
    const updateCacheDirName = String(load(updateBundleConfig)?.updaterCacheDirName ?? cacheDirName)
    if (updateCacheDirName !== cacheDirName) {
      throw new Error(
        `the update bundle resolves its cache to "${updateCacheDirName}" while the package was ` +
          `downloaded into "${cacheDirName}"; the post-install purge could not be observed`
      )
    }
    const cacheDir = join(home, 'Library', 'Caches', cacheDirName)
    evidence.updater = { configPath: updateConfigPath, cacheDirName, cacheDir }
    console.log(`[drill] updater cache under test: ${cacheDir}`)
    await rm(cacheDir, { force: true, maxRetries: 5, recursive: true })

    step = 'launch-previous-version'
    application = await launchPackagedApp({
      executablePath: join(previousApp, 'Contents', 'MacOS', 'PureScience'),
      profile: profileRoot,
      storageRoot
    })
    if (String(application.appInfo.version) !== previousVersion) {
      throw new Error(
        `the launched app reports ${application.appInfo.version}; expected ${previousVersion}.`
      )
    }
    const cacheDirResolvedByApp = await readUpdaterCacheDirFromApp(application.client)
    evidence.cacheDirResolvedByApp = cacheDirResolvedByApp
    console.log(
      `[drill] running ${previousVersion}; the app resolved its cache to ` +
        `${JSON.stringify(cacheDirResolvedByApp)}`
    )

    step = 'check-for-update'
    const checked = await withTimeout(
      application.page.evaluate(() => globalThis.window.api.update.check()),
      'the update check against the local feed'
    )
    console.log(`[drill] check() -> ${JSON.stringify(checked)}`)
    if (checked.state !== 'available' || checked.latest !== updateVersion) {
      throw new Error(
        `the app did not discover ${updateVersion} from the local feed: ${JSON.stringify(checked)}`
      )
    }

    step = 'download-update'
    const downloaded = await withTimeout(
      application.page.evaluate(() => globalThis.window.api.update.download()),
      'the update download from the local feed'
    )
    console.log(`[drill] download() -> ${JSON.stringify(downloaded)}`)
    if (downloaded.state !== 'ready' || downloaded.applyKind !== 'restart') {
      throw new Error(
        `the app staged state=${downloaded.state} applyKind=${downloaded.applyKind}; only a ` +
          `'restart' hand-off replaces the .app in place`
      )
    }
    const cacheBefore = await snapshotDirectory(cacheDir)
    if (cacheBefore.bytes < 1) {
      throw new Error(`the updater cache held nothing to clean up after the download: ${cacheDir}`)
    }
    console.log(
      `[drill] downloaded package before the install: ${cacheBefore.files.length} files, ` +
        `${cacheBefore.bytes} bytes`
    )
    for (const file of cacheBefore.files) console.log(`  ${file.name} ${file.bytes}B`)

    step = 'restart-to-update'
    const closed = withTimeout(
      application.client.waitForEvent('close'),
      'the app to quit for the install',
      APP_QUIT_TIMEOUT_MS
    )
    const appliedVia = await driveRestartToUpdate(application.page, closed)
    const quitObservedAt = Date.now()
    console.log(`[drill] restart-to-update driven via ${appliedVia}; the app quit`)
    evidence.scenarios.push({
      name: 'download-then-restart-to-update-quits-the-app',
      appliedVia,
      cacheBytesBefore: cacheBefore.bytes,
      cacheFilesBefore: cacheBefore.files,
      passed: true
    })
    application = undefined

    step = 'observe-bundle-replacement'
    const swappedVersion = await waitFor(
      'the on-disk bundle to become the new version',
      async () => {
        const version = await bundleVersionOnDisk(previousApp).catch(() => undefined)
        return version === updateVersion ? version : false
      },
      BUNDLE_SWAP_TIMEOUT_MS
    ).catch(async (error) => {
      // "it never became the new version" is much weaker evidence than "the bundle still says X" —
      // name what is actually on disk at the path Squirrel.Mac was supposed to replace.
      const observed = await bundleVersionOnDisk(previousApp).catch(() => 'unreadable')
      throw new Error(`${error.message}; the bundle at ${previousApp} still reports ${observed}`)
    })
    console.log(
      `[drill] Squirrel.Mac replaced the bundle with ${swappedVersion} after ` +
        `${Date.now() - quitObservedAt}ms`
    )

    step = 'relaunch-new-version'
    application = await launchPackagedApp({
      executablePath: join(previousApp, 'Contents', 'MacOS', 'PureScience'),
      profile: profileRoot,
      storageRoot
    })
    if (String(application.appInfo.version) !== updateVersion) {
      throw new Error(
        `the bundle at the original path reports ${application.appInfo.version}; ` +
          `expected ${updateVersion}.`
      )
    }
    console.log(`[drill] the new version is running: ${application.appInfo.version}`)

    step = 'purge-after-the-install'
    const cacheAfter = await waitFor(
      'the downloaded package to be purged after the install landed',
      async () => {
        const snapshot = await snapshotDirectory(cacheDir)
        return snapshot.exists && snapshot.files.length === 0 ? snapshot : false
      },
      PURGE_TIMEOUT_MS
    ).catch(async (error) => {
      const snapshot = await snapshotDirectory(cacheDir)
      throw new Error(
        `${error.message}; the cache still holds ${snapshot.files.length} files / ` +
          `${snapshot.bytes} bytes`
      )
    })
    evidence.scenarios.push({
      name: 'the-install-landed-then-the-downloaded-package-was-purged',
      fromVersion: previousVersion,
      toVersion: updateVersion,
      cacheBytesBefore: cacheBefore.bytes,
      cacheFilesBefore: cacheBefore.files,
      cacheBytesAfter: cacheAfter.bytes,
      cacheFilesAfter: cacheAfter.files,
      passed: cacheAfter.bytes === 0 && cacheAfter.files.length === 0
    })
    console.log(
      `[drill] updater cache after the install: ${cacheAfter.files.length} files, ` +
        `${cacheAfter.bytes} bytes (was ${cacheBefore.bytes})`
    )
  } catch (error) {
    evidence.error = `${step}: ${error instanceof Error ? error.message : String(error)}`
    if (error instanceof Error) error.step = step
    throw error
  } finally {
    if (application) await closeApp(application.client).catch(() => {})
    await killDrillAppProcesses(root)
    if (server) {
      evidence.serverMetrics = server.metrics
      await server.close().catch(() => {})
    }
    if (options.output) {
      await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    }
    console.log(`[drill] local feed served: ${JSON.stringify(evidence.serverMetrics ?? {})}`)
    await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 })
  }

  const failed = evidence.scenarios.filter((scenario) => !scenario.passed)
  if (failed.length > 0) {
    throw new Error(`macOS update drill failed: ${failed.map((s) => s.name).join(', ')}`)
  }
  console.log(`macos update drill: ok ${evidence.previousVersion}-${evidence.updateVersion}`)
}

const runSweepDrill = async () => {
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

// Mode dispatch. The real drill reports the step it died in as a single judgement line, so a red CI
// run says where the hand-off stopped instead of only that it did.
const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  if (!options.realUpdate) {
    await runSweepDrill()
    return
  }
  try {
    await runRealUpdateDrill(options)
  } catch (error) {
    const step = error?.step
    const reason = error instanceof Error ? error.message : String(error)
    console.error(
      step
        ? `macos update drill: failed at ${step}: ${reason}`
        : `macos update drill: failed: ${reason}`
    )
    throw error
  }
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
  describeBundleSignature,
  parseRangeHeader,
  sha512Base64,
  startAssetServer,
  DEFAULT_APP,
  MARKER_FILE
}
