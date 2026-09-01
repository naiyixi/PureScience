import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  codeBuddyBinaryNames,
  detectCodeBuddy,
  parseVersion,
  type CodeBuddyDetectDeps
} from './codebuddy-detect'

const posix = path.posix

const makeDeps = (overrides: Partial<CodeBuddyDetectDeps> = {}): CodeBuddyDetectDeps => ({
  env: { PATH: '/usr/bin:/usr/local/bin' },
  homePath: '/home/u',
  platform: 'darwin',
  isExecutable: async () => true,
  getVersion: async () => '2.138.0',
  resolveNpmBinDirs: async () => [],
  ...overrides
})

describe('codeBuddyBinaryNames', () => {
  it('tries Windows shims first and the extensionless name last', () => {
    expect(codeBuddyBinaryNames('win32')).toEqual([
      'codebuddy.cmd',
      'codebuddy.exe',
      'codebuddy.bat',
      'codebuddy'
    ])
  })

  it('uses a single name on Unix', () => {
    expect(codeBuddyBinaryNames('darwin')).toEqual(['codebuddy'])
  })
})

describe('detectCodeBuddy', () => {
  it('returns the first executable candidate that reports a version', async () => {
    const found = await detectCodeBuddy(
      makeDeps({
        isExecutable: async (candidate) => candidate === posix.join('/usr/local/bin', 'codebuddy'),
        getVersion: async () => '2.1.0'
      })
    )
    expect(found).toEqual({
      resolvedPath: posix.join('/usr/local/bin', 'codebuddy'),
      version: '2.1.0'
    })
  })

  it('skips candidates that cannot report a version and keeps searching', async () => {
    const found = await detectCodeBuddy(
      makeDeps({
        // Only the homebrew dir is executable; the PATH candidates are not.
        isExecutable: async (candidate) => candidate === posix.join('/opt/homebrew/bin', 'codebuddy'),
        getVersion: async () => '2.2.0'
      })
    )
    expect(found?.resolvedPath).toBe(posix.join('/opt/homebrew/bin', 'codebuddy'))
  })

  it('returns undefined when nothing is installed', async () => {
    const found = await detectCodeBuddy(makeDeps({ isExecutable: async () => false }))
    expect(found).toBeUndefined()
  })

  it('probes the app-managed install dir via extraDirs', async () => {
    const managed = posix.join('/data', 'codebuddy', 'bin')
    const found = await detectCodeBuddy(
      makeDeps({
        extraDirs: [managed],
        isExecutable: async (candidate) => candidate === posix.join(managed, 'codebuddy')
      })
    )
    expect(found?.resolvedPath).toBe(posix.join(managed, 'codebuddy'))
  })
})

describe('parseVersion', () => {
  it('extracts the first version token', () => {
    expect(parseVersion('2.138.0')).toBe('2.138.0')
    expect(parseVersion('v1.2.3-beta')).toBe('1.2.3-beta')
  })

  it('falls back to trimmed output', () => {
    expect(parseVersion('  ')).toBeUndefined()
  })
})
