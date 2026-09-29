/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { dump, load } from 'js-yaml'
import { _electron as electron } from 'playwright'

import {
  cleanupSmokeRoot,
  createUpgradeProfileGuard,
  findSetupInstaller,
  installerVersion,
  installAndProbe,
  launchAndProbe,
  runProcess,
  uninstallAndVerify,
  waitFor,
  windowsProfileEnvironment
} from './windows-installer-smoke.mjs'

const UPDATE_TIMEOUT_MS = 180_000
const SMOKE_ROOT_PREFIX = 'purescience-installer-smoke-updater-'
const CHROMIUM_STORAGE_PATTERN =
  /(Local Storage|Session Storage|IndexedDB|leveldb|blob_storage|Crashpad|Network\\|Cache)/i

const singleFile = async (directory, pattern, description) => {
  const matches = (await readdir(directory))
    .filter((name) => pattern.test(name))
    .map((name) => join(directory, name))
  if (matches.length !== 1) {
    throw new Error(`Expected one ${description} in ${directory}; found ${matches.length}.`)
  }
  return matches[0]
}

const parseArguments = (argv) => {
  const valueFor = (name) => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  const currentDirectory = valueFor('--current-dir')
  const previousDirectory = valueFor('--previous-dir')
  const output = valueFor('--output')
  if (!currentDirectory || !previousDirectory || !output) {
    throw new Error('Usage: --current-dir <path> --previous-dir <path> --output <path>')
  }
  return {
    currentDirectory: resolve(currentDirectory),
    previousDirectory: resolve(previousDirectory),
    output: resolve(output)
  }
}

const buildLocalUpdaterConfig = (source, url) => {
  const parsed = load(source)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Installed app-update.yml is invalid.')
  }
  const updaterCacheDirName = String(parsed.updaterCacheDirName ?? '')
  if (
    !updaterCacheDirName ||
    basename(updaterCacheDirName) !== updaterCacheDirName ||
    updaterCacheDirName === '.' ||
    updaterCacheDirName === '..'
  ) {
    throw new Error('Installed app-update.yml has an unsafe updaterCacheDirName.')
  }
  const config = {
    ...parsed,
    provider: 'generic',
    url,
    channel: 'latest',
    useMultipleRangeRequest: false
  }
  return { source: dump(config, { lineWidth: -1 }), updaterCacheDirName }
}

const parseSingleRange = (header, size) => {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header ?? '')
  if (!match) throw new Error(`Unsupported HTTP range: ${header ?? '<missing>'}`)
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : size - 1
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0
  ) {
    throw new Error(`Invalid HTTP range: ${header}`)
  }
  if (start >= size) return undefined
  if (end < start) throw new Error(`Invalid HTTP range: ${header}`)
  return { start, end: Math.min(end, size - 1) }
}

const rewriteFeedPaths = (source, version) =>
  source.replace(
    /^(\s*(?:- )?(?:path|url):\s*)(?!https?:|releases\/)([^\s].*)$/gm,
    (_match, prefix, name) => `${prefix}releases/${version}/${name}`
  )

const startAssetServer = async ({ assets, currentInstallerRoute }) => {
  const byRoute = new Map(assets.map(({ path, route }) => [route, path]))
  if (byRoute.size !== assets.length) throw new Error('Updater assets have duplicate routes.')
  const metrics = {
    feedRequests: 0,
    blockmapRequests: 0,
    rangeRequests: 0,
    fullInstallerRequests: 0,
    downloadedInstallerBytes: 0
  }
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
      if (!byRoute.has(pathname)) {
        response.writeHead(404).end()
        return
      }
      const path = byRoute.get(pathname)
      const size = (await stat(path)).size
      const rangeHeader =
        typeof request.headers.range === 'string' ? request.headers.range : undefined

      const transfersBody = request.method !== 'HEAD'
      if (transfersBody && pathname === '/latest.yml') metrics.feedRequests += 1
      if (transfersBody && pathname.endsWith('.blockmap')) metrics.blockmapRequests += 1

      let range
      if (rangeHeader) {
        try {
          range = parseSingleRange(rangeHeader, size)
        } catch {
          response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
          return
        }
        if (!range) {
          response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
          return
        }
      }

      const start = range?.start ?? 0
      const end = range?.end ?? size - 1
      const length = end - start + 1
      if (transfersBody && pathname === currentInstallerRoute) {
        if (range) metrics.rangeRequests += 1
        else metrics.fullInstallerRequests += 1
        metrics.downloadedInstallerBytes += length
      }

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
  if (!address || typeof address === 'string') throw new Error('Updater asset server has no port.')
  return {
    metrics,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      )
  }
}

const withTimeout = (promise, description, timeoutMs = UPDATE_TIMEOUT_MS) =>
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

const runElectronUpdater = async ({ executable, env, expectedVersion, cacheDir }) => {
  const application = await electron.launch({ executablePath: executable, env, timeout: 60_000 })
  let cacheBeforeApply
  try {
    const page = await application.firstWindow({ timeout: 60_000 })
    await page.waitForFunction(() => Boolean(globalThis.window?.api?.update), undefined, {
      timeout: 60_000
    })
    const checked = await withTimeout(
      page.evaluate(() => globalThis.window.api.update.check()),
      'electron-updater check'
    )
    if (checked.state !== 'available' || checked.latest !== expectedVersion) {
      throw new Error(`Unexpected updater check result: ${JSON.stringify(checked)}`)
    }
    const downloaded = await withTimeout(
      page.evaluate(() => globalThis.window.api.update.download()),
      'electron-updater differential download'
    )
    if (downloaded.state !== 'ready' || downloaded.applyKind !== 'restart') {
      throw new Error(`Unexpected updater download result: ${JSON.stringify(downloaded)}`)
    }
    if (cacheDir) {
      // U3 (#17) evidence, taken while the package is still needed: the cache must be non-empty here,
      // otherwise "empty after the install" would prove nothing.
      cacheBeforeApply = await cacheSnapshot(cacheDir)
      if (cacheBeforeApply.bytes < 1) {
        throw new Error(`The updater cache had nothing downloaded to clean up: ${cacheDir}`)
      }
    }

    const closed = withTimeout(application.waitForEvent('close'), 'electron-updater restart')
    // `apply()` resolves with the updater status; only a successful hand-over quits the app, so the two
    // outcomes race. The return value used to be discarded, and that is why five releases of red could only
    // ever say "timed out waiting for the installed version": the app refuses to run the installer when it
    // cannot fully stop its background processes, and it says exactly that in the status (issue #14).
    const applied = await Promise.race([
      page
        .evaluate(() => globalThis.window.api.update.apply())
        .catch((error) => ({
          state: 'error',
          error: error instanceof Error ? error.message : String(error)
        })),
      closed.then(() => ({ state: 'restarting' }))
    ])
    console.log(`[updater] apply() -> ${JSON.stringify(applied)}`)
    if (applied?.state === 'error') {
      throw new Error(
        `The updater refused to install (state=error): ${applied.error ?? '(no reason given)'}`
      )
    }
    await closed
  } catch (error) {
    await application.close().catch(() => {})
    throw error
  }
  return { cacheBeforeApply }
}

// Byte count + file list of a directory tree, so the evidence records what was actually on disk rather
// than a boolean. Two levels is all electron-updater's cache uses (root + `pending/`).
const cacheSnapshot = async (directory, depth = 0) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined)
  if (!entries) return { exists: false, files: [], bytes: 0 }
  const files = []
  let bytes = 0
  for (const entry of entries) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory() && depth < 2) {
      const nested = await cacheSnapshot(entryPath, depth + 1)
      files.push(...nested.files)
      bytes += nested.bytes
    } else if (entry.isFile()) {
      const size = await stat(entryPath).then(
        (info) => info.size,
        () => 0
      )
      files.push({ name: entryPath.slice(directory.length + 1), bytes: size })
      bytes += size
    }
  }
  return { exists: true, files, bytes }
}

// The startup sweep is fire-and-forget, so poll: the new version purges the package it was installed
// from on its first launch (cache-maintenance.ts), and only a real launch can prove that.
const waitForPurgedUpdateCache = async (cacheDir) => {
  const snapshot = await waitFor(
    `the update cache to be emptied after the install (${cacheDir})`,
    async () => {
      const observed = await cacheSnapshot(cacheDir)
      return observed.files.length === 0 ? observed : false
    },
    UPDATE_TIMEOUT_MS
  )
  return snapshot
}

// The installed version comes from the registry entry the NSIS install maintains, not from a PowerShell
// read of the executable's PE resource: that read kept exiting non-zero in this drill environment (the file
// was always present), so the wait below could never observe any version at all and the drill could only
// ever report a timeout (issue #14).
const registryInstalledVersion = async (env) => {
  const uninstallRoot = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  const keys = await runProcess('reg.exe', ['query', uninstallRoot], {
    allowNonZero: true,
    env,
    timeoutMs: 20_000
  }).catch(() => undefined)
  if (!keys) return undefined
  for (const key of keys.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('HKEY_'))) {
    const displayName = await runProcess('reg.exe', ['query', key, '/v', 'DisplayName'], {
      allowNonZero: true,
      env,
      timeoutMs: 20_000
    }).catch(() => undefined)
    if (!displayName || !/purescience/i.test(displayName.stdout)) continue
    const version = await runProcess('reg.exe', ['query', key, '/v', 'DisplayVersion'], {
      allowNonZero: true,
      env,
      timeoutMs: 20_000
    }).catch(() => undefined)
    const match = version?.stdout.match(/DisplayVersion\s+REG_SZ\s+(\S+)/i)
    return match?.[1]
  }
  return undefined
}

const assertDifferentialObservation = (observation) => {
  if (
    observation.feedRequests < 1 ||
    observation.blockmapRequests < 2 ||
    observation.rangeRequests < 1 ||
    observation.fullInstallerRequests !== 0 ||
    observation.downloadedInstallerBytes < 1 ||
    observation.downloadedInstallerBytes >= observation.installerBytes ||
    observation.versionedFeed !== true ||
    observation.previousInstallerCacheVerified !== true ||
    // U3 (#17): the installed app must not keep the package it was installed from.
    observation.installerCachePurged !== true ||
    observation.installerCacheBytesBefore < 1 ||
    observation.installerCacheBytesAfter !== 0 ||
    typeof observation.previousVersion !== 'string' ||
    typeof observation.currentVersion !== 'string' ||
    observation.previousVersion === observation.currentVersion
  ) {
    throw new Error(
      `Windows updater did not use a complete differential path: ${JSON.stringify(observation)}`
    )
  }
  return observation
}

// The application's own log is where the updater writes *why* it refused to install (which teardown step
// was incomplete, which process trees were not reaped). The status only repeats the user-facing sentence, so
// without this tail a red run can only ever say "timed out waiting for the installed version" — which is
// exactly what happened for five releases (issue #14).
const printPackagedAppLogTail = async (env, reason) => {
  try {
    const candidates = []
    const walk = async (directory, depth) => {
      if (depth > 4) return
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const entryPath = join(directory, entry.name)
        if (entry.isDirectory()) {
          await walk(entryPath, depth + 1)
        } else if (entry.name.endsWith('.log') && !CHROMIUM_STORAGE_PATTERN.test(entryPath)) {
          const info = await stat(entryPath).catch(() => undefined)
          if (info) candidates.push({ path: entryPath, mtimeMs: info.mtimeMs })
        }
      }
    }
    await walk(env.APPDATA, 0)
    await walk(env.LOCALAPPDATA, 0)
    // The application's own log lives under a `logs` directory; Chromium keeps its own *.log files
    // (leveldb etc.) that say nothing about the updater, so prefer `logs` and drop the storage dirs.
    candidates.sort((left, right) => {
      const rank = (candidate) => (/[\\/]logs[\\/]/i.test(candidate.path) ? 1 : 0)
      return rank(right) - rank(left) || right.mtimeMs - left.mtimeMs
    })
    const newest = candidates[0]
    if (!newest) {
      console.log(`[updater] no application log under the drill profile (${reason})`)
      return
    }
    console.log(`[updater] application log tail (${newest.path}):`)
    for (const line of (await readFile(newest.path, 'utf8')).split('\n').slice(-40)) {
      console.log(`  ${line}`)
    }
  } catch (error) {
    console.log(`[updater] could not read the application log: ${String(error)}`)
  }
}

// When the update never lands, the interesting question is where things ended up: did the installer move the
// app somewhere else, did it stall (its process still running), or did it never start? Print all three.
const describeInstallState = async (installDirectory, env) => {
  const listing = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined)
    return entries
      ? entries
          .map((entry) => entry.name)
          .slice(0, 30)
          .join(', ') || '(empty)'
      : 'unreadable'
  }
  console.log(
    `[updater] registry installed version: ${(await registryInstalledVersion(env)) ?? '(no entry)'}`
  )
  console.log(`[updater] install state: ${installDirectory} -> ${await listing(installDirectory)}`)
  console.log(`[updater] local app data: ${env.LOCALAPPDATA} -> ${await listing(env.LOCALAPPDATA)}`)
  const roots = [
    env.LOCALAPPDATA,
    join(env.LOCALAPPDATA, 'Programs'),
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)']
  ].filter(Boolean)
  for (const root of roots) {
    const found = []
    const walk = async (directory, depth) => {
      if (depth > 3) return
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const entryPath = join(directory, entry.name)
        if (entry.isDirectory()) await walk(entryPath, depth + 1)
        else if (entry.name.toLowerCase() === 'purescience.exe') found.push(entryPath)
      }
    }
    await walk(root, 0)
    if (!found.length) console.log(`[updater] no purescience.exe under ${root}`)
    for (const foundPath of found) {
      const size = await stat(foundPath)
        .then((info) => info.size)
        .catch(() => undefined)
      console.log(`[updater] found purescience.exe at ${foundPath} size=${size ?? 'unknown'}`)
    }
  }
  for (const filter of ['purescience.exe', '*setup*.exe']) {
    const tasks = await runProcess(
      'tasklist.exe',
      ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${filter}`],
      { allowNonZero: true, env, timeoutMs: 20_000 }
    ).catch(() => undefined)
    const rendered = (tasks?.stdout ?? '').trim().split('\n').slice(0, 6).join(' | ')
    console.log(`[updater] tasklist ${filter}: ${rendered || '(none)'}`)
  }
}

const main = async () => {
  if (process.platform !== 'win32')
    throw new Error('Windows updater certification requires Windows.')
  const options = parseArguments(process.argv.slice(2))
  const currentInstaller = await findSetupInstaller(options.currentDirectory)
  const previousInstaller = await findSetupInstaller(options.previousDirectory)
  const currentBlockmap = await singleFile(
    options.currentDirectory,
    /-win-x64-setup\.exe\.blockmap$/i,
    'current Windows blockmap'
  )
  const previousBlockmap = await singleFile(
    options.previousDirectory,
    /-win-x64-setup\.exe\.blockmap$/i,
    'previous Windows blockmap'
  )
  const latestFeed = await singleFile(options.currentDirectory, /^latest\.yml$/i, 'latest.yml')
  const currentVersion = installerVersion(currentInstaller)
  const previousVersion = installerVersion(previousInstaller)
  if (currentVersion === previousVersion)
    throw new Error('Updater certification needs two versions.')
  const expectedPreviousBlockmap = `${basename(currentInstaller).replaceAll(currentVersion, previousVersion)}.blockmap`
  if (basename(previousBlockmap).toLowerCase() !== expectedPreviousBlockmap.toLowerCase()) {
    throw new Error(
      `Previous blockmap is incompatible with the current feed: expected ${expectedPreviousBlockmap}.`
    )
  }
  gunzipSync(await readFile(currentBlockmap))
  gunzipSync(await readFile(previousBlockmap))

  const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), SMOKE_ROOT_PREFIX))
  const installDirectory = join(root, 'app')
  const profileDirectory = join(root, 'profile')
  const env = windowsProfileEnvironment(profileDirectory)
  const legacyConfigRoots = [
    win32.join(homedir(), '.purescience'),
    win32.join(profileDirectory, '.purescience')
  ]
  const profileGuard = createUpgradeProfileGuard(true, `updater-${randomUUID()}`)
  await Promise.all([
    mkdir(env.APPDATA, { recursive: true }),
    mkdir(env.LOCALAPPDATA, { recursive: true }),
    mkdir(env.TEMP, { recursive: true })
  ])

  let installed = false
  let assetServer
  let primaryError
  let observation
  try {
    const previousConfigRoot = await installAndProbe({
      installer: previousInstaller,
      installDirectory,
      phase: 'previous',
      env,
      legacyConfigRoots
    })
    installed = true
    await profileGuard.verifyCycle('previous', previousConfigRoot)

    const localFeed = join(root, 'latest.yml')
    await writeFile(
      localFeed,
      rewriteFeedPaths(await readFile(latestFeed, 'utf8'), currentVersion),
      'utf8'
    )
    const currentInstallerRoute = `/releases/${currentVersion}/${basename(currentInstaller)}`
    assetServer = await startAssetServer({
      assets: [
        { route: '/latest.yml', path: localFeed },
        { route: currentInstallerRoute, path: currentInstaller },
        {
          route: `/releases/${currentVersion}/${basename(currentBlockmap)}`,
          path: currentBlockmap
        },
        {
          route: `/releases/${previousVersion}/${basename(previousBlockmap)}`,
          path: previousBlockmap
        }
      ],
      currentInstallerRoute
    })
    const updateConfigPath = join(installDirectory, 'resources', 'app-update.yml')
    const updateConfig = buildLocalUpdaterConfig(
      await readFile(updateConfigPath, 'utf8'),
      assetServer.url
    )
    await writeFile(updateConfigPath, updateConfig.source, 'utf8')
    const updaterCache = join(env.LOCALAPPDATA, updateConfig.updaterCacheDirName)
    const cachedInstaller = join(updaterCache, 'installer.exe')
    // electron-builder's NSIS template copies $EXEPATH here during a normal install. Do not seed the
    // cache: observing the real installer-created file proves production differential readiness.
    const [previousInstallerInfo, cachedInstallerInfo] = await Promise.all([
      stat(previousInstaller),
      stat(cachedInstaller)
    ])
    if (cachedInstallerInfo.size !== previousInstallerInfo.size) {
      throw new Error(
        'The previous NSIS install did not retain its installer for differential use.'
      )
    }

    const { cacheBeforeApply } = await runElectronUpdater({
      executable: join(installDirectory, 'purescience.exe'),
      env,
      expectedVersion: currentVersion,
      cacheDir: updaterCache
    })
    const installerBytes = (await stat(currentInstaller)).size
    observation = assertDifferentialObservation({
      schemaVersion: 1,
      mode: 'electron-updater-differential',
      previousVersion,
      currentVersion,
      installerBytes,
      ...assetServer.metrics,
      versionedFeed: true,
      previousInstallerCacheVerified: true
    })

    // Sample the installed version as it changes instead of only polling a terminal value: the timeout
    // error alone cannot tell "the silent install never started" from "it failed" from "it finished and
    // the old version is still in place". This line is that measurement (issue #14).
    const versionWaitStartedAt = Date.now()
    let lastObservedVersion = '(not read yet)'
    await waitFor(
      `installed version ${currentVersion}`,
      async () => {
        const executable = join(installDirectory, 'purescience.exe')
        const observed = await registryInstalledVersion(env)
        // "unreadable" used to cover both "the file is gone" and "reading it failed", which are different
        // findings. Print both facts so the next timeout says which one it is.
        const fileState = await stat(executable)
          .then((info) => `present(${info.size}B)`)
          .catch((error) => `absent(${error.code ?? error.message})`)
        const rendered = `${observed ?? 'unknown'} file=${fileState}`
        if (rendered !== lastObservedVersion) {
          lastObservedVersion = rendered
          console.log(
            `[updater +${Date.now() - versionWaitStartedAt}ms] installed=${rendered} (want ${currentVersion})`
          )
        }
        return observed?.startsWith(currentVersion)
      },
      UPDATE_TIMEOUT_MS
    )
    await runProcess('taskkill.exe', ['/IM', 'purescience.exe', '/T', '/F'], {
      allowNonZero: true,
      env,
      timeoutMs: 10_000
    })
    const currentConfigRoot = await launchAndProbe({
      installDirectory,
      expectedVersion: currentVersion,
      env
    })
    await profileGuard.verifyCycle('current', currentConfigRoot)
    // U3 (#17): the new version, on its first launch, must have purged the package it was installed
    // from — the ~150 MB that used to stay in the updater cache forever.
    const cacheAfterApply = await waitForPurgedUpdateCache(updaterCache)
    observation.installerCachePurged = cacheAfterApply.files.length === 0
    observation.installerCacheBytesAfter = cacheAfterApply.bytes
    observation.installerCacheBytesBefore = cacheBeforeApply?.bytes ?? 0
    observation.installerCacheFilesBefore = cacheBeforeApply?.files ?? []
    console.log(
      `[updater] updater cache after install: ${JSON.stringify(cacheAfterApply.files)} ` +
        `(${cacheAfterApply.bytes}B, before: ${observation.installerCacheBytesBefore}B)`
    )
    assertDifferentialObservation(observation)
    await writeFile(options.output, `${JSON.stringify(observation, null, 2)}\n`, 'utf8')
    console.log('Windows electron-updater differential certification completed successfully.')
  } catch (error) {
    await describeInstallState(join(root, 'app'), env).catch((stateError) =>
      console.log(`[updater] could not describe install state: ${String(stateError)}`)
    )
    await printPackagedAppLogTail(env, String(error))
    primaryError = error
  }

  const cleanupErrors = []
  const cleanup = async (operation) => {
    try {
      await operation()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  await cleanup(() =>
    runProcess('taskkill.exe', ['/IM', 'purescience.exe', '/T', '/F'], {
      allowNonZero: true,
      env,
      timeoutMs: 10_000
    })
  )
  if (assetServer) await cleanup(() => assetServer.close())
  await cleanup(() => profileGuard.cleanup(primaryError))
  if (installed) await cleanup(() => uninstallAndVerify(installDirectory, env))
  await cleanup(() => cleanupSmokeRoot(root, primaryError ?? cleanupErrors[0]))
  if (primaryError) throw primaryError
  if (cleanupErrors[0]) throw cleanupErrors[0]
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
  assertDifferentialObservation,
  buildLocalUpdaterConfig,
  parseArguments,
  parseSingleRange,
  rewriteFeedPaths
}
