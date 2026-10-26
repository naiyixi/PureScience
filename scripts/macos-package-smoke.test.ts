import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  artifactVersion,
  assertPackagedResources,
  describeStartupTimeout,
  findAppBundle,
  findArtifact,
  packagedLaunchArguments,
  parseArguments,
  parsePackagedAppEndpoint,
  redactServiceTokens,
  toStartupFailure,
  waitFor
} from './macos-package-smoke.mjs'

const roots: string[] = []

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
})
