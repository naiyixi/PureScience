/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readMacBundleSignature } from './ci/mac-signing-status.mjs'

const ARTIFACT_PATTERN = /^zerolink-purescience-(.+)-mac-(?:arm64|x64)\.(dmg|zip)$/
const SMOKE_ROOT_PREFIX = 'purescience-macos-package-smoke-'
const STARTUP_TIMEOUT_MS = 60_000

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

const describeProcessState = (processState) =>
  processState.status === 'running'
    ? `still running (pid ${processState.pid}) when the limit expired`
    : processState.code === null || processState.code === undefined
      ? `already exited on signal ${processState.signal}`
      : `already exited with code ${processState.code}`

export const describeStartupTimeout = ({ label, elapsedMs, timeoutMs, processState, output }) => {
  const announcements = output.split('\n').filter((line) => line.includes('PureScience Web:'))
  const announcementSummary =
    announcements.length === 0
      ? 'none — the app never announced a web endpoint'
      : `${announcements.length} line(s) mentioned the endpoint but none matched http://127.0.0.1:<port>/?token=… (format drift)`
  return [
    `Timed out waiting for the packaged macOS web service (${label}) after ${elapsedMs} ms (limit ${timeoutMs} ms).`,
    `- process: ${describeProcessState(processState)}`,
    `- service announcements: ${announcementSummary}`,
    `- last output (${DEFAULT_OUTPUT_TAIL_CHARS} chars max, tokens redacted):`,
    outputTail(output)
  ].join('\n')
}

export const waitFor = async (description, check, timeoutMs = STARTUP_TIMEOUT_MS) => {
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
  error instanceof Error && error.code === 'SMOKE_TIMEOUT'
    ? Object.assign(new Error(describeStartupTimeout(context)), { code: 'SMOKE_TIMEOUT' })
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

// Exported so a probe can exercise the timeout seam against a real child process (the unit tests
// can only reach the message builder).
export const launchAndProbe = async ({ executable, expectedVersion, env, userDataRoot, label }) => {
  const startedAt = Date.now()
  const child = spawn(executable, packagedLaunchArguments(userDataRoot), {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  let processState = { status: 'running', pid: child.pid }
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => (output += chunk))
  child.stderr?.on('data', (chunk) => (output += `\n${chunk}`))
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code, signal) => {
      processState = { status: 'exited', code, signal }
      resolveExit(code)
    })
  })

  try {
    const service = await Promise.race([
      waitFor(`the packaged macOS web service (${label})`, async () =>
        parsePackagedAppEndpoint(output)
      ),
      exit.then((code) => {
        throw new Error(
          `Packaged macOS app exited before becoming healthy (${code}).\n${redactServiceTokens(output)}`
        )
      })
    ])
    const response = await fetch(`${service.endpoint}/api/bootstrap?${service.auth}`, {
      signal: AbortSignal.timeout(15_000)
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
      signal: AbortSignal.timeout(15_000)
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
    child.kill('SIGKILL')
    throw toStartupFailure(error, {
      label,
      elapsedMs: Date.now() - startedAt,
      timeoutMs: STARTUP_TIMEOUT_MS,
      processState,
      output
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

// The shipped bytes' signing state, written where the certification-evidence step can read it
// (issue #19). Read from the ZIP's own bundle — the artifact the mac updater replaces in place — so
// the recorded state describes what a user installs, not what the build directory happened to hold.
const writeSignatureReading = async (path, { artifact, source, bundle }) => {
  const reading = readMacBundleSignature(bundle, { artifact, source })
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(reading, null, 2)}\n`, 'utf8')
  console.log(
    `macOS signature reading (${source}): Identifier=${reading.identifier ?? '<none>'} ` +
      `TeamIdentifier=${reading.teamIdentifier ?? '<none>'} signed=${reading.signed}`
  )
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
  findAppBundle,
  findArtifact,
  packagedLaunchArguments,
  parseArguments,
  parsePackagedAppEndpoint,
  signatureReadingPath,
  writeUnobservedReading
}
