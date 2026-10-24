// Identity-keyed memoisation for "is npm on PATH?", the question `settings:npm-available` asks.
//
// Real evidence, 2026-10-24 (three packaged-build logs from one host, one afternoon): that channel's
// handler was logged as slow 37 times, median 1.9 s, max 22.6 s. Every one of those calls ran a full
// `npm --version` — npm is a JavaScript program behind a shim, so that is an entire Node start — and
// every one of them asked the same question about the same file. Nothing about the answer can change
// between two calls unless the file behind `npm` changed, so the answer is remembered on that file's
// identity (`mtimeMs` + `size`, symlinks followed), via the same `withVersionProbeCache` the runtime
// version probes use. A repeat call then costs one PATH scan plus one `stat` instead of a Node start.
//
// What this deliberately does NOT change:
//   * How npm is launched. The probe still runs the bare name `npm` with exactly the options it used
//     before: a shell on Windows (npm there is an `npm.cmd` batch shim execFile cannot start directly)
//     and the augmented PATH (so a GUI-launched app still resolves a Homebrew/nvm install). Only the
//     repeat cost goes away, and only while the binary is byte-identical in size and mtime.
//   * The unresolved case. When the PATH scan finds nothing, the identity is `unknown` — never
//     `missing`: on Windows the shell can still resolve the name through PATHEXT, so "we could not find
//     it ourselves" is not proof that npm is absent. That path probes uncached, exactly as before.
//   * Failures. A probe that fails (spawn error, timeout under load) is not remembered, so a runtime
//     installed a minute later is reported available on the next call instead of being stuck as
//     "missing" until the file changes.

import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

import { augmentedPathEnv } from './shell-path'
import {
  identifyExecutable,
  withVersionProbeCache,
  type ExecutableIdentity,
  type VersionProbe
} from './version-probe-cache'

const execFileAsync = promisify(execFile)

// Same budget the previous inline probe used; kept so a hung npm still answers instead of hanging the
// settings read.
const NPM_PROBE_TIMEOUT_MS = 10_000

/**
 * Injectable seams. Everything has a real default, so callers pass nothing in production; tests supply
 * a fake filesystem, a fixed identity and a scripted version run.
 */
export type NpmProbeDeps = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Whether a candidate path holds a file. Injected so PATH resolution is testable without real files. */
  isFile?: (candidate: string) => Promise<boolean>
  /** Identity of a resolved npm. Injected so the memoisation is testable without real files. */
  identify?: (executablePath: string) => Promise<ExecutableIdentity>
  /** The version run itself. Injected so tests never spawn npm. */
  runVersion?: () => Promise<string | undefined>
}

const isFileAt = async (candidate: string): Promise<boolean> => {
  try {
    return (await stat(candidate)).isFile()
  } catch {
    return false
  }
}

// The names a PATH scan has to try. Which one exists on Windows depends on how Node was installed (the
// MSI, nvm-windows, or a plain global bin), so all of npm's shim spellings are candidates there.
const npmCandidateNames = (platform: NodeJS.Platform): string[] =>
  platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm.bat', 'npm'] : ['npm']

/**
 * First npm on the (already augmented) PATH, or `undefined` when the scan finds none. Used only as the
 * cache's identity source — the spawn itself still goes through the bare name, see the header.
 */
export const resolveNpmExecutable = async (
  deps: NpmProbeDeps = {}
): Promise<string | undefined> => {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? augmentedPathEnv()
  const isFile = deps.isFile ?? isFileAt
  const dirs = (env.PATH ?? '').split(delimiter).filter((dir) => dir.length > 0)

  for (const dir of dirs) {
    for (const name of npmCandidateNames(platform)) {
      const candidate = join(dir, name)
      if (await isFile(candidate)) return candidate
    }
  }

  return undefined
}

const runNpmVersion = async (deps: NpmProbeDeps): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync('npm', ['--version'], {
      timeout: NPM_PROBE_TIMEOUT_MS,
      // On Windows npm is an `npm.cmd` shim that execFile can't launch without a shell.
      shell: (deps.platform ?? process.platform) === 'win32',
      windowsHide: true,
      env: deps.env ?? augmentedPathEnv()
    })

    // The version string is only a marker here; npm that answers with an empty line still answered.
    return String(stdout).trim() || 'available'
  } catch {
    return undefined
  }
}

/**
 * One memoised availability probe. The argument handed to the returned probe is ignored: the cache keys
 * on it (a constant name, since the spawn is path-independent), while the identity comes from resolving
 * npm on PATH every call — that is what makes a freshly installed npm visible without a restart.
 */
export const createNpmAvailabilityProbe = (deps: NpmProbeDeps = {}): (() => Promise<boolean>) => {
  const platform = deps.platform ?? process.platform
  const identify = deps.identify ?? ((path: string) => identifyExecutable(path, platform))
  const runVersion = deps.runVersion ?? (() => runNpmVersion(deps))
  const versionProbe: VersionProbe = withVersionProbeCache(runVersion, {
    identify: async () => {
      const resolved = await resolveNpmExecutable(deps)
      // Unresolved is "unknown", never "missing": see the header on Windows/PATHEXT.
      return resolved === undefined ? { kind: 'unknown' } : identify(resolved)
    }
  })

  return async () => (await versionProbe('npm')) !== undefined
}

const defaultNpmAvailabilityProbe = createNpmAvailabilityProbe()

/** Whether npm can answer `--version`, memoised on the identity of the npm found on PATH. */
export const npmAvailable = (): Promise<boolean> => defaultNpmAvailabilityProbe()
