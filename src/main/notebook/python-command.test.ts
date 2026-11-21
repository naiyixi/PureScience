import { describe, expect, it, vi } from 'vitest'

import {
  findPythonCommand,
  isPython3Version,
  parsePythonVersion,
  resolvePythonCommand
} from './python-command'

describe('resolvePythonCommand', () => {
  it('accepts Python 3 versions and rejects Python 2', () => {
    expect(isPython3Version('Python 3.12.2')).toBe(true)
    expect(isPython3Version('Python 2.7.18')).toBe(false)
  })

  it('returns undefined from the non-blocking environment probe when Python is missing', async () => {
    const result = await findPythonCommand({
      platform: 'linux',
      probe: vi.fn().mockResolvedValue(false)
    })

    expect(result).toBeUndefined()
  })

  it('prefers python3, then python, on unix', async () => {
    const tried: string[] = []
    const result = await resolvePythonCommand({
      platform: 'linux',
      probe: ({ command }) => {
        tried.push(command)
        return Promise.resolve(command === 'python')
      }
    })

    expect(tried).toEqual(['python3', 'python'])
    expect(result).toEqual({ command: 'python', baseArgs: [] })
  })

  it('prefers the `py -3` launcher on windows', async () => {
    const result = await resolvePythonCommand({
      platform: 'win32',
      probe: ({ command }) => Promise.resolve(command === 'py')
    })

    expect(result).toEqual({ command: 'py', baseArgs: ['-3'] })
  })

  it('falls through py -> python -> python3 on windows', async () => {
    const tried: string[] = []
    const result = await resolvePythonCommand({
      platform: 'win32',
      probe: ({ command }) => {
        tried.push(command)
        return Promise.resolve(command === 'python3')
      }
    })

    expect(tried).toEqual(['py', 'python', 'python3'])
    expect(result).toEqual({ command: 'python3', baseArgs: [] })
  })

  it('falls back to the preferred candidate when none respond', async () => {
    const win = await resolvePythonCommand({
      platform: 'win32',
      probe: () => Promise.resolve(false)
    })
    const nix = await resolvePythonCommand({
      platform: 'linux',
      probe: () => Promise.resolve(false)
    })

    expect(win).toEqual({ command: 'py', baseArgs: ['-3'] })
    expect(nix).toEqual({ command: 'python3', baseArgs: [] })
  })
})

describe('parsePythonVersion', () => {
  it('reads the version off a clean `--version` line', () => {
    expect(parsePythonVersion('Python 3.12.4\n')).toBe('3.12.4')
  })

  it('ignores unrelated lines an interpreter prints around the version', () => {
    // CPython's own `venv` module warns about DOS 8.3 paths (C:\Users\RUNNER~1\…) — a spurious warning
    // according to its tracker (bpo-45337), but one that used to be reported AS the interpreter's version,
    // which made a good interpreter read as not runnable on the Windows runner.
    const noisy =
      'Actual environment location may have moved due to redirects, links or junctions.\n' +
      '  Requested location: "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\u10\\venv\\Scripts\\python3.exe"\n' +
      '  Actual location:    "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\u10\\venv\\Scripts\\python3.exe"\n' +
      'Python 3.11.9\n'
    expect(parsePythonVersion(noisy)).toBe('3.11.9')
  })

  it('keeps a pre-release suffix', () => {
    expect(parsePythonVersion('Python 3.14.0b2')).toBe('3.14.0b2')
  })

  it('says nothing when there is no version to read', () => {
    expect(parsePythonVersion('command not found')).toBeUndefined()
    expect(parsePythonVersion('')).toBeUndefined()
  })
})
