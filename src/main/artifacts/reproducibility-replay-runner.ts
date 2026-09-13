import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolated replay of a sealed recipe.
//
// The runner is deliberately the only place in the app that executes a recorded script again, and it
// stays inside three rules: it never runs anything the recipe did not capture (no shell, no package
// installation, no environment bootstrap), it stages the recorded inputs checksum-verified before the
// interpreter starts, and it grades only the files the recipe says to expect. Anything that cannot be
// honoured is reported as a refusal, never silently skipped.
//
// Process spawning is injected so the whole flow is testable without a real interpreter and behaves
// identically on every platform.

export type ReplayStageRefusal =
  | 'unsafe-filename'
  | 'input-missing'
  | 'input-size-mismatch'
  | 'input-checksum-mismatch'
  | 'interpreter-missing'
  | 'workdir-unavailable'
  | 'replay-not-configured'

export type ReplayInputSource = {
  filename: string
  sha256: string
  sizeBytes: number
  // Absolute path of the recorded input's content in this installation.
  path: string
}

export type ReplayObservedOutput = {
  filename: string
  sizeBytes: number
  sha256: string
}

export type ReplayProcessResult = {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

export type ReplaySpawnRequest = {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  timeoutMs: number
}

export type ReplayRunOptions = {
  kernelKind: 'python' | 'r'
  scripts: string[]
  interpreterPath: string
  expectedOutputFilenames: string[]
  inputs: ReplayInputSource[]
  spawnProcess?: (request: ReplaySpawnRequest) => Promise<ReplayProcessResult>
  timeoutMs?: number
  keepWorkDir?: boolean
}

export type ReplayRunResult = {
  state: 'refused' | 'completed' | 'failed' | 'timed-out'
  refusal?: ReplayStageRefusal
  // Always present, so a failure can be read without guessing what happened.
  detail: string
  exitCode?: number | null
  outputs: ReplayObservedOutput[]
  missingOutputs: string[]
  stdoutTail: string
  stderrTail: string
}

export const REPLAY_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const OUTPUT_TAIL_CHARS = 4 * 1024
const SCRIPTS = { python: 'replay.py', r: 'replay.R' } as const

const sha256File = async (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })

const isSafeFilename = (value: string): boolean =>
  value.length > 0 &&
  !value.includes('/') &&
  !value.includes('\\') &&
  value !== '.' &&
  value !== '..'

const tail = (value: string): string =>
  value.length > OUTPUT_TAIL_CHARS ? value.slice(value.length - OUTPUT_TAIL_CHARS) : value

const defaultSpawnProcess = async ({
  command,
  args,
  cwd,
  env,
  timeoutMs
}: ReplaySpawnRequest): Promise<ReplayProcessResult> => {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = tail(stdout + chunk.toString('utf8'))
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = tail(stderr + chunk.toString('utf8'))
  })

  return new Promise<ReplayProcessResult>((resolve) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ exitCode: null, timedOut, stdout, stderr: `${stderr}${String(error)}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, timedOut, stdout, stderr })
    })
  })
}

// The interpreter environment: the recipe never gets to install anything, so the replay inherits only
// what running a plot script needs (a PATH, a home for caches, and a headless matplotlib backend so an
// unrunnable GUI backend cannot masquerade as a reproduction failure).
export const replayEnvironment = (
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> => {
  const env: Record<string, string> = {
    MPLBACKEND: 'Agg',
    PYTHONUNBUFFERED: '1',
    PYTHONNOUSERSITE: '1'
  }
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'R_HOME', 'R_LIBS_USER']) {
    const value = source[key]
    if (value) env[key] = value
  }

  return env
}

const observeOutput = async (
  workDir: string,
  filename: string
): Promise<ReplayObservedOutput | undefined> => {
  const path = join(workDir, filename)
  try {
    const info = await stat(path)
    if (!info.isFile()) return undefined

    return { filename, sizeBytes: info.size, sha256: await sha256File(path) }
  } catch {
    return undefined
  }
}

export const runSealedRecipeReplay = async ({
  kernelKind,
  scripts,
  interpreterPath,
  expectedOutputFilenames,
  inputs,
  spawnProcess = defaultSpawnProcess,
  timeoutMs = REPLAY_DEFAULT_TIMEOUT_MS,
  keepWorkDir = false
}: ReplayRunOptions): Promise<ReplayRunResult> => {
  const refuse = (refusal: ReplayStageRefusal, detail: string): ReplayRunResult => ({
    state: 'refused',
    refusal,
    detail,
    outputs: [],
    missingOutputs: [],
    stdoutTail: '',
    stderrTail: ''
  })

  if (
    inputs.some((input) => !isSafeFilename(input.filename)) ||
    expectedOutputFilenames.some((filename) => !isSafeFilename(filename))
  ) {
    return refuse(
      'unsafe-filename',
      'A recorded input or expected output name is not a plain file name, so the replay was refused.'
    )
  }

  let workDir: string
  try {
    workDir = await mkdtemp(join(tmpdir(), 'purescience-replay-'))
  } catch (error) {
    return refuse('workdir-unavailable', error instanceof Error ? error.message : String(error))
  }

  try {
    // Stage the recorded inputs first: an interpreter must never start against a missing or mutated
    // input, because the resulting comparison would blame the recipe instead of the missing evidence.
    for (const input of inputs) {
      let sizeBytes: number
      try {
        sizeBytes = (await stat(input.path)).size
      } catch {
        return refuse('input-missing', `Recorded input content is gone: ${input.filename}`)
      }
      if (sizeBytes !== input.sizeBytes) {
        return refuse(
          'input-size-mismatch',
          `Recorded input ${input.filename} is ${sizeBytes} bytes, expected ${input.sizeBytes}.`
        )
      }

      const staged = join(workDir, input.filename)
      try {
        await copyFile(input.path, staged)
      } catch (error) {
        return refuse('input-missing', error instanceof Error ? error.message : String(error))
      }
      if ((await sha256File(staged)) !== input.sha256) {
        return refuse(
          'input-checksum-mismatch',
          `Recorded input ${input.filename} no longer matches its recorded checksum.`
        )
      }
    }

    const scriptName = SCRIPTS[kernelKind]
    await writeFile(join(workDir, scriptName), `${scripts.join('\n\n')}\n`, 'utf8')

    const run = await spawnProcess({
      command: interpreterPath,
      args: [scriptName],
      cwd: workDir,
      env: replayEnvironment(),
      timeoutMs
    })

    const outputs: ReplayObservedOutput[] = []
    const missingOutputs: string[] = []
    for (const filename of expectedOutputFilenames) {
      const observed = await observeOutput(workDir, filename)
      if (observed) outputs.push(observed)
      else missingOutputs.push(filename)
    }

    return {
      state: run.timedOut ? 'timed-out' : run.exitCode === 0 ? 'completed' : 'failed',
      exitCode: run.exitCode,
      detail: run.timedOut
        ? `The replay exceeded ${timeoutMs} ms and was stopped.`
        : `The replay exited with code ${run.exitCode ?? 'null'}.`,
      outputs,
      missingOutputs,
      stdoutTail: run.stdout,
      stderrTail: run.stderr
    }
  } finally {
    if (!keepWorkDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
