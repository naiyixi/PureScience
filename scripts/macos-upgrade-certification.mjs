/* eslint-disable @typescript-eslint/explicit-function-return-type */
// A macOS in-place upgrade drill, shaped like scripts/windows-updater-certification.mjs.
//
// Why this exists: v2.33.0 shipped macOS assets that were signed but not notarized, and the release note
// told readers to use v2.33.1 because "in-place auto-update is unavailable on macOS" — a sentence nothing
// had ever put to the test. Windows has had an upgrade drill for releases; macOS had none, so every claim
// about a macOS upgrade rested on reading code. This drill takes the previous release's own .app, lets it
// update itself from the live feed, and then reads back what is actually on disk.
//
// The judgement is the app's own testimony wherever there is any: `update.check()` must offer the next
// version, `update.download()` must reach `ready`, and after the hand-over the bundle at the same path must
// carry the next version — not "the process exited" and not "the log said so".

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { _electron as electron } from 'playwright'

const CHECK_TIMEOUT_MS = 240_000
const DOWNLOAD_TIMEOUT_MS = 900_000
const APPLY_TIMEOUT_MS = 240_000
const HANDOVER_TIMEOUT_MS = 240_000

const withTimeout = (promise, description) =>
  new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`Timed out after ${CHECK_TIMEOUT_MS} ms: ${description}`)),
      description.includes('download') ? DOWNLOAD_TIMEOUT_MS : CHECK_TIMEOUT_MS
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

const runProcess = (executable, args, { timeoutMs = 120_000 } = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(stdout.trim())
      else rejectPromise(new Error(`${executable} exited ${code}: ${(stderr || stdout).trim()}`))
    })
  })

const findBundle = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const direct = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
  if (direct) return join(directory, direct.name)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const nested = await findBundle(join(directory, entry.name)).catch(() => undefined)
    if (nested) return nested
  }
  return undefined
}

// `plutil` reads the bundle the way Finder does; the version it returns is the one a user sees in
// "Get Info", so a drill that compares against it cannot be satisfied by a rewritten internal field.
const bundleVersion = async (bundle) => {
  const plist = join(bundle, 'Contents', 'Info.plist')
  const short = await runProcess('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist])
  return short.trim()
}

const bundleExecutable = async (bundle) => {
  const plist = join(bundle, 'Contents', 'Info.plist')
  const name = await runProcess('plutil', ['-extract', 'CFBundleExecutable', 'raw', plist])
  return join(bundle, 'Contents', 'MacOS', name.trim())
}

const unzip = async (zip, destination) => {
  await rm(destination, { recursive: true, force: true })
  await runProcess('ditto', ['-x', '-k', zip, destination], { timeoutMs: 600_000 })
}

// What the app says about itself once it is running: `getAppInfo()` is the same reading the About panel
// shows, so it is the app's own claim rather than a string scraped from a file.
const launchAndRead = async (executable, env) => {
  const application = await electron.launch({ executablePath: executable, env, timeout: 120_000 })
  const page = await application.firstWindow({ timeout: 120_000 })
  await page.waitForFunction(() => Boolean(globalThis.window?.api?.update), undefined, {
    timeout: 120_000
  })
  const info = await withTimeout(
    page.evaluate(() => globalThis.window.api.update.getAppInfo()),
    'update.getAppInfo'
  )
  return { application, page, info }
}

// The hand-over: `apply()` either resolves with a status or the app closes under the driver. Neither
// outcome is the judgement — the judgement is the bundle on disk afterwards.
const driveUpdate = async ({ executable, env, nextVersion }) => {
  const { application, page, info } = await launchAndRead(executable, env)
  console.log(`[mac-upgrade] previous app reports ${JSON.stringify(info)}`)

  const checked = await withTimeout(
    page.evaluate(() => globalThis.window.api.update.check()),
    'update.check'
  )
  console.log(`[mac-upgrade] check() -> ${JSON.stringify(checked)}`)
  if (checked.state === 'up-to-date') {
    throw new Error(
      `The feed already says we are current (${checked.current}); the drill needs an older app than ${nextVersion}`
    )
  }
  if (checked.state !== 'available' || String(checked.latest) !== String(nextVersion)) {
    throw new Error(
      `The feed did not offer ${nextVersion}: ${JSON.stringify(checked)} — a drill that cannot see the ` +
        'next version proves nothing about upgrading to it'
    )
  }

  const downloaded = await withTimeout(
    page.evaluate(() => globalThis.window.api.update.download()),
    'update.download'
  )
  console.log(`[mac-upgrade] download() -> ${JSON.stringify(downloaded)}`)
  if (downloaded.state !== 'ready') {
    throw new Error(`The download did not reach ready: ${JSON.stringify(downloaded)}`)
  }

  const closed = new Promise((resolvePromise) => {
    application.once('close', () => resolvePromise({ closed: true }))
    setTimeout(() => resolvePromise({ closed: false }), APPLY_TIMEOUT_MS)
  })
  const applied = await Promise.race([
    page
      .evaluate(() => globalThis.window.api.update.apply())
      .catch((error) => ({ state: 'error', error: String(error) })),
    closed
  ])
  console.log(`[mac-upgrade] apply() -> ${JSON.stringify(applied)}`)
  if (applied && applied.state === 'error') {
    throw new Error(`The updater refused to install: ${applied.error}`)
  }
  await application.close().catch(() => undefined)
  return { applied, checkedAt: checked.current }
}

const waitForVersionOnDisk = async (bundle, nextVersion, budgetMs = HANDOVER_TIMEOUT_MS) => {
  const deadline = Date.now() + budgetMs
  let lastSeen
  // Read at least once before judging the deadline: an exhausted budget must still report the version
  // that is actually there, otherwise "0 ms" and "wrong version" both read as "(unreadable)".
  do {
    lastSeen = await bundleVersion(bundle).catch(() => undefined)
    if (lastSeen === nextVersion) return lastSeen
    if (Date.now() >= deadline) break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))
  } while (Date.now() < deadline)
  throw new Error(
    `The bundle at ${bundle} still reads ${lastSeen ?? '(unreadable)'} after ${budgetMs} ms; ` +
      `the hand-over did not put ${nextVersion} there`
  )
}

// Gatekeeper's own answer, not ours: a stapled, signed bundle is accepted for execution, and the drill
// prints the authority it accepted so a signature that changed hands cannot pass quietly.
const gatekeeper = async (bundle) => {
  const verdict = await runProcess('spctl', ['-a', '-vv', '--type', 'exec', bundle]).catch(
    (error) => `refused: ${error.message}`
  )
  const verify = await runProcess('codesign', ['--verify', '--deep', '--strict', bundle]).then(
    () => 'codesign --verify --deep --strict: ok',
    (error) => `codesign --verify: ${error.message}`
  )
  return { verdict: verdict.trim(), verify }
}

const main = async () => {
  const args = process.argv.slice(2)
  const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback
  }
  const previousZip = option('previous-zip')
  const nextVersion = option('next-version')
  if (!previousZip || !nextVersion) {
    console.error(
      'Usage: node scripts/macos-upgrade-certification.mjs --previous-zip <zip> --next-version <x.y.z>'
    )
    process.exit(2)
  }
  await stat(previousZip).catch(() => {
    throw new Error(`The previous release's zip is not there: ${previousZip}`)
  })

  const workRoot = option('work-dir') ?? (await mkdtemp(join(tmpdir(), 'purescience-mac-upgrade-')))
  const previousDir = join(workRoot, 'previous')
  const storageRoot = join(workRoot, 'storage')
  await unzip(previousZip, previousDir)
  const bundle = await findBundle(previousDir)
  if (!bundle) throw new Error(`No .app inside ${previousZip}`)
  const executable = await bundleExecutable(bundle)
  const fromVersion = await bundleVersion(bundle)
  console.log(`[mac-upgrade] previous bundle ${bundle} (${fromVersion})`)
  if (fromVersion === nextVersion) {
    throw new Error(
      `The "previous" bundle is already ${nextVersion}; the drill would prove nothing`
    )
  }

  // A private HOME as well as a private storage root: the packaged app keeps its single-instance lock and
  // its updater cache under `~/Library/Application Support`, and a drill that shares them with whatever the
  // machine is already running can either be refused the lock or purge somebody else's cache.
  const home = join(workRoot, 'home')
  await mkdir(home, { recursive: true })
  const env = {
    ...process.env,
    HOME: home,
    PURESCIENCE_STORAGE_ROOT: storageRoot,
    PURESCIENCE_E2E_STORAGE_ROOT: storageRoot
  }
  const { checkedAt } = await driveUpdate({ executable, env, nextVersion })
  const installed = await waitForVersionOnDisk(bundle, nextVersion)
  console.log(
    `[mac-upgrade] on disk now: ${installed} (was ${fromVersion}, check saw ${checkedAt})`
  )

  // Relaunch the same path: the drill is about the bundle a user double-clicks tomorrow, not a copy.
  const relaunch = await launchAndRead(executable, env).catch((error) => ({
    info: { error: String(error) }
  }))
  await relaunch.application?.close().catch(() => undefined)
  const relaunchedVersion = relaunch.info?.version ?? relaunch.info?.appVersion ?? relaunch.info
  const gate = await gatekeeper(bundle)
  console.log(`[mac-upgrade] relaunched reports ${JSON.stringify(relaunch.info)}`)
  console.log(`[mac-upgrade] Gatekeeper: ${gate.verdict}`)
  console.log(`[mac-upgrade] ${gate.verify}`)

  const ok = String(installed) === String(nextVersion) && gate.verdict.includes('accepted')
  console.log(
    `macOS upgrade reading: ${ok ? 'passed' : 'failed'} ` +
      `from=${fromVersion} to=${installed} relaunched=${JSON.stringify(relaunchedVersion)}`
  )
  if (!ok) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[mac-upgrade] ${error?.stack ?? error}`)
    process.exitCode = 1
  })
}

export { bundleVersion, findBundle, gatekeeper, waitForVersionOnDisk }
