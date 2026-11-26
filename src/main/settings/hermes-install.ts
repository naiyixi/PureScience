import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

import type { ClaudeInstallEvent, ClaudeInstallResult } from '../../shared/settings'

// Where pipx lands on the platforms this app ships on. `~/.local/bin` is pipx's own default bin dir, the
// Homebrew prefixes cover Apple-silicon and Intel macs, and `/usr/local/bin` covers a pip-installed pipx
// on Linux. A bare `pipx` is tried last only after these, because a GUI app inherits launchd's PATH,
// which on macOS does not contain `~/.local/bin` at all.
// pipx is a launcher, not always a plain binary: on Windows it lands as `pipx.exe` or a `.cmd` shim, so the
// candidate names have to be per-platform. The PATH scan at the end covers a Python install whose Scripts
// directory is already on PATH — the case the fixed list cannot know about.
const PIPX_NAMES = process.platform === 'win32' ? ['pipx.exe', 'pipx.cmd', 'pipx.bat'] : ['pipx']

const PIPX_DIRS = (): string[] => {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return [
      join(homedir(), '.local', 'bin'),
      join(appData, 'Python', 'Scripts'),
      join(localAppData, 'Programs', 'pipx', 'bin')
    ]
  }
  return [
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.pyenv', 'shims')
  ]
}

const PIPX_CANDIDATES = (): string[] => {
  const fromDirs = PIPX_DIRS().flatMap((dir) => PIPX_NAMES.map((name) => join(dir, name)))
  const fromPath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir.length > 0)
    .flatMap((dir) => PIPX_NAMES.map((name) => join(dir, name)))
  // De-duplicated and ordered: the well-known install locations first, PATH last, because a GUI app's PATH
  // is whatever the desktop session was given.
  return [...new Set([...fromDirs, ...fromPath])]
}

export const resolvePipxPath = (exists: (path: string) => boolean = existsSync): string | null => {
  return PIPX_CANDIDATES().find((candidate) => exists(candidate)) ?? null
}

export type HermesPipxInstallOptions = {
  installId: string
  onEvent: (event: ClaudeInstallEvent) => void
  // Injected in tests so a fake pipx can be driven without touching the real environment.
  pipxPath?: string | null
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
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

  const outcome = await new Promise<{ code: number | null; timedOut: boolean; error?: string }>(
    (resolve) => {
      // A .cmd/.bat shim is not an executable on Windows — Node must go through a shell to run it.
      const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(pipxPath)

      const child = spawn(needsShell ? `"${pipxPath}"` : pipxPath, ['install', 'hermes-agent'], {
        env: { ...process.env, ...options.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: needsShell
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

  // pipx treats "already installed" as an error (exit 1) and prints `'hermes-agent' already seems to be
  // installed. Not modifying existing installation...`. For a one-click install that must be idempotent:
  // the user's goal is "Hermes is present", not "pipx created a venv right now". The caller re-detects
  // afterwards, so a truly broken existing venv still fails there — with a message about Hermes, not pipx.
  const alreadyInstalled = tail.join('').toLowerCase().includes('already seems to be installed')

  if (outcome.code !== 0 && alreadyInstalled) {
    log(
      options,
      'stdout',
      'pipx: hermes-agent already installed — treating as success and re-detecting.'
    )
    return { installId: options.installId, ok: true, exitCode: outcome.code ?? 0 }
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
