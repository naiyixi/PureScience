import { basename, delimiter, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createNpmAvailabilityProbe, resolveNpmExecutable } from './npm-executable'
import type { ExecutableIdentity } from './version-probe-cache'

// The memoisation is the whole point of this module, so every test here counts version runs. The seams
// (filesystem, identity, the run itself) are injected: no test spawns real npm.
//
// Paths are built with `join`/`delimiter` rather than written with separators: these assertions run on
// the Windows lane too, where a literal `${dir}/npm` is not what `join` produces for the same inputs.

const FIRST_DIR = '/usr/bin'
const SECOND_DIR = '/opt/homebrew/bin'
const TWO_DIR_PATH = [FIRST_DIR, SECOND_DIR].join(delimiter)

const fileOnlyAt =
  (existing: string[]) =>
  (candidate: string): Promise<boolean> =>
    Promise.resolve(existing.includes(candidate))

const present = (identity: string): ExecutableIdentity => ({ kind: 'present', identity })

vi.setConfig({ testTimeout: 5_000 })

describe('npm-executable: PATH resolution', () => {
  it('returns the first PATH entry that holds an npm', async () => {
    await expect(
      resolveNpmExecutable({
        platform: 'linux',
        env: { PATH: TWO_DIR_PATH },
        isFile: fileOnlyAt([join(SECOND_DIR, 'npm')])
      })
    ).resolves.toBe(join(SECOND_DIR, 'npm'))
  })

  it('prefers the earlier directory when several hold one', async () => {
    await expect(
      resolveNpmExecutable({
        platform: 'darwin',
        env: { PATH: TWO_DIR_PATH },
        isFile: fileOnlyAt([join(FIRST_DIR, 'npm'), join(SECOND_DIR, 'npm')])
      })
    ).resolves.toBe(join(FIRST_DIR, 'npm'))
  })

  it('tries npm’s Windows shim spellings, in order', async () => {
    const seen: string[] = []
    const isFile = (candidate: string): Promise<boolean> => {
      seen.push(basename(candidate))
      return Promise.resolve(basename(candidate) === 'npm.bat')
    }

    await expect(
      resolveNpmExecutable({
        platform: 'win32',
        env: { PATH: TWO_DIR_PATH },
        isFile
      })
    ).resolves.toBe(join(FIRST_DIR, 'npm.bat'))
    // The shim spellings are tried in order within one directory, stopping at the first hit.
    expect(seen).toEqual(['npm.cmd', 'npm.exe', 'npm.bat'])
  })

  it('reports nothing found when no directory holds one', async () => {
    await expect(
      resolveNpmExecutable({
        platform: 'linux',
        env: { PATH: TWO_DIR_PATH },
        isFile: () => Promise.resolve(false)
      })
    ).resolves.toBeUndefined()
  })
})

describe('npm-executable: memoisation', () => {
  it('runs the version probe once for the same resolved binary', async () => {
    const runVersion = vi.fn(() => Promise.resolve('10.9.0'))
    const available = createNpmAvailabilityProbe({
      platform: 'linux',
      env: { PATH: TWO_DIR_PATH },
      isFile: fileOnlyAt([join(FIRST_DIR, 'npm')]),
      identify: () => Promise.resolve(present('1000:42')),
      runVersion
    })

    await expect(available()).resolves.toBe(true)
    await expect(available()).resolves.toBe(true)
    await expect(available()).resolves.toBe(true)
    expect(runVersion).toHaveBeenCalledTimes(1)
  })

  it('probes again when the binary’s identity changed (an upgrade)', async () => {
    let identity = '1000:42'
    const runVersion = vi.fn(() => Promise.resolve('10.9.0'))
    const available = createNpmAvailabilityProbe({
      platform: 'linux',
      env: { PATH: TWO_DIR_PATH },
      isFile: fileOnlyAt([join(FIRST_DIR, 'npm')]),
      identify: () => Promise.resolve(present(identity)),
      runVersion
    })

    await available()
    identity = '2000:43'
    await available()

    expect(runVersion).toHaveBeenCalledTimes(2)
  })

  it('does not remember a failed probe', async () => {
    let answer: string | undefined
    const runVersion = vi.fn(() => Promise.resolve(answer))
    const available = createNpmAvailabilityProbe({
      platform: 'linux',
      env: { PATH: TWO_DIR_PATH },
      isFile: fileOnlyAt([join(FIRST_DIR, 'npm')]),
      identify: () => Promise.resolve(present('1000:42')),
      runVersion
    })

    answer = undefined
    await expect(available()).resolves.toBe(false)
    // npm installed a moment later on the same call path: the next call must see it, so a failure is
    // never cached as an answer.
    answer = '10.9.0'
    await expect(available()).resolves.toBe(true)
    expect(runVersion).toHaveBeenCalledTimes(2)
  })

  it('shares one run between concurrent callers', async () => {
    const runVersion = vi.fn(() => Promise.resolve('10.9.0'))
    const available = createNpmAvailabilityProbe({
      platform: 'linux',
      env: { PATH: TWO_DIR_PATH },
      isFile: fileOnlyAt([join(FIRST_DIR, 'npm')]),
      identify: () => Promise.resolve(present('1000:42')),
      runVersion
    })

    await expect(Promise.all([available(), available(), available()])).resolves.toEqual([
      true,
      true,
      true
    ])
    expect(runVersion).toHaveBeenCalledTimes(1)
  })

  it('probes every time when PATH resolution finds no npm', async () => {
    const runVersion = vi.fn(() => Promise.resolve('10.9.0'))
    const available = createNpmAvailabilityProbe({
      platform: 'linux',
      env: { PATH: TWO_DIR_PATH },
      isFile: () => Promise.resolve(false),
      identify: () => Promise.resolve(present('1000:42')),
      runVersion
    })

    await expect(available()).resolves.toBe(true)
    await expect(available()).resolves.toBe(true)
    // Unresolved means "unknown", not "missing": the spawn may still succeed through the shell, so this
    // path stays uncached (it is the pre-existing behaviour).
    expect(runVersion).toHaveBeenCalledTimes(2)
  })

  it('reports unavailable when the resolved binary is gone, without spawning', async () => {
    const runVersion = vi.fn(() => Promise.resolve('10.9.0'))
    const available = createNpmAvailabilityProbe({
      platform: 'linux',
      env: { PATH: TWO_DIR_PATH },
      isFile: fileOnlyAt([join(FIRST_DIR, 'npm')]),
      identify: () => Promise.resolve({ kind: 'missing' }),
      runVersion
    })

    await expect(available()).resolves.toBe(false)
    expect(runVersion).not.toHaveBeenCalled()
  })
})
