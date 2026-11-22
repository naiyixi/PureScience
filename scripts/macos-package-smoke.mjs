/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readMacBundleSignature } from './ci/mac-signing-status.mjs'

const ARTIFACT_PATTERN = /^zerolink-purescience-(.+)-mac-(?:arm64|x64)\.(dmg|zip)$/
const SMOKE_ROOT_PREFIX = 'purescience-macos-package-smoke-'
const STARTUP_BUDGET_MS = 180_000
// Silence, not elapsed time, is the criterion that means "wedged": a loaded intel runner sat 21.7 s
// between `electron-ready` and the next line and still finished (we cut it at 60 s before it could
// announce), so a mere 60 s ceiling reported a slow machine as a stuck app. The budget is therefore
// wider than any run we have seen, and the stall window — ~3× the worst legitimate gap measured — is
// what keeps that from hiding a real hang. Both are named in the failure; neither is a pass.
const STARTUP_STALL_MS = 60_000
// Not a gate budget: once a criterion has tripped the run has already failed. This window only
// separates "the app was still working and this runner is slow" from "the app went silent and never
// got there" — two states that used to end in the identical sentence.
const POST_TRIP_OBSERVATION_MS = 30_000
// The packaged app has already announced its endpoint by the time these two calls are made, so this is
// the cost of one request to a service on the same machine — not a startup budget. 15 s was never
// measured: on 2026-11-19 the macos-arm64 runner announced its endpoint at 4040 ms and then the
// bootstrap request itself tripped a 15 s abort (`DOMException [TimeoutError]`), which the signing gate
// correctly reported as "signature reading not taken — unobserved is not a pass". Waiting long enough to
// take the reading is the fix; reporting a slow machine as an unread bundle is not.
const PROBE_REQUEST_BUDGET_MS = 60_000

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))

const findArtifact = async (directory, extension) => {
  const matches = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(`.${extension}`))
    .map((entry) => join(directory, entry.name))
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one macOS ${extension} in ${directory}; found ${matches.length}.`
    )
  }
  return matches[0]
}

const artifactVersion = (artifact) => {
  const match = basename(artifact).match(ARTIFACT_PATTERN)
  if (!match) throw new Error(`Cannot derive the app version from macOS artifact: ${artifact}`)
  return match[1]
}

const findAppBundle = async (directory) => {
  const matches = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => join(directory, entry.name))
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one .app in ${directory}; found ${matches.length}.`)
  }
  return matches[0]
}

const parsePackagedAppEndpoint = (output) => {
  const match = output.match(
    /PureScience Web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/
  )
  if (!match) return undefined
  const url = new URL(match[1])
  const token = url.searchParams.get('token')
  return token ? { endpoint: url.origin, auth: `token=${encodeURIComponent(token)}` } : undefined
}

// A bare "Timed out waiting for X" cannot be told apart from "the app never started", "the app
// printed an endpoint we no longer parse", and "the runner was slow". Name the bundle, the process
// state, whether any announcement arrived at all, and the output tail (tokens redacted).
const DEFAULT_OUTPUT_TAIL_CHARS = 2_000

export const redactServiceTokens = (text) =>
  text.replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>')

const outputTail = (output, limit = DEFAULT_OUTPUT_TAIL_CHARS) => {
  const trimmed = output.trim()
  if (trimmed === '') return '(the app wrote nothing to stdout or stderr)'
  const tail = trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed
  return redactServiceTokens(tail)
}

// "still running (pid 8730)" is true of a wedged app and of a machine that simply never scheduled it — the
// same sentence covered both on run 44943351879, where the x64 child printed nothing at all for 90 s while
// arm64 announced in 11.9 s. This line adds what the pid alone cannot say: its scheduler state, how long it
// had existed, its CPU share, how many children it had managed to fork, and the last words macOS itself
// wrote about it. Pure rendering so the shape is pinned by tests; the sampling lives in the launcher.
const describeProcessDetail = (detail) => {
  if (!detail) return undefined
  const parts = []
  if (detail.ps) parts.push(`ps: ${detail.ps}`)
  if (detail.children !== undefined) parts.push(`children: ${detail.children}`)
  if (detail.log) parts.push(`unified log (last 2m): ${detail.log}`)
  return parts.length === 0 ? undefined : `- extra process evidence: ${parts.join(' | ')}`
}

const describeProcessState = (processState) =>
  processState.status === 'running'
    ? `still running (pid ${processState.pid}) when the limit expired`
    : processState.code === null || processState.code === undefined
      ? `already exited on signal ${processState.signal}`
      : `already exited with code ${processState.code}`

// A bare timeout cannot be told apart from "the app wedged early" and "this runner is slow": the
// phase timeline the app prints itself answers that (one intel runner reached electron-ready at
// 26,931 ms and compose-runtime at 31,676 ms before the 60,000 ms wait expired — a reading of the
// machine, not of a stall).
const PHASE_MARKER = '[main] operation phase'
const MAX_PHASES_NAMED = 6

const extractStartupPhases = (output) => {
  const phases = []
  for (const block of output.split(PHASE_MARKER).slice(1)) {
    const name = block.match(/phase:\s*'([^']+)'/)?.[1]
    const elapsed = block.match(/elapsedMs:\s*(\d+)/)?.[1]
    // A phase line without its timing says the app got there but not when — keep neither.
    if (name === undefined || elapsed === undefined) continue
    phases.push({ name, elapsedMs: Number(elapsed) })
  }
  return phases
}

const describeStartupPhases = (output) => {
  const phases = extractStartupPhases(output)
  if (phases.length === 0) return 'none — the app never reported a startup phase'
  const last = phases[phases.length - 1]
  const named = phases
    .slice(-MAX_PHASES_NAMED)
    .map((phase) => `${phase.name}@${phase.elapsedMs} ms`)
    .join(' → ')
  const omitted = phases.length - MAX_PHASES_NAMED
  return `${phases.length} reported, last '${last.name}' at ${last.elapsedMs} ms ⇒ ${named}${
    omitted > 0 ? ` (${omitted} earlier omitted)` : ''
  }`
}

// Silence is a reading of its own: when the app last said anything is what separates "still working,
// just slowly" from "wedged after <phase>". A phase timeline without it can be read either way.
const describeOutputActivity = (activity) =>
  activity === undefined
    ? 'not recorded'
    : activity.lastChunkAtMs === null || activity.lastChunkAtMs === undefined
      ? 'nothing arrived on stdout/stderr in the whole window'
      : `last line arrived at ${activity.lastChunkAtMs} ms; ${activity.silenceMs} ms of silence when the wait tripped`

// The post-trip window is the only part of this that is still observing after the failure, so it
// answers the one question the phase timeline cannot: was the announcement merely late (⇒ slowness)
// or did it never come (⇒ a hang)? The sentence has to follow the criterion that tripped, or it
// would blame the budget for a stall and vice versa.
const describePostTripObservation = (observation, elapsedMs, criterion) =>
  observation === undefined
    ? 'not observed'
    : observation.found
      ? criterion === 'stall'
        ? `the endpoint WAS announced at ≈${elapsedMs + observation.waitedMs} ms (${observation.waitedMs} ms after the stall window; poll granularity 250 ms) ⇒ it was slow, not wedged — the silence ended`
        : `the endpoint WAS announced at ≈${elapsedMs + observation.waitedMs} ms (${observation.waitedMs} ms past the budget; poll granularity 250 ms) ⇒ the budget cut a run that was still progressing`
      : criterion === 'stall'
        ? `still no endpoint after a further ${observation.waitedMs} ms ⇒ the silence did not end: a hang, not slowness`
        : `still no endpoint after a further ${observation.waitedMs} ms ⇒ not the budget; the app was still printing when it tripped, yet never announced`

export const describeStartupTimeout = ({
  label,
  elapsedMs,
  timeoutMs,
  stallMs = STARTUP_STALL_MS,
  criterion = 'budget',
  processState,
  output,
  outputActivity,
  postTripObservation,
  processDetail
}) => {
  const headline =
    criterion === 'stall'
      ? `Stalled waiting for the packaged macOS web service (${label}): no output for ${elapsedMs} ms (stall window ${stallMs} ms) — the ${timeoutMs} ms budget was not what tripped.`
      : `Timed out waiting for the packaged macOS web service (${label}) after ${elapsedMs} ms (limit ${timeoutMs} ms).`
  const announcements = output.split('\n').filter((line) => line.includes('PureScience Web:'))
  const announcementSummary =
    announcements.length === 0
      ? 'none — the app never announced a web endpoint'
      : `${announcements.length} line(s) mentioned the endpoint but none matched http://127.0.0.1:<port>/?token=… (format drift)`
  return [
    headline,
    `- process: ${describeProcessState(processState)}`,
    `- service announcements: ${announcementSummary}`,
    `- startup phases: ${describeStartupPhases(output)}`,
    `- output activity: ${describeOutputActivity(outputActivity)}`,
    `- after the wait tripped: ${describePostTripObservation(postTripObservation, elapsedMs, criterion)}`,
    ...(describeProcessDetail(processDetail) ? [describeProcessDetail(processDetail)] : []),
    `- last output (${DEFAULT_OUTPUT_TAIL_CHARS} chars max, tokens redacted):`,
    outputTail(output)
  ].join('\n')
}

// Bounded, never throwing: a diagnostic that fails must not turn one red into another. `ps` and the unified
// log answer different questions — the first says whether the process was ever scheduled, the second whether
// macOS itself killed or blocked it (Gatekeeper, code-signing, launchd) without the app writing a byte.
const captureProcessDetail = async (pid) => {
  const run = async (executable, args, timeoutMs = 6_000) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => (out += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    const code = await new Promise((resolveChild) => child.on('close', resolveChild))
    clearTimeout(timer)
    return code === 0 ? out.trim() : ''
  }
  const detail = {}
  // stat/etime/%cpu in one line; `=` suffixes drop the headers so the value reads like a reading.
  detail.ps = await run('ps', ['-o', 'stat=,etime=,%cpu=', '-p', String(pid)]).catch(() => '')
  detail.children = await run('pgrep', ['-P', String(pid)]).then(
    (out) => out.split('\n').filter(Boolean).length,
    () => undefined
  )
  detail.log = await run(
    'log',
    ['show', '--last', '2m', '--style', 'compact', '--predicate', 'process == "PureScience"'],
    8_000
  )
    .then((out) => {
      const lines = out.split('\n').filter((line) => line.trim() !== '')
      if (lines.length === 0) return 'nothing — macOS wrote no line about this process'
      const tailLines = lines.slice(-3).map((line) => redactServiceTokens(line.slice(0, 200)))
      return `${lines.length} line(s), last: ${tailLines.join(' // ')}`
    })
    .catch(() => '')
  return Object.keys(detail).some((key) => detail[key]) ? detail : undefined
}

export const waitFor = async (description, check, timeoutMs = STARTUP_BUDGET_MS) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined)
    if (value !== undefined && value !== false) return value
    await delay(250)
  }
  throw Object.assign(new Error(`Timed out waiting for ${description}.`), {
    code: 'SMOKE_TIMEOUT'
  })
}

// Only the timeout branch arrives without evidence of its own; every other failure already names its
// cause, so it passes through untouched (same error object, same message). The `code` is kept on the
// rewritten error: the failure writer below uses it to say which kind of failure left no reading.
export const toStartupFailure = (error, context) =>
  error instanceof Error && (error.code === 'SMOKE_TIMEOUT' || error.code === 'SMOKE_STALL')
    ? Object.assign(new Error(describeStartupTimeout(context)), { code: error.code })
    : error

const runProcess = (executable, args, options = {}) =>
  new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? 'pipe'
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

const assertPackagedResources = async (appBundle) => {
  const resources = join(appBundle, 'Contents', 'Resources')
  const paths = [
    join(appBundle, 'Contents', 'MacOS', 'PureScience'),
    join(resources, 'app.asar'),
    join(resources, 'micromamba'),
    // 无 Xcode 环境用 ICNS 传统格式 (Icon Composer 的 Assets.car 需要 actool/Xcode 26)。
    join(resources, 'icon.icns')
  ]
  for (const path of paths) await access(path)
  return { executable: paths[0], micromamba: paths[2] }
}

const packagedLaunchArguments = (userDataRoot) => [
  `--user-data-dir=${userDataRoot}`,
  '--purescience-headless',
  '--serve=0'
]

// Two criteria instead of one ceiling: a run that stops talking is wedged (SMOKE_STALL), a run that
// talks past the absolute budget is a runner we cannot measure anything from (SMOKE_TIMEOUT). The
// windows are injectable so a probe can exercise both against a real child in seconds.
const awaitServiceAnnouncement = async ({
  read,
  startedAt,
  activity,
  stallMs,
  budgetMs,
  label
}) => {
  for (;;) {
    const service = await read().catch(() => undefined)
    if (service !== undefined && service !== false) return service
    const now = Date.now()
    const lastChunkAtMs = activity.lastChunkAtMs
    const silentMs = now - startedAt - (lastChunkAtMs ?? 0)
    if (silentMs >= stallMs) {
      throw Object.assign(
        new Error(
          `No output for ${silentMs} ms while waiting for ${label} (stall window ${stallMs} ms).`
        ),
        { code: 'SMOKE_STALL' }
      )
    }
    if (now - startedAt >= budgetMs) {
      throw Object.assign(
        new Error(`No service after ${now - startedAt} ms (budget ${budgetMs} ms).`),
        {
          code: 'SMOKE_TIMEOUT'
        }
      )
    }
    await delay(250)
  }
}

// Exported so a probe can exercise the timeout seam against a real child process (the unit tests
// can only reach the message builder).
export const launchAndProbe = async ({
  executable,
  expectedVersion,
  env,
  userDataRoot,
  label,
  stallMs = STARTUP_STALL_MS,
  budgetMs = STARTUP_BUDGET_MS,
  observationMs = POST_TRIP_OBSERVATION_MS
}) => {
  const startedAt = Date.now()
  const child = spawn(executable, packagedLaunchArguments(userDataRoot), {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  const activity = { lastChunkAtMs: null }
  let processState = { status: 'running', pid: child.pid }
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  const recordOutput = (text) => {
    output += text
    activity.lastChunkAtMs = Date.now() - startedAt
  }
  child.stdout?.on('data', (chunk) => recordOutput(chunk))
  child.stderr?.on('data', (chunk) => recordOutput(`\n${chunk}`))
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code, signal) => {
      processState = { status: 'exited', code, signal }
      resolveExit(code)
    })
  })

  try {
    const service = await Promise.race([
      awaitServiceAnnouncement({
        read: async () => parsePackagedAppEndpoint(output),
        startedAt,
        activity,
        stallMs,
        budgetMs,
        label: `the packaged macOS web service (${label})`
      }),
      exit.then((code) => {
        throw new Error(
          `Packaged macOS app exited before becoming healthy (${code}).\n${redactServiceTokens(output)}`
        )
      })
    ])
    // The passing side of the same reading: without it every later budget question (is this runner
    // slow, or did the app get slower?) has no baseline on the platforms that did pass.
    console.log(
      `packaged startup (${label}): endpoint announced after ${Date.now() - startedAt} ms; ` +
        `startup phases: ${describeStartupPhases(output)}`
    )
    const response = await fetch(`${service.endpoint}/api/bootstrap?${service.auth}`, {
      signal: AbortSignal.timeout(PROBE_REQUEST_BUDGET_MS)
    })
    if (!response.ok) throw new Error(`Packaged macOS bootstrap returned HTTP ${response.status}.`)
    const bootstrap = await response.json()
    if (
      bootstrap.appName !== 'PureScience' ||
      bootstrap.appVersion !== expectedVersion ||
      bootstrap.platform !== 'darwin'
    ) {
      throw new Error(`Unexpected packaged macOS bootstrap: ${JSON.stringify(bootstrap)}`)
    }
    const shutdown = await fetch(`${service.endpoint}/api/shutdown?${service.auth}`, {
      method: 'POST',
      signal: AbortSignal.timeout(PROBE_REQUEST_BUDGET_MS)
    })
    await shutdown.text()
    if (shutdown.status !== 202) {
      throw new Error(`Packaged macOS shutdown returned ${shutdown.status}.`)
    }
    const exitCode = await Promise.race([
      exit,
      delay(60_000).then(() => {
        throw new Error('Packaged macOS app did not exit after shutdown.')
      })
    ])
    if (exitCode !== 0) {
      throw new Error(`Packaged macOS app exited with ${exitCode}.\n${redactServiceTokens(output)}`)
    }
  } catch (error) {
    // Observe past the trip BEFORE killing the child: killing it ends the only evidence stream, and
    // "announced a few seconds later" vs "never announced" is the whole difference between a slow
    // runner and a wedged app. The run has already failed either way, so this changes no verdict.
    const tripped =
      error instanceof Error && (error.code === 'SMOKE_TIMEOUT' || error.code === 'SMOKE_STALL')
    let postTripObservation
    let outputActivity
    let processDetail
    let tripElapsedMs
    if (tripped) {
      // Sample the last arrival and the silence at the SAME instant — the trip. Read at kill time
      // they disagree (a line that arrived after the trip pairs with "silent since before it"), and
      // read after the observation window every headline over-reports by the window itself.
      tripElapsedMs = Date.now() - startedAt
      outputActivity = {
        lastChunkAtMs: activity.lastChunkAtMs,
        silenceMs: activity.lastChunkAtMs === null ? null : tripElapsedMs - activity.lastChunkAtMs
      }
      const observationStartedAt = Date.now()
      const reached = await waitFor(
        `the packaged macOS web service (${label}) after the trip`,
        async () => parsePackagedAppEndpoint(output),
        observationMs
      ).then(
        () => true,
        (lateError) => {
          if (lateError instanceof Error && lateError.code === 'SMOKE_TIMEOUT') return false
          throw lateError
        }
      )
      postTripObservation = { found: reached, waitedMs: Date.now() - observationStartedAt }
      // Sampled while the child is still alive, before the post-trip observation is torn down.
      processDetail = await captureProcessDetail(child.pid).catch(() => undefined)
    }
    child.kill('SIGKILL')
    const criterion = error instanceof Error && error.code === 'SMOKE_STALL' ? 'stall' : 'budget'
    // A stall is described by how long it had been silent, a budget trip by how long it waited —
    // both as of the trip, never as of the observation that followed it.
    const elapsedMs =
      criterion === 'stall'
        ? (outputActivity?.silenceMs ?? tripElapsedMs)
        : (tripElapsedMs ?? Date.now() - startedAt)
    throw toStartupFailure(error, {
      label,
      elapsedMs,
      timeoutMs: budgetMs,
      stallMs,
      criterion,
      processState,
      output,
      outputActivity,
      postTripObservation,
      processDetail
    })
  }
}

const smokeAppBundle = async ({
  appBundle,
  expectedVersion,
  env,
  gatekeeper,
  userDataRoot,
  label
}) => {
  await runProcess(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appBundle],
    {
      env
    }
  )
  if (gatekeeper) {
    await runProcess(
      '/usr/sbin/spctl',
      ['--assess', '--type', 'execute', '--verbose=4', appBundle],
      {
        env
      }
    )
  }
  const { executable, micromamba } = await assertPackagedResources(appBundle)
  await runProcess(micromamba, ['--version'], { env })
  await launchAndProbe({ executable, expectedVersion, env, userDataRoot, label })
}

// A printed reading that says `signed=false` when no expected team was configured reads as "this bundle
// is unsigned" — measured the hard way: the notarized v2.27.0 job printed
// `TeamIdentifier=UGQZPJ74DF signed=false` and that line was one step from being reported as a defect.
// Attribution is only decidable against an expected team, so the line says which question was asked
// instead of answering a different one.
export const describeSignatureReading = (reading) => {
  const team = reading?.teamIdentifier ?? '<none>'
  const attribution =
    reading?.teamIdExpectation === 'configured'
      ? `signed=${reading?.signed === true}`
      : `signed=not-compared (no expected team in this step; signer=${reading?.signerTeam ?? '<none>'})`
  return `Identifier=${reading?.identifier ?? '<none>'} TeamIdentifier=${team} ${attribution}`
}

// The shipped bytes' signing state, written where the certification-evidence step can read it
// (issue #19). Read from the ZIP's own bundle — the artifact the mac updater replaces in place — so
// the recorded state describes what a user installs, not what the build directory happened to hold.
const writeSignatureReading = async (path, { artifact, source, bundle }) => {
  const reading = readMacBundleSignature(bundle, { artifact, source })
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(reading, null, 2)}\n`, 'utf8')
  console.log(`macOS signature reading (${source}): ${describeSignatureReading(reading)}`)
  return reading
}

// The first line of a failure, short enough to fit in a JSON field and safe to keep: this file is read by the
// gate and copied into release evidence, and the packaged service address carries a bearer token.
const describeSmokeFailure = (error) => {
  const code = typeof error?.code === 'string' && error.code !== '' ? `${error.code}: ` : ''
  const message = String(error?.message ?? error ?? '')
  const firstLine = message.split('\n')[0].trim()
  const head = firstLine.length > 300 ? `${firstLine.slice(0, 300)}…` : firstLine
  return redactServiceTokens(
    `${code}${head === '' ? 'the smoke run failed without a message' : head}`
  )
}

// A smoke that fails never reaches the bundle's own reading, and until now that left the file absent — which
// the gate reports exactly like "the step never ran". An unobserved reading keeps those apart: it is still not
// a pass (`readable: false`), and the reason says what happened to this run.
const writeUnobservedReading = async (path, reason) => {
  const reading = {
    schemaVersion: 1,
    source: 'smoke-failure',
    artifact: null,
    bundle: null,
    readable: false,
    identifier: null,
    teamIdentifier: null,
    signed: false,
    reason
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(reading, null, 2)}\n`, 'utf8')
  console.log(`macOS signature reading not taken: ${reason}`)
  return reading
}

// The reading path is needed by the failure writer, which runs after `main` has thrown — so it is taken from
// argv leniently rather than through `parseArguments` (a usage error must still leave a marker).
const signatureReadingPath = (argv) => {
  const index = argv.indexOf('--signature-reading')
  if (index === -1) return undefined
  const path = argv[index + 1]
  return path === undefined || path.startsWith('--') ? undefined : path
}

const parseArguments = (argv) => {
  const index = argv.indexOf('--artifact-dir')
  const artifactDirectory = index === -1 ? undefined : argv[index + 1]
  if (!artifactDirectory) {
    throw new Error('Usage: --artifact-dir <path> [--gatekeeper] [--signature-reading <path>]')
  }
  const readingIndex = argv.indexOf('--signature-reading')
  const signatureReading = readingIndex === -1 ? undefined : argv[readingIndex + 1]
  if (readingIndex !== -1 && !signatureReading) {
    throw new Error('--signature-reading needs a path')
  }
  return {
    artifactDirectory: resolve(artifactDirectory),
    gatekeeper: argv.includes('--gatekeeper'),
    signatureReading
  }
}

const main = async () => {
  if (process.platform !== 'darwin') throw new Error('macOS package smoke requires macOS.')
  const options = parseArguments(process.argv.slice(2))
  const [dmg, zip] = await Promise.all([
    findArtifact(options.artifactDirectory, 'dmg'),
    findArtifact(options.artifactDirectory, 'zip')
  ])
  const expectedVersion = artifactVersion(dmg)
  if (artifactVersion(zip) !== expectedVersion) {
    throw new Error('macOS DMG and ZIP versions do not match.')
  }

  const root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), SMOKE_ROOT_PREFIX))
  const mount = join(root, 'dmg-mount')
  const extracted = join(root, 'zip-extracted')
  const storageRoot = join(root, 'storage')
  const userDataRoot = join(root, 'electron-profile')
  const env = {
    ...process.env,
    PURESCIENCE_E2E_STORAGE_ROOT: storageRoot
  }

  try {
    await Promise.all([mkdir(mount), mkdir(extracted), mkdir(storageRoot)])
    if (options.gatekeeper) {
      await runProcess(
        '/usr/sbin/spctl',
        [
          '--assess',
          '--type',
          'open',
          '--context',
          'context:primary-signature',
          '--verbose=4',
          dmg
        ],
        { env }
      )
    }
    await runProcess('/usr/bin/hdiutil', [
      'attach',
      '-nobrowse',
      '-readonly',
      '-mountpoint',
      mount,
      dmg
    ])
    try {
      await smokeAppBundle({
        appBundle: await findAppBundle(mount),
        expectedVersion,
        env,
        gatekeeper: false,
        userDataRoot,
        label: `DMG-mounted bundle ${basename(dmg)}`
      })
    } finally {
      await runProcess('/usr/bin/hdiutil', ['detach', '-force', mount])
    }

    await runProcess('/usr/bin/ditto', ['-x', '-k', zip, extracted], { env })
    const extractedApp = await findAppBundle(extracted)
    await smokeAppBundle({
      appBundle: extractedApp,
      expectedVersion,
      env,
      gatekeeper: options.gatekeeper,
      userDataRoot,
      label: `ZIP-extracted bundle ${basename(zip)}`
    })
    if (options.signatureReading) {
      await writeSignatureReading(options.signatureReading, {
        artifact: basename(zip),
        source: 'shipped-zip',
        bundle: extractedApp
      })
    }
    console.log('macOS DMG and ZIP launch smoke completed successfully.')
  } finally {
    await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 })
  }
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  main().catch(async (error) => {
    console.error(error)
    const readingPath = signatureReadingPath(process.argv.slice(2))
    if (readingPath !== undefined) {
      // Best-effort: the marker must never replace the failure that caused it.
      await writeUnobservedReading(readingPath, describeSmokeFailure(error)).catch(() => {})
    }
    process.exitCode = 1
  })
}

export {
  artifactVersion,
  assertPackagedResources,
  describeSmokeFailure,
  describeStartupPhases,
  extractStartupPhases,
  findAppBundle,
  findArtifact,
  packagedLaunchArguments,
  parseArguments,
  parsePackagedAppEndpoint,
  signatureReadingPath,
  writeUnobservedReading
}
