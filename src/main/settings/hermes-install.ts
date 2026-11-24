import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import type { ClaudeInstallEvent, ClaudeInstallResult } from '../../shared/settings'

/**
 * Where pipx's console script lands. The lookup deps are injectable (platform, environment and home
 * included) so the Windows rules stay unit-testable on a macOS runner — the Windows lane is the only
 * place this runs for real, and it has to be right before that lane sees it.
 */
export type PipxLookupDeps = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homePath?: string
}

// Unix: pipx's own default bin dir, the Homebrew prefixes (Apple silicon / Intel), and pyenv's shims.
// Windows: `pip install --user pipx` puts the console script under `%APPDATA%\Python\Scripts`, and pipx
// keeps a script of its own under `%LOCALAPPDATA%\pipx\venvs\pipx\Scripts`. The shim spellings are tried
// by extension because that is how Windows resolves a command (PATHEXT).
const wellKnownPipxDirs = (deps: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  homePath: string
}): string[] => {
  const p = deps.platform === 'win32' ? path.win32 : path.posix

  if (deps.platform === 'win32') {
    return [
      deps.env.APPDATA ? p.join(deps.env.APPDATA, 'Python', 'Scripts') : '',
      deps.env.LOCALAPPDATA ? p.join(deps.env.LOCALAPPDATA, 'pipx', 'venvs', 'pipx', 'Scripts') : ''
    ].filter((dir) => dir.length > 0)
  }

  return [
    p.join(deps.homePath, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    p.join(deps.homePath, '.pyenv', 'shims')
  ]
}

const pipxNames = (platform: NodeJS.Platform): string[] =>
  platform === 'win32' ? ['pipx.exe', 'pipx.cmd', 'pipx.bat', 'pipx'] : ['pipx']

/**
 * Candidate paths in probe order, well-known dirs first. PATH comes last on purpose: a GUI app inherits
 * launchd's PATH (macOS) or a stripped one, so a shell-visible `~/.local/bin` is often not on it.
 */
export const pipxCandidates = (deps: PipxLookupDeps = {}): string[] => {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const homePath = deps.homePath ?? homedir()
  const p = platform === 'win32' ? path.win32 : path.posix
  const names = pipxNames(platform)

  const wellKnown = wellKnownPipxDirs({ platform, env, homePath }).flatMap((dir) =>
    names.map((name) => p.join(dir, name))
  )
  const onPath = (env.PATH ?? '')
    .split(p.delimiter)
    .filter((dir) => dir.length > 0)
    .flatMap((dir) => names.map((name) => p.join(dir, name)))

  return [...wellKnown, ...onPath]
}

export const resolvePipxPath = (
  exists: (path: string) => boolean = existsSync,
  deps: PipxLookupDeps = {}
): string | null => pipxCandidates(deps).find((candidate) => exists(candidate)) ?? null

/** The spawn call shape this module needs. Production uses `spawn`; tests supply a scripted child. */
export type HermesPipxSpawn = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv
    stdio: ['ignore', 'pipe', 'pipe']
    windowsHide: boolean
  }
) => ChildProcess

export type HermesPipxInstallOptions = {
  installId: string
  onEvent: (event: ClaudeInstallEvent) => void
  // Injected in tests so a pipx can be driven without touching the real environment.
  pipxPath?: string | null
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  // Injected in tests. A POSIX shebang script is not runnable on Windows, so a scripted child is the
  // only fixture that exercises this code path on both lanes.
  spawnImpl?: HermesPipxSpawn
}

const PIPX_TIMEOUT_MS = 15 * 60 * 1000

const log = (
  options: HermesPipxInstallOptions,
  stream: 'stdout' | 'stderr' | 'system',
  chunk: string
): void => {
  options.onEvent({ kind: 'log', installId: options.installId, stream, chunk })
}

/**
 * Installs Hermes Agent through pipx.
 *
 * The exit code from pipx is not the answer to "did this install": pipx reports success for a package
 * whose console script lands somewhere the app cannot see, and it is the app's own detector that decides
 * what the card will show. So this returns pipx's outcome and the caller re-detects — a non-zero exit is
 * reported with pipx's own last lines, never guessed at.
 */
export const installHermesWithPipx = async (
  options: HermesPipxInstallOptions
): Promise<ClaudeInstallResult> => {
  const pipxPath = options.pipxPath === undefined ? resolvePipxPath() : options.pipxPath

  if (!pipxPath) {
    return {
      installId: options.installId,
      ok: false,
      error:
        'pipx was not found. Hermes is a Python package, so pipx is required: install it with ' +
        '`brew install pipx` or `python3 -m pip install --user pipx`, then press Install again. ' +
        'Nothing was changed for you.'
    }
  }

  log(options, 'system', `$ ${pipxPath} install hermes-agent\n`)
  // pipx reports no byte counts, so this is the only progress tick there is: the UI runs an
  // indeterminate bar for the phase rather than a made-up percentage.
  options.onEvent({ kind: 'progress', installId: options.installId, phase: 'installing' })

  const tail: string[] = []
  const timeoutMs = options.timeoutMs ?? PIPX_TIMEOUT_MS
  const spawnProcess: HermesPipxSpawn = options.spawnImpl ?? spawn

  const outcome = await new Promise<{ code: number | null; timedOut: boolean; error?: string }>(
    (resolve) => {
      const child = spawnProcess(pipxPath, ['install', 'hermes-agent'], {
        env: { ...process.env, ...options.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve({ code: null, timedOut: true })
      }, timeoutMs)

      const onChunk = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
        const text = data.toString()
        log(options, stream, text)
        tail.push(text)
        if (tail.length > 40) tail.shift()
      }

      child.stdout?.on('data', onChunk('stdout'))
      child.stderr?.on('data', onChunk('stderr'))
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ code: null, timedOut: false, error: error.message })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, timedOut: false })
      })
    }
  )

  if (outcome.timedOut) {
    return {
      installId: options.installId,
      ok: false,
      timedOut: true,
      error: `pipx did not finish within ${Math.round(timeoutMs / 60000)} minutes and was stopped.`
    }
  }

  if (outcome.error !== undefined) {
    return { installId: options.installId, ok: false, error: outcome.error }
  }

  if (outcome.code !== 0) {
    const detail = tail.join('').trim().split('\n').slice(-6).join('\n')
    return {
      installId: options.installId,
      ok: false,
      exitCode: outcome.code ?? undefined,
      error: detail.length > 0 ? detail : `pipx exited with code ${String(outcome.code)}.`
    }
  }

  return { installId: options.installId, ok: true, exitCode: 0 }
}
