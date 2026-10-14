import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// E3-2, third piece: RUN ONCE — the only place in this batch that executes code the user downloaded.
//
// Four properties, and each one is a rule rather than a preference:
//  1. no shell: the command is spawned as a program plus arguments, so nothing a repository contains can be
//     read as a shell word;
//  2. its own empty working directory: the plugin runs somewhere it owns, not inside the app's tree;
//  3. a whitelisted environment: no inherited credentials, no proxy variables — what the child sees is what
//     is written here, plus PATH so an interpreter can be found;
//  4. a timeout: a run that never finishes is a run that is killed and reported as such.

export type PluginRunResult =
  | {
      state: 'ran'
      command: string
      exitCode: number | null
      signal: string | null
      timedOut: boolean
      stdout: string
      stderr: string
      durationMs: number
    }
  | { state: 'refused'; reason: 'entry-missing' | 'runtime-unsupported'; detail: string }

const INTERPRETERS: Record<string, { command: string; argv: (entry: string) => string[] }> = {
  node: { command: 'node', argv: (entry) => [entry] },
  python: { command: 'python3', argv: (entry) => [entry] }
}

const MAX_CAPTURED = 16 * 1024

export const runPluginOnce = async (input: {
  /** The deployed plugin directory, the entry to run, the runtime it declared. */
  directory: string
  entry: string
  runtimeKind: string
  /** A budget in milliseconds; a run that exceeds it is killed and reported as timed out. */
  timeoutMs?: number
  /** Injected so a test drives this without spawning anything. */
  spawnImpl?: typeof spawn
}): Promise<PluginRunResult> => {
  const interpreter = INTERPRETERS[input.runtimeKind]
  if (!interpreter) {
    return {
      state: 'refused',
      reason: 'runtime-unsupported',
      detail: `No interpreter is registered for runtime "${input.runtimeKind}".`
    }
  }

  const entryPath = join(input.directory, input.entry)
  const { access } = await import('node:fs/promises')
  const present = await access(entryPath).then(
    () => true,
    () => false
  )
  if (!present) {
    return {
      state: 'refused',
      reason: 'entry-missing',
      detail: `The deployed plugin does not hold ${input.entry}.`
    }
  }

  const workingDirectory = await mkdtemp(join(tmpdir(), 'plugin-run-'))
  const timeoutMs = input.timeoutMs ?? 20_000
  const spawnImpl = input.spawnImpl ?? spawn
  const startedAt = Date.now()

  return await new Promise<PluginRunResult>((resolve) => {
    const child = spawnImpl(interpreter.command, interpreter.argv(entryPath), {
      cwd: workingDirectory,
      // No shell, and an environment that is written here rather than inherited.
      shell: false,
      env: { PATH: process.env.PATH ?? '', HOME: workingDirectory, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURED) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURED) stderr += chunk.toString('utf8')
    })

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const timedOut = Date.now() - startedAt >= timeoutMs && exitCode === null
      void rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined)
      resolve({
        state: 'ran',
        command: `${interpreter.command} ${input.entry}`,
        exitCode,
        signal,
        timedOut,
        stdout: stdout.slice(0, MAX_CAPTURED),
        stderr: stderr.slice(0, MAX_CAPTURED),
        durationMs: Date.now() - startedAt
      })
    }

    child.on('error', (error: Error) => {
      // A spawn that never started is reported through the same shape, with the error as stderr: a reader
      // should not have to know which failure mode they hit to find out what happened.
      stderr = `${stderr}${error.message}`
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}
