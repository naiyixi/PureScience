import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { evaluateMacSignatureGate, readingIsObserved } from './ci/mac-signing-status.mjs'
import {
  artifactVersion,
  assertPackagedResources,
  describeSmokeFailure,
  describeStartupTimeout,
  findAppBundle,
  findArtifact,
  packagedLaunchArguments,
  parseArguments,
  parsePackagedAppEndpoint,
  redactServiceTokens,
  signatureReadingPath,
  toStartupFailure,
  waitFor,
  writeUnobservedReading
} from './macos-package-smoke.mjs'

const roots: string[] = []

const SMOKE_SCRIPT = fileURLToPath(new URL('./macos-package-smoke.mjs', import.meta.url))

// Runs the script the way CI does (its own process, real argv) so the failure branch is exercised as
// wiring rather than as a function call. `process.execPath` keeps this portable — a hardcoded local
// node path passes here and resolves to nothing on the CI runners.
const runSmokeScript = (args: string[]): Promise<{ exitCode: number | null; stderr: string }> =>
  new Promise((resolveRun) => {
    execFile(process.execPath, [SMOKE_SCRIPT, ...args], (error, _stdout, stderr) => {
      const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : null
      resolveRun({ exitCode, stderr: String(stderr) })
    })
  })

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('macOS package smoke', () => {
  it('selects one DMG and ZIP and derives their shared version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-macos-artifacts-'))
    roots.push(root)
    const dmg = join(root, 'zerolink-purescience-0.12.0-mac-arm64.dmg')
    const zip = join(root, 'zerolink-purescience-0.12.0-mac-arm64.zip')
    await Promise.all([
      writeFile(dmg, ''),
      writeFile(zip, ''),
      writeFile(join(root, 'latest.yml'), '')
    ])

    await expect(findArtifact(root, 'dmg')).resolves.toBe(dmg)
    await expect(findArtifact(root, 'zip')).resolves.toBe(zip)
    expect(artifactVersion(dmg)).toBe('0.12.0')
    expect(artifactVersion(zip)).toBe('0.12.0')
  })

  it('rejects ambiguous artifacts and app bundles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-macos-ambiguous-'))
    roots.push(root)
    await Promise.all([
      writeFile(join(root, 'one.dmg'), ''),
      writeFile(join(root, 'two.dmg'), ''),
      mkdir(join(root, 'One.app')),
      mkdir(join(root, 'Two.app'))
    ])

    await expect(findArtifact(root, 'dmg')).rejects.toThrow(/found 2/)
    await expect(findAppBundle(root)).rejects.toThrow(/found 2/)
  })

  it('parses isolated artifact, Gatekeeper, and signature-reading options', () => {
    expect(parseArguments(['--artifact-dir', 'dist', '--gatekeeper'])).toEqual({
      artifactDirectory: resolve('dist'),
      gatekeeper: true,
      signatureReading: undefined
    })
    expect(
      parseArguments(['--artifact-dir', 'dist', '--signature-reading', '/tmp/reading.json'])
    ).toEqual({
      artifactDirectory: resolve('dist'),
      gatekeeper: false,
      signatureReading: '/tmp/reading.json'
    })
    expect(() => parseArguments([])).toThrow(/Usage/)
    expect(() => parseArguments(['--artifact-dir', 'dist', '--signature-reading'])).toThrow(
      /--signature-reading needs a path/
    )
  })

  it('extracts the authenticated packaged service endpoint', () => {
    expect(
      parsePackagedAppEndpoint('PureScience Web: http://127.0.0.1:3210/?token=abc_123')
    ).toEqual({ endpoint: 'http://127.0.0.1:3210', auth: 'token=abc_123' })
    expect(parsePackagedAppEndpoint('not ready')).toBeUndefined()
  })

  it('isolates Electron state without replacing the macOS home directory', () => {
    expect(packagedLaunchArguments('/tmp/purescience-profile')).toEqual([
      '--user-data-dir=/tmp/purescience-profile',
      '--purescience-headless',
      '--serve=0'
    ])
  })

  it('names what it observed when the packaged service never arrives', () => {
    const message = describeStartupTimeout({
      label: 'DMG-mounted bundle zerolink-purescience-2.18.3-nightly.g6e1653e-mac-x64.dmg',
      elapsedMs: 60_140,
      timeoutMs: 60_000,
      processState: { status: 'running', pid: 4242 },
      output: [
        'Provisioning runtime ...',
        'PureScience Web: http://127.0.0.1:44100/?token=secret-value_1',
        'warn: renderer not ready',
        'tick'
      ].join('\n')
    })

    // Which of the two bundles (DMG mount vs ZIP extract) stalled, and how long it really waited.
    expect(message).toContain('DMG-mounted bundle zerolink-purescience-2.18.3-nightly')
    expect(message).toContain('after 60140 ms (limit 60000 ms)')
    // The process was alive: that rules out "it crashed at startup".
    expect(message).toContain('still running (pid 4242)')
    // An endpoint line did appear, so the format is what drifted — not the announcement.
    expect(message).toContain('1 line(s) mentioned the endpoint')
    expect(message).toContain('format drift')
    // Evidence stays readable, the bearer token does not.
    expect(message).toContain('http://127.0.0.1:44100/?token=<redacted>')
    expect(message).not.toContain('secret-value_1')
    expect(redactServiceTokens('a?token=abc_123&b=1')).toBe('a?token=<redacted>&b=1')
  })

  it('distinguishes "wrote nothing" from "printed something we cannot parse"', () => {
    const silent = describeStartupTimeout({
      label: 'ZIP-extracted bundle',
      elapsedMs: 60_002,
      timeoutMs: 60_000,
      processState: { status: 'exited', code: 3, signal: null },
      output: '   \n'
    })
    expect(silent).toContain('none — the app never announced a web endpoint')
    expect(silent).toContain('(the app wrote nothing to stdout or stderr)')
    expect(silent).toContain('already exited with code 3')

    const killed = describeStartupTimeout({
      label: 'ZIP-extracted bundle',
      elapsedMs: 60_002,
      timeoutMs: 60_000,
      processState: { status: 'exited', code: null, signal: 'SIGSEGV' },
      output: 'noise\n'
    })
    expect(killed).toContain('already exited on signal SIGSEGV')
    expect(killed).toContain('noise')
  })

  it('bounds the output tail instead of dumping an unbounded log', () => {
    const noise = Array.from({ length: 400 }, (_, index) => `line ${index} ${'x'.repeat(20)}`)
    const message = describeStartupTimeout({
      label: 'ZIP-extracted bundle',
      elapsedMs: 60_000,
      timeoutMs: 60_000,
      processState: { status: 'running', pid: 1 },
      output: noise.join('\n')
    })
    const tail = message.slice(message.indexOf('\n…') + 1)
    expect(tail.startsWith('…')).toBe(true)
    expect(tail.length).toBeLessThanOrEqual(2_001)
    expect(tail).toContain('line 399')
    expect(message).not.toContain('line 0 ')
  })

  it('tags a real timeout and rewrites only that branch', async () => {
    // Producer: waitFor's own timeout is tagged, so the enrichment cannot depend on message text.
    await expect(
      waitFor('something that never arrives', async () => undefined, 20)
    ).rejects.toMatchObject({ code: 'SMOKE_TIMEOUT' })

    const context = {
      label: 'ZIP-extracted bundle',
      elapsedMs: 60_000,
      timeoutMs: 60_000,
      processState: { status: 'running', pid: 7 },
      output: ''
    }
    const tagged = Object.assign(new Error('Timed out waiting for x.'), { code: 'SMOKE_TIMEOUT' })
    expect(String(toStartupFailure(tagged, context).message)).toContain(
      'Timed out waiting for the packaged macOS web service (ZIP-extracted bundle)'
    )
    // Every other cause already carries its own evidence — it must not be rewritten.
    const other = new Error('Packaged macOS bootstrap returned HTTP 503.')
    expect(toStartupFailure(other, context)).toBe(other)
  })

  it('requires the legacy ICNS fallback icon (no Xcode/actool Assets.car)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-macos-app-'))
    roots.push(root)
    const appBundle = join(root, 'PureScience.app')
    const executableDirectory = join(appBundle, 'Contents', 'MacOS')
    const resources = join(appBundle, 'Contents', 'Resources')
    await Promise.all([
      mkdir(executableDirectory, { recursive: true }),
      mkdir(resources, { recursive: true })
    ])
    await Promise.all([
      writeFile(join(executableDirectory, 'PureScience'), ''),
      writeFile(join(resources, 'app.asar'), ''),
      writeFile(join(resources, 'micromamba'), ''),
      writeFile(join(resources, 'Assets.car'), ''),
      writeFile(join(resources, 'icon.icns'), '')
    ])

    await expect(assertPackagedResources(appBundle)).resolves.toEqual({
      executable: join(executableDirectory, 'PureScience'),
      micromamba: join(resources, 'micromamba')
    })

    // Assets.car is no longer required (ICNS-only packaging without actool).
    await rm(join(resources, 'Assets.car'))
    await expect(assertPackagedResources(appBundle)).resolves.toEqual({
      executable: join(executableDirectory, 'PureScience'),
      micromamba: join(resources, 'micromamba')
    })

    // The legacy ICNS fallback is still mandatory.
    await rm(join(resources, 'icon.icns'))
    await expect(assertPackagedResources(appBundle)).rejects.toThrow()
  })

  // The smoke step runs with `continue-on-error`, so the job stays green while the reading file it was
  // supposed to write never appears — and the signing gate then says "never read", which reads the same
  // whether the step never ran or ran and failed. A failed run now leaves its own account behind.
  it('leaves a reading behind when the run fails, and it is still not a pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-macos-unobserved-'))
    roots.push(root)
    const readingPath = join(root, 'nested', 'mac-signature.json')
    const reason = describeSmokeFailure(
      Object.assign(
        new Error('Timed out waiting for the packaged macOS web service (ZIP-extracted bundle).'),
        { code: 'SMOKE_TIMEOUT' }
      )
    )

    await writeUnobservedReading(readingPath, reason)

    const reading = JSON.parse(await readFile(readingPath, 'utf8')) as Record<string, unknown>
    expect(reading).toMatchObject({
      schemaVersion: 1,
      source: 'smoke-failure',
      readable: false,
      signed: false
    })
    expect(String(reading.reason)).toContain('SMOKE_TIMEOUT')
    expect(String(reading.reason)).toContain('Timed out waiting for the packaged macOS web service')
    // A marker is an account of a failure, never evidence of a signature.
    expect(readingIsObserved(reading)).toBe(false)
    const decision = evaluateMacSignatureGate({ credentialsPresent: true, reading })
    expect(decision).toMatchObject({ ok: false, macSignature: 'unproven' })
    expect(decision.reason).toContain('Timed out waiting for the packaged macOS web service')
    // ... and it says which cause this was, instead of reusing the sentence for "nobody wrote anything".
    expect(decision.reason).not.toContain('no reading file was written at all')
  })

  it('says what kind of failure left no reading — code, one line, redacted, bounded', () => {
    // Only the first line: a stack or a multi-line child-process dump is not a reason.
    const timeout = Object.assign(
      new Error(
        'Timed out waiting for the packaged macOS web service (DMG-mounted bundle).\n  at waitFor (...)'
      ),
      { code: 'SMOKE_TIMEOUT' }
    )
    const described = describeSmokeFailure(timeout)
    expect(described.startsWith('SMOKE_TIMEOUT: ')).toBe(true)
    expect(described).toContain('DMG-mounted bundle')
    expect(described).not.toContain('at waitFor')

    // The packaged service address carries a bearer token, and the marker is copied into release evidence.
    const leaked = describeSmokeFailure(
      new Error('bootstrap failed for http://127.0.0.1:44100/?token=secret_1')
    )
    expect(leaked).toContain('token=<redacted>')
    expect(leaked).not.toContain('secret_1')

    expect(describeSmokeFailure(new Error('x'.repeat(400)))).toHaveLength(301)
    expect(describeSmokeFailure(new Error(''))).toContain('failed without a message')
    expect(describeSmokeFailure(undefined)).toContain('failed without a message')
  })

  it('finds the reading path leniently, so a usage error still leaves a marker', () => {
    expect(
      signatureReadingPath(['--artifact-dir', 'dist', '--signature-reading', '/tmp/r.json'])
    ).toBe('/tmp/r.json')
    expect(signatureReadingPath(['--artifact-dir', 'dist'])).toBeUndefined()
    // A missing value and "the next token is another flag" are both "no path" — never the flag name.
    expect(signatureReadingPath(['--artifact-dir', 'dist', '--signature-reading'])).toBeUndefined()
    expect(signatureReadingPath(['--signature-reading', '--gatekeeper'])).toBeUndefined()
  })

  // The half above only proves the helpers. This one proves the script's own failure path calls them:
  // a green job with `continue-on-error` and a missing reading file is exactly the shape that used to be
  // reported as "the step never ran".
  it('leaves the marker on disk when the script itself fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-macos-smoke-wiring-'))
    roots.push(root)
    const emptyArtifacts = join(root, 'dist')
    await mkdir(emptyArtifacts, { recursive: true })
    const readingPath = join(root, 'reading.json')

    const run = await runSmokeScript([
      '--artifact-dir',
      emptyArtifacts,
      '--signature-reading',
      readingPath
    ])

    expect(run.exitCode).toBe(1)
    const written = await readFile(readingPath, 'utf8').catch(() => undefined)
    expect(written).toBeDefined()
    const reading = JSON.parse(String(written)) as Record<string, unknown>
    expect(reading).toMatchObject({
      schemaVersion: 1,
      source: 'smoke-failure',
      readable: false,
      signed: false
    })
    // The reason is the real one from this run, not a generic "it failed". Which artifact the parallel
    // lookup reports first is a race, so the assertion pins the sentence, not the extension.
    //
    // On a non-macOS runner the script refuses before it looks at the artifacts at all, so the real reason
    // there is the refusal. Pin that instead of skipping the case: the wiring being proven (a marker on
    // disk, `readable: false`, exit 1) is platform-independent, and only the sentence differs.
    expect(String(reading.reason)).toMatch(
      process.platform === 'darwin' ? /Expected exactly one macOS (dmg|zip) in / : /requires macOS/
    )
    expect(readingIsObserved(reading)).toBe(false)
  })

  // Without a reading path there is nowhere to leave a marker, and the failure must still fail.
  it('still fails when no reading path was given', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-macos-smoke-nopath-'))
    roots.push(root)
    const emptyArtifacts = join(root, 'dist')
    await mkdir(emptyArtifacts, { recursive: true })

    const run = await runSmokeScript(['--artifact-dir', emptyArtifacts])

    expect(run.exitCode).toBe(1)
    expect(
      await readFile(join(root, 'reading.json'), 'utf8').catch(() => undefined)
    ).toBeUndefined()
  })
})
