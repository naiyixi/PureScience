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
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { _electron as electron } from 'playwright'

const CHECK_TIMEOUT_MS = 120_000
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
    // A binary this machine does not have never reaches 'close': `spawn` reports ENOENT as an 'error' event,
    // and with no listener the promise below would wait out its whole budget instead of naming what is
    // missing. Measured on the Windows lane (run 44984143602, job 137090909581): four unit tests that call
    // `plutil` each burned the full 120 s before the shard gave up.
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(new Error(`${executable} could not be started: ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // `spctl` writes its verdict to stderr even when it accepts, so a caller that only reads stdout gets an
      // empty string and cannot tell "accepted" from "no output at all" (seen on run 44982094867).
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
      if (code === 0) resolvePromise(combined)
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

// An x86_64 app can start on an arm64 runner through Rosetta, so "it launched" does not mean the drill ran
// the path a user with that architecture runs: Squirrel's swap and the relaunch read differently under
// translation. `macos-15-intel` is the last x64 image GitHub offers (until ~2027), so both host kinds exist —
// this refuses a mismatched pair by name instead of reporting an upgrade that a different machine performed.
const ARCH_ALIASES = { x86_64: 'x64', amd64: 'x64', arm64: 'arm64', aarch64: 'arm64' }
const normaliseArch = (raw) => {
  const key = String(raw ?? '')
    .trim()
    .toLowerCase()
  return ARCH_ALIASES[key] ?? key
}
const archMismatch = (bundleArches, hostArch) => {
  const wanted = new Set(
    String(bundleArches ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map(normaliseArch)
  )
  const host = normaliseArch(hostArch)
  if (wanted.size === 0)
    return `the bundle reports no architecture at all (lipo said ${JSON.stringify(bundleArches)})`
  if (!wanted.has(host)) {
    return (
      `the bundle is ${[...wanted].join('/')} and this host is ${host} — one of them is wrong, and an ` +
      'upgrade performed under translation is not the upgrade that architecture performs'
    )
  }
  return null
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
// A second copy of the app hands over to the first and exits with 0 — on a machine where the release is
// installed and open, that looks exactly like a crash at launch (measured locally: `pid=12116 … <process
// did exit: exitCode=0>` and an empty HOME under the drill's work dir). The drill cannot tell those apart
// after the fact, so it says which one it is before launching.
const otherInstance = async (bundle) => {
  const listing = await runProcess('pgrep', [
    '-fl',
    'PureScience.app/Contents/MacOS/PureScience'
  ]).catch(() => '')
  const others = listing
    .split('\n')
    .filter(Boolean)
    .filter((line) => !line.includes(bundle))
  return others.length > 0 ? others : undefined
}

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

  // `check()` has no timeout of its own inside the app, so a provider request that never settles keeps the
  // promise pending with no status change to show for it. Polling the status the app itself publishes is
  // what turns "nothing came back" into "it was still in <state> when the drill gave up".
  page.on('console', (message) => {
    if (message.type() === 'error')
      console.log(`[mac-upgrade] console.error: ${message.text().slice(0, 300)}`)
  })
  page.on('pageerror', (error) =>
    console.log(`[mac-upgrade] pageerror: ${String(error).slice(0, 300)}`)
  )
  const before = await page.evaluate(() => globalThis.window.api.update.getStatus())
  console.log(`[mac-upgrade] status before check: ${JSON.stringify(before)}`)
  let lastState = JSON.stringify(before)
  const poller = setInterval(() => {
    page
      .evaluate(() => globalThis.window.api.update.getStatus())
      .then((status) => {
        const next = JSON.stringify(status)
        if (next !== lastState) {
          lastState = next
          console.log(`[mac-upgrade] status during check: ${next.slice(0, 400)}`)
        }
      })
      .catch(() => undefined)
  }, 5_000)
  const checked = await withTimeout(
    page.evaluate(() => globalThis.window.api.update.check()),
    'update.check'
  ).finally(() => clearInterval(poller))
  console.log(`[mac-upgrade] check() -> ${JSON.stringify(checked)}`)
  if (checked.state === 'up-to-date') {
    throw new Error(
      `The feed already says we are current (${checked.current}); the drill needs an older app than ${nextVersion}`
    )
  }
  if (checked.state !== 'available' || String(checked.latest) !== String(nextVersion)) {
    throw new Error(
      `The feed did not offer ${JSON.stringify(nextVersion)} as next_version, it answered ` +
        `${JSON.stringify(checked.state)} with latest ${JSON.stringify(checked.latest)} — ` +
        'those two are the argument and the feed, and a drill that cannot see the next version proves ' +
        'nothing about upgrading to it'
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

  // Squirrel.Mac does the swap in its own process (`ShipIt`) after the app quits, and it reports there —
  // not in the app's log. Measured on run 44981503900: apply() -> applying, the app shut down cleanly with
  // trigger=update, and the bundle on disk still read 2.33.0 four minutes later with nothing to explain it.
  // So: wait for the app to finish quitting on its own, and take ShipIt's own words while it works.
  const quit = await Promise.race([
    new Promise((resolvePromise) =>
      application.once('close', () => resolvePromise({ quit: true }))
    ),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise({ quit: false }), 60_000))
  ])
  console.log(`[mac-upgrade] app quit on its own: ${quit.quit}`)
  const shipIt = await runProcess(
    'log',
    [
      'show',
      '--last',
      '2m',
      '--style',
      'compact',
      '--predicate',
      'process == "ShipIt" OR eventMessage CONTAINS "ShipIt" OR eventMessage CONTAINS "SQRL"'
    ],
    20_000
  ).catch(() => '')
  const shipItLines = shipIt
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-6)
  console.log(
    shipItLines.length > 0
      ? `[mac-upgrade] ShipIt said:\n  ${shipItLines.join('\n  ').slice(0, 1200)}`
      : '[mac-upgrade] ShipIt logged nothing (macOS wrote no ShipIt/SQRL line in the last 2 minutes)'
  )
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
// What a user loses if an updater gets this wrong is not the version on disk but the work behind it. The
// marker is deliberately written where the packaged app keeps its own state (`app.getPath('userData')` is
// `~/Library/Application Support/<productName>`), and it is written *before* the old build runs, so the
// assertion after the relaunch covers both halves: the swap must not wipe it, and the new build must not
// re-create its store from scratch on top of it.
const userDataDir = (homeDir) => join(homeDir, 'Library', 'Application Support', 'PureScience')

const seedUserDataMarker = async (homeDir, token) => {
  const path = join(userDataDir(homeDir), 'drill-marker.json')
  await mkdir(userDataDir(homeDir), { recursive: true })
  await writeFile(path, JSON.stringify({ token, writtenAt: new Date().toISOString() }), 'utf8')
  return path
}

const readUserDataMarker = async (path) => {
  const raw = await readFile(path, 'utf8').catch(() => undefined)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw).token
  } catch {
    return raw
  }
}

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

let drilledBundle
let drillHome

// `previous_tag` carries a leading `v`; `next_version` is the bare version the feed answers with. A caller
// who passes `--next-version v2.33.2` used to get "The feed did not offer v2.33.2" while the payload on the
// same line said `latest: 2.33.2` — a message that sends the reader after the feed instead of the argument.
const normaliseVersionInput = (raw) => (raw ? String(raw).trim().replace(/^v/i, '') : raw)

const main = async () => {
  const args = process.argv.slice(2)
  const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback
  }
  const previousZip = option('previous-zip')
  // `previous_tag` carries a leading `v` and `next_version` is the bare version, so a caller who passes
  // `--next-version v2.33.2` is one keystroke from an assertion that reads like a broken feed: the message
  // said "The feed did not offer v2.33.2" while the payload beside it said `latest: 2.33.2`. Normalise the
  // argument instead of asking people to remember which side takes the `v`.
  const nextVersion = normaliseVersionInput(option('next-version'))
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
  drilledBundle = bundle
  const executable = await bundleExecutable(bundle)
  const fromVersion = await bundleVersion(bundle)
  console.log(`[mac-upgrade] previous bundle ${bundle} (${fromVersion})`)
  const bundleArches = await runProcess('lipo', ['-archs', executable]).catch((error) => {
    throw new Error(`lipo could not read ${executable}: ${error.message}`)
  })
  const hostArch = await runProcess('uname', ['-m'])
  const mismatched = archMismatch(bundleArches, hostArch)
  if (mismatched) throw new Error(`Host and bundle disagree about architecture: ${mismatched}`)
  console.log(
    `[mac-upgrade] architecture: bundle ${bundleArches.trim()} on host ${hostArch.trim()}`
  )
  if (fromVersion === nextVersion) {
    throw new Error(
      `The "previous" bundle is already ${nextVersion}; the drill would prove nothing`
    )
  }

  // A private HOME as well as a private storage root: the packaged app keeps its single-instance lock and
  // its updater cache under `~/Library/Application Support`, and a drill that shares them with whatever the
  // machine is already running can either be refused the lock or purge somebody else's cache.
  const home = join(workRoot, 'home')
  drillHome = home
  await mkdir(home, { recursive: true })
  // `--keep-home` exists for one question: a private HOME is what lets this run beside an installed copy,
  // but it also hands the app an environment no ordinary launch has. When a check hangs, the way to tell
  // "the drill's environment broke the network stack" from "the check itself hangs" is to run it the way a
  // user's copy runs — with the real HOME — and see whether the answer changes.
  const keepHome = args.includes('--keep-home')
  const env = {
    ...process.env,
    ...(keepHome ? {} : { HOME: home }),
    PURESCIENCE_STORAGE_ROOT: storageRoot,
    PURESCIENCE_E2E_STORAGE_ROOT: storageRoot
  }
  console.log(`[mac-upgrade] HOME isolation: ${keepHome ? 'off (real HOME)' : 'on'}`)
  // A marker in the app's own user-data directory. Skipped under `--keep-home`, because that path is the
  // real user's — a drill may read a real HOME to answer a question, it may not write into one.
  const markerToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const markerPath = keepHome ? undefined : await seedUserDataMarker(home, markerToken)
  console.log(
    `[mac-upgrade] user-data marker: ${markerPath ? `seeded at ${markerPath}` : 'skipped (real HOME)'}`
  )
  const running = await otherInstance(bundle)
  if (running) {
    console.log(
      `[mac-upgrade] another PureScience instance is running (${running.length} process(es)); a second ` +
        'copy would hand over and exit 0 instead of running this drill. Quit it first — on CI there is none'
    )
    throw new Error(
      'refusing to drill while another PureScience instance is running on this machine'
    )
  }
  const { checkedAt } = await driveUpdate({ executable, env, nextVersion })
  const installed = await waitForVersionOnDisk(bundle, nextVersion)
  console.log(
    `[mac-upgrade] on disk now: ${installed} (was ${fromVersion}, check saw ${checkedAt})`
  )

  // Squirrel relaunches the app itself after the swap (`autoRunAppAfterInstall`), so by the time we get
  // here a copy from the same bundle is usually already running — and a second copy hands over and exits 0,
  // which Playwright reports as "Target page … has been closed". Clear it before measuring the relaunch.
  // Not `otherInstance()`: that filters the drill's own bundle out on purpose (its caller wants foreign
  // copies). Here the copy that matters is exactly the one from this bundle — Squirrel relaunches it — so
  // it is cleared by path and then waited out, otherwise the "fresh start" below is another hand-over.
  const survivors = await processesFor(bundle)
  if (survivors.length > 0) {
    console.log(
      `[mac-upgrade] clearing ${survivors.length} process(es) Squirrel relaunched from this bundle before ` +
        'measuring a fresh start'
    )
    await reap(bundle)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await processesFor(bundle)).length === 0) break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    }
  }
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

  // The relaunch happens before this reads the marker on purpose: the interesting case is that the new
  // build started, opened its store, and still found the old data rather than replacing it.
  const markerAfter = markerPath ? await readUserDataMarker(markerPath) : undefined
  const dataReading = markerPath
    ? markerAfter === markerToken
      ? 'kept'
      : markerAfter === undefined
        ? 'lost (marker gone)'
        : 'kept (token changed)'
    : 'skipped (real HOME)'
  console.log(`[mac-upgrade] user data after the swap: ${dataReading}`)
  const ok =
    String(installed) === String(nextVersion) &&
    String(relaunchedVersion) === String(nextVersion) &&
    gate.verdict.includes('accepted') &&
    // `kept (token changed)` still fails: a file that came back with different contents is not the data the
    // old build left behind, it is a new file that happens to sit at the same path.
    (markerPath === undefined || markerAfter === markerToken)
  console.log(
    `macOS upgrade reading: ${ok ? 'passed' : 'failed'} ` +
      `from=${fromVersion} to=${installed} relaunched=${JSON.stringify(relaunchedVersion)} ` +
      `data=${dataReading}`
  )
  if (!ok) process.exitCode = 1
  await reap(bundle)
}

// The app writes one JSON line per event, including a diagnostic operation per update command with the
// phase it reached (`query-provider`, `query-provider-github`). When a check hangs, that file is the only
// thing that says WHERE — the drill's own timeout can only say "nothing came back in N ms".
const appLogTail = async (home, lines = 12) => {
  // Two roots, because the app derives one of them from NSHomeDirectory rather than from the env var the
  // drill sets: a run that wrote nothing under the drill HOME may still have logged under the real one.
  const candidates = [
    join(home, 'Library', 'Logs', 'PureScience', 'main.log'),
    join(homedir(), 'Library', 'Logs', 'PureScience', 'main.log')
  ]
  for (const logFile of candidates) {
    const text = await readFile(logFile, 'utf8').catch(() => undefined)
    if (text) return { logFile, tail: text.trim().split('\n').slice(-lines) }
  }
  return undefined
}

const printAppLog = async (home) => {
  const reading = await appLogTail(home)
  if (!reading) {
    console.log('[mac-upgrade] the app wrote no log under the drill HOME')
    return
  }
  console.log(`[mac-upgrade] app log tail (${reading.logFile}):`)
  for (const line of reading.tail) console.log(`  ${line.slice(0, 400)}`)
}

// A launched app inherits stdout; if one is still alive when this process returns, whatever is reading the
// pipe (`tee` in the workflow) never sees EOF and the step hangs long after the drill has decided. Measured:
// the macOS smoke step sat 'in_progress' for an hour with every internal wait bounded below half an hour.
const processesFor = async (bundle) => {
  const listing = await runProcess('pgrep', ['-fl', bundle]).catch(() => '')
  return listing
    .split('\n')
    .filter(Boolean)
    .map((line) => Number(line.split(' ')[0]))
    .filter((pid) => Number.isFinite(pid))
}

const reap = async (bundle) => {
  const pids = await processesFor(bundle)
  if (pids.length > 0) {
    await runProcess('kill', ['-9', ...pids.map(String)]).catch(() => '')
    console.log(`[mac-upgrade] reaped ${pids.length} leftover process(es) from the drill`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    console.error(`[mac-upgrade] ${error?.stack ?? error}`)
    process.exitCode = 1
    if (drillHome) await printAppLog(drillHome)
    if (drilledBundle) await reap(drilledBundle)
  })
}

export {
  readUserDataMarker,
  seedUserDataMarker,
  userDataDir,
  archMismatch,
  bundleVersion,
  findBundle,
  gatekeeper,
  normaliseArch,
  normaliseVersionInput,
  runProcess,
  waitForVersionOnDisk
}
