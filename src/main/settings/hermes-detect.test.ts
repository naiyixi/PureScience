import { describe, expect, it } from 'vitest'

import {
  collectCandidateDirs,
  detectHermes,
  parseHermesVersion,
  type HermesDetectDeps
} from './hermes-detect'

// `hermes --version` on 0.23.3 prints one line: `Hermes Agent v0.23.3 (2026.9.24) · stable · local <sha>`.
// The version is the v-prefixed semver; `2026.9.24` is the build date and must never win.
const REAL_VERSION_LINE = 'Hermes Agent v0.23.3 (2026.9.24) · stable · local caafe5389ae5'

const deps = (overrides: Partial<HermesDetectDeps> = {}): HermesDetectDeps => ({
  env: { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
  homePath: '/home/u',
  platform: 'darwin',
  isExecutable: async (candidate) => candidate === '/home/u/.local/bin/hermes',
  getVersion: async (candidate) =>
    candidate === '/home/u/.local/bin/hermes' ? '0.23.3' : undefined,
  ...overrides
})

describe('parseHermesVersion', () => {
  it('takes the v-prefixed semver, never the build date beside it', () => {
    expect(parseHermesVersion(REAL_VERSION_LINE)).toBe('0.23.3')
    expect(parseHermesVersion(REAL_VERSION_LINE)).not.toBe('2026.9.24')
  })

  it('falls back to a bare semver when the line carries no v-prefix', () => {
    expect(parseHermesVersion('hermes 0.24.1\n')).toBe('0.24.1')
  })

  it('returns undefined when nothing version-shaped is present', () => {
    expect(parseHermesVersion('command not found')).toBeUndefined()
  })
})

describe('collectCandidateDirs', () => {
  it('looks in pipx locations a GUI app PATH never contains', () => {
    const dirs = collectCandidateDirs(deps())

    // pipx console scripts land in ~/.local/bin; the per-app venv bin dir is where an isolated prefix
    // installs it, and neither is on a GUI app's PATH.
    expect(dirs).toContain('/home/u/.local/bin')
    expect(dirs).toContain('/home/u/.local/pipx/venvs/hermes-agent/bin')
    expect(dirs).toContain('/usr/bin')
  })

  it('probes the Windows script locations when the injected platform is win32', () => {
    const dirs = collectCandidateDirs(
      deps({
        platform: 'win32',
        homePath: 'C:\\Users\\u',
        env: {
          PATH: 'C:\\Windows',
          APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
          LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local'
        } as NodeJS.ProcessEnv
      })
    )

    expect(dirs.some((dir) => dir.includes('Python\\Scripts'))).toBe(true)
    expect(dirs.some((dir) => dir.includes('pipx\\venvs\\hermes-agent\\Scripts'))).toBe(true)
  })
})

describe('detectHermes', () => {
  it('returns the first candidate that reports a version', async () => {
    await expect(detectHermes(deps())).resolves.toEqual({
      resolvedPath: '/home/u/.local/bin/hermes',
      version: '0.23.3'
    })
  })

  it('treats an executable that cannot report a version as not installed', async () => {
    await expect(
      detectHermes(
        deps({
          isExecutable: async () => true,
          getVersion: async () => undefined
        })
      )
    ).resolves.toBeUndefined()
  })

  it('returns undefined when nothing is executable', async () => {
    await expect(detectHermes(deps({ isExecutable: async () => false }))).resolves.toBeUndefined()
  })
})
