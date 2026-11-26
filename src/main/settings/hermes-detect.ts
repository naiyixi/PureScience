import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { augmentedPathEnv } from './shell-path'
import { createLogger } from '../logger'
import { withVersionProbeCache } from './version-probe-cache'

const execFileAsync = promisify(execFile)

export type HermesDetectResult = {
  resolvedPath: string
  version?: string
}

// Detects a runnable `hermes` executable. Hermes is a Python package (installed with pipx or pip), not an
// npm CLI, so its install locations differ from the other four frameworks: pipx keeps the console script
// in `~/.local/bin` and the venv under `~/.local/pipx/venvs/hermes-agent/bin`, and Windows puts scripts
// under `%APPDATA%\Python\Scripts` or `%LOCALAPPDATA%\pipx\venvs\hermes-agent\Scripts`. Deps are injectable
// (host platform included) so the probe order and win32 rules stay unit-testable.
export type HermesDetectDeps = {
  env: NodeJS.ProcessEnv
  homePath: string
  platform: NodeJS.Platform
  isExecutable: (path: string) => Promise<boolean>
  getVersion: (path: string) => Promise<string | undefined>
  extraDirs?: string[]
}

const pathFor = (platform: NodeJS.Platform): path.PlatformPath =>
  platform === 'win32' ? path.win32 : path.posix

// Windows resolves a bare command through PATHEXT, so the pipx/pip shims are tried by extension; the
// extensionless name stays last as a catch-all. Unix has only `hermes`.
const hermesBinaryNames = (platform: NodeJS.Platform): string[] =>
  platform === 'win32' ? ['hermes.exe', 'hermes.cmd', 'hermes.bat', 'hermes'] : ['hermes']

const wellKnownDirs = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] => {
  if (platform === 'win32') {
    const p = pathFor(platform)

    return [
      env.APPDATA ? p.join(env.APPDATA, 'Python', 'Scripts') : '',
      '/opt/homebrew/bin',
      '/usr/local/bin'
    ].filter(Boolean)
  }

  return ['/opt/homebrew/bin', '/usr/local/bin']
}

// pipx's per-app venv bin dir: this is where the console script lives when `pipx install` ran with an
// isolated prefix, and a GUI app's PATH would never contain it.
const pipxVenvDirs = (deps: HermesDetectDeps): string[] => {
  const p = pathFor(deps.platform)

  if (deps.platform === 'win32') {
    const root = deps.env.LOCALAPPDATA

    return root ? [p.join(root, 'pipx', 'venvs', 'hermes-agent', 'Scripts')] : []
  }

  return [p.join(deps.homePath, '.local', 'pipx', 'venvs', 'hermes-agent', 'bin')]
}

const collectCandidateDirs = (deps: HermesDetectDeps): string[] => {
  const p = pathFor(deps.platform)
  const pathDirs = (deps.env.PATH ?? '').split(p.delimiter).filter((dir) => dir.length > 0)

  return Array.from(
    new Set([
      ...pathDirs,
      p.join(deps.homePath, '.local', 'bin'),
      ...pipxVenvDirs(deps),
      ...(deps.extraDirs ?? []),
      ...wellKnownDirs(deps.platform, deps.env)
    ])
  )
}

// `hermes --version` prints a whole line — `Hermes Agent v0.23.3 (2026.9.24) · stable · local caafe5389ae5`
// on 0.23.3. The version is the `v`-prefixed semver, NOT the first number-looking token: `2026.9.24` is
// the build date and would read as a version if the scan were naive.
const parseHermesVersion = (output: string): string | undefined => {
  const tagged = output.match(/\bv(\d+\.\d+(?:\.\d+)?[\w.-]*)\b/)
  if (tagged) return tagged[1]
  const bare = output.match(/\b\d+\.\d+\.\d+[\w.-]*\b/)
  return bare ? bare[0] : undefined
}

const detectHermes = async (
  deps: HermesDetectDeps = createDefaultHermesDetectDeps()
): Promise<HermesDetectResult | undefined> => {
  const p = pathFor(deps.platform)
  const binaryNames = hermesBinaryNames(deps.platform)

  for (const dir of collectCandidateDirs(deps)) {
    for (const name of binaryNames) {
      const candidate = p.join(dir, name)

      if (!(await deps.isExecutable(candidate))) continue

      const version = await deps.getVersion(candidate)

      // A binary that exists but cannot report a version is not usable; keep searching.
      if (version === undefined) continue

      return { resolvedPath: candidate, version }
    }
  }

  return undefined
}

const isExecutableFile =
  (platform: NodeJS.Platform) =>
  async (path: string): Promise<boolean> => {
    try {
      await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK)

      return true
    } catch {
      return false
    }
  }

// `<path> --version`. A `.cmd`/`.bat` shim cannot be launched by execFile without a shell on Windows, so
// those go through the shell with the path quoted. Short timeout: a hung binary must not stall detection.
const runHermesVersion =
  (platform: NodeJS.Platform) =>
  async (binaryPath: string): Promise<string | undefined> => {
    try {
      const { stdout } =
        platform === 'win32' && /\.(cmd|bat)$/i.test(binaryPath)
          ? await execFileAsync(`"${binaryPath}"`, ['--version'], {
              timeout: 15_000,
              shell: true,
              windowsHide: true,
              env: augmentedPathEnv(process.env)
            })
          : await execFileAsync(binaryPath, ['--version'], {
              timeout: 15_000,
              windowsHide: true,
              env: augmentedPathEnv(process.env)
            })

      return parseHermesVersion(stdout)
    } catch (error) {
      createLogger('settings-detect').warn('hermes version probe failed', {
        binaryPath,
        message: error instanceof Error ? error.message : String(error)
      })

      return undefined
    }
  }

const createDefaultHermesDetectDeps = (): HermesDetectDeps => {
  const platform = process.platform

  return {
    env: process.env,
    homePath: homedir(),
    platform,
    isExecutable: isExecutableFile(platform),
    getVersion: withVersionProbeCache(runHermesVersion(platform))
  }
}

export { collectCandidateDirs, createDefaultHermesDetectDeps, detectHermes, parseHermesVersion }
