import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { augmentedPathEnv } from './shell-path'
import { withVersionProbeCache } from './version-probe-cache'

const execFileAsync = promisify(execFile)

export type AgentCliDetectResult = {
  resolvedPath: string
  version?: string
}

// DeepSeek Harness and Pi both ship an ACP server as an npm console script, so they share one detector shape:
// binary names per platform, the npm/vendor global bin dirs a GUI process never has on PATH, and
// `<bin> --version` for the version. Hermes stays separate — it is a Python package reached through pipx.
export type AgentCliSpec = {
  // Extension-less names as published; Windows extensions are derived.
  binaryNames: readonly string[]
  // Extra dirs beyond PATH + the npm globals (e.g. a per-app venv bin).
  extraDirs?: readonly string[]
  // True when the binary does not answer `--version`. Measured: `pi-acp --version` prints nothing at all and
  // exits 0, so requiring a version there would make an installed adapter look absent forever.
  versionOptional?: boolean
}

export type AgentCliDetectDeps = {
  env: NodeJS.ProcessEnv
  homePath: string
  platform: NodeJS.Platform
  isExecutable: (candidate: string) => Promise<boolean>
  getVersion: (binaryPath: string) => Promise<string | undefined>
}

const pathFor = (platform: NodeJS.Platform): path.PlatformPath =>
  platform === 'win32' ? path.win32 : path.posix

const namesFor = (spec: AgentCliSpec, platform: NodeJS.Platform): string[] =>
  platform === 'win32'
    ? spec.binaryNames.flatMap((name) => [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name])
    : [...spec.binaryNames]

// npm puts globals in a prefix whose bin dir is on PATH only for the shell that installed them. These are the
// prefixes npm/nvm/volta/pnpm use; a GUI launch sees none of them.
const npmGlobalDirs = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string[] => {
  const p = pathFor(platform)

  if (platform === 'win32') {
    const npmPrefix = env.APPDATA ? p.join(env.APPDATA, 'npm') : ''
    const localPrefix = env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, 'npm') : ''

    return [npmPrefix, localPrefix].filter((dir) => dir.length > 0)
  }

  return [
    p.join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    p.join(home, '.volta', 'bin'),
    p.join(home, 'n', 'bin'),
    p.join(home, '.local', 'bin')
  ]
}

const collectCandidateDirs = (deps: AgentCliDetectDeps, spec: AgentCliSpec): string[] => {
  const p = pathFor(deps.platform)
  const pathDirs = (deps.env.PATH ?? '').split(p.delimiter).filter((dir) => dir.length > 0)

  return Array.from(
    new Set([
      ...pathDirs,
      ...(spec.extraDirs ?? []),
      ...npmGlobalDirs(deps.platform, deps.env, deps.homePath)
    ])
  )
}

const parseVersion = (output: string): string | undefined => {
  // These binaries print a bare semver (`0.1.27`); a `v` prefix is tolerated but not required.
  const match = output.match(/\bv?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)
  return match ? match[1] : undefined
}

const detectAgentCli = async (
  spec: AgentCliSpec,
  deps: AgentCliDetectDeps
): Promise<AgentCliDetectResult | undefined> => {
  const p = pathFor(deps.platform)
  const names = namesFor(spec, deps.platform)

  for (const dir of collectCandidateDirs(deps, spec)) {
    for (const name of names) {
      const candidate = p.join(dir, name)

      if (!(await deps.isExecutable(candidate))) continue

      const version = await deps.getVersion(candidate)

      // No version ⇒ not usable, unless the binary is known not to have a version flag at all.
      if (version === undefined && spec.versionOptional !== true) continue

      return version === undefined
        ? { resolvedPath: candidate }
        : { resolvedPath: candidate, version }
    }
  }

  return undefined
}

const isExecutableFile =
  (platform: NodeJS.Platform) =>
  async (candidate: string): Promise<boolean> => {
    try {
      await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK)
      return true
    } catch {
      return false
    }
  }

const runVersionProbe =
  (platform: NodeJS.Platform) =>
  async (binaryPath: string): Promise<string | undefined> => {
    try {
      const needsShell = platform === 'win32' && /\.(cmd|bat)$/i.test(binaryPath)
      const { stdout } = needsShell
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

      return parseVersion(stdout)
    } catch {
      return undefined
    }
  }

// `spec` is what the caller resolves a backend from — this factory only builds the probing deps (env, home,
// platform, executable test, version probe), so it is accepted for the caller shape and not read here. Kept
// as `_spec` rather than dropped: the call sites pass it positionally, and a silent parameter removal is a
// `TS2554` for every one of them the day they land.
export const createAgentCliDetectDeps = (
  _spec: AgentCliSpec,
  overrides?: Partial<AgentCliDetectDeps>
): AgentCliDetectDeps => {
  const platform = process.platform

  return {
    env: process.env,
    homePath: homedir(),
    platform,
    isExecutable: isExecutableFile(platform),
    getVersion: withVersionProbeCache(runVersionProbe(platform)),
    ...overrides
  }
}

// `deepseek-harness-acp` also answers to `dsh-acp` (both are in its own --help).
export const DEEPSEEK_HARNESS_CLI: AgentCliSpec = {
  binaryNames: ['deepseek-harness-acp', 'dsh-acp']
}

// `pi-acp` is the community ACP adapter; Pi's own CLI is a separate binary and neither implies the other.
export const PI_ACP_CLI: AgentCliSpec = {
  binaryNames: ['pi-acp'],
  versionOptional: true
}

export { collectCandidateDirs, detectAgentCli, parseVersion }
