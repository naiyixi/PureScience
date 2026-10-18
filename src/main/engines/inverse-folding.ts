// Inverse folding: backbone -> sequences, run as a subprocess of a named environment.
//
// Three decisions are worth knowing before reading the code:
//
// 1. The engine is NOT bundled. It needs ~740 MB of torch and a 6.7 MB checkpoint, so the app
//    declares it (see `engine-catalog.ts`) and runs it only if the user has provisioned it. The
//    expected layout is fixed and stated outward by `describeExpectedLayout()`, so "not installed"
//    is a path you can look at rather than a mystery.
// 2. Every failure has its own name. `engine-not-provisioned` (nothing to run), `design-failed`
//    (the engine ran and refused), `invalid-input` (the caller sent something unusable) are three
//    different situations and must never collapse into one.
// 3. The result carries the inputs that determine the output — seed, model, temperature, and the
//    sha256 of both the structure and the checkpoint. That is what makes a design recomputable by
//    someone who does not have this app.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type InverseFoldingLayout = {
  /** Where the engine source tree (with `protein_mpnn_run.py`) must live. */
  engineSrc: string
  /** Where the checkpoint directory (`v_48_020.pt`) must live. */
  weights: string
  /** The interpreter of the named environment that owns torch. */
  envPython: string
}

export type InverseFoldingAvailability = InverseFoldingLayout & {
  installed: boolean
  /** The paths that are missing, so the window can show what to put where. */
  missing: string[]
}

/**
 * The expected layout under the app's data root. Deliberately one function: the window, the docs
 * and this module must not each invent their own convention.
 */
export const resolveInverseFoldingLayout = (dataRoot: string): InverseFoldingLayout => ({
  engineSrc: join(dataRoot, 'runtime', 'engines', 'proteinmpnn'),
  weights: join(dataRoot, 'runtime', 'engines', 'proteinmpnn', 'vanilla_model_weights'),
  envPython: join(dataRoot, 'runtime', 'envs', 'invfold', 'bin', 'python')
})

export const describeExpectedLayout = (layout: InverseFoldingLayout): string => layout.engineSrc

export const checkInverseFolding = (layout: InverseFoldingLayout): InverseFoldingAvailability => {
  const missing: string[] = []
  if (!existsSync(join(layout.engineSrc, 'protein_mpnn_run.py'))) missing.push(layout.engineSrc)
  if (!existsSync(join(layout.weights, 'v_48_020.pt'))) missing.push(layout.weights)
  if (!existsSync(layout.envPython)) missing.push(layout.envPython)
  return { ...layout, installed: missing.length === 0, missing }
}

/**
 * Where the wrapper script lives. Same order as `structure-recognition.ts`: an explicit path wins and
 * is used without an existence check (the caller's declaration, not this module's guess), then the
 * environment override, then the packaged resources, then the development tree.
 */
export const resolveInverseFoldScript = (
  deps: { scriptPath?: string; resourcesPath?: string; env?: NodeJS.ProcessEnv } = {}
): string => {
  if (deps.scriptPath) return deps.scriptPath
  const env = deps.env ?? process.env
  const override = env.PURESCIENCE_INVERSE_FOLD_SCRIPT
  if (override && existsSync(override)) return override
  const resourcesPath = deps.resourcesPath ?? process.resourcesPath
  if (resourcesPath) {
    const packaged = join(resourcesPath, 'engines', 'inverse_fold.py')
    if (existsSync(packaged)) return packaged
  }
  // Development tree: walk up instead of counting `..` segments. The number of levels between this
  // module and the repo root differs between the bundled `out/main` layout and a test runner, and a
  // hard-coded count silently resolves to the wrong directory (measured: `/private/tmp/resources/...`).
  let cursor = __dirname
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(cursor, 'resources', 'engines', 'inverse_fold.py')
    if (existsSync(candidate)) return candidate
    const parent = join(cursor, '..')
    if (parent === cursor) break
    cursor = parent
  }
  return join(__dirname, '../../../resources/engines/inverse_fold.py')
}

export type InverseFoldingRequest = {
  pdbPath: string
  num?: number
  temperature?: number
  seed?: number
  model?: string
}

export type InverseFoldingSample = {
  index: number
  sequence: string
  score?: string | null
  globalScore?: string | null
  sequenceRecovery?: string | null
}

export type InverseFoldingResult = {
  engine: 'proteinmpnn'
  model: string
  seed: number
  temperature: number
  nativeSequence: string
  samples: InverseFoldingSample[]
  weightsSha256: string
  pdbSha256: string
  engineSha256: string
}

/** A refusal with a stable code — the renderer shows `code` and the message, never a guess. */
export class InverseFoldingError extends Error {
  readonly code: 'engine-not-provisioned' | 'design-failed' | 'invalid-input'

  constructor(code: InverseFoldingError['code'], message: string) {
    super(message)
    this.name = 'InverseFoldingError'
    this.code = code
  }
}

export type InverseFoldingRunner = (
  python: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string; code: number }>

const defaultRunner: InverseFoldingRunner = (python, args) =>
  new Promise((resolve) => {
    execFile(
      python,
      args,
      { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code as number)
            : error
              ? 1
              : 0
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code })
      }
    )
  })

const lastJsonLine = (stdout: string): unknown => {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
  const last = lines.at(-1)
  if (!last) return undefined
  try {
    return JSON.parse(last)
  } catch {
    return undefined
  }
}

/**
 * Runs one design. `scriptPath` is passed in rather than derived: development builds and packaged
 * builds resolve `resources/` differently, and that resolution belongs to the caller that already
 * knows where it unpacked things (see `resourcesPath` usage in the notebook runtime).
 */
export const designInverseFolding = async (options: {
  layout: InverseFoldingLayout
  scriptPath: string
  request: InverseFoldingRequest
  run?: InverseFoldingRunner
}): Promise<InverseFoldingResult> => {
  const { layout, scriptPath, request } = options
  if (!request.pdbPath || !request.pdbPath.trim()) {
    throw new InverseFoldingError('invalid-input', 'pdbPath is required')
  }
  const availability = checkInverseFolding(layout)
  if (!availability.installed) {
    throw new InverseFoldingError(
      'engine-not-provisioned',
      `missing: ${availability.missing.join(', ')}`
    )
  }

  const args = [
    scriptPath,
    'design',
    '--pdb',
    request.pdbPath,
    '--out',
    join(layout.engineSrc, '.purescience-out'),
    '--engine-src',
    layout.engineSrc,
    '--weights',
    layout.weights,
    '--num',
    String(request.num ?? 1),
    '--temp',
    String(request.temperature ?? 0.1),
    '--seed',
    String(request.seed ?? 37),
    '--model',
    request.model ?? 'v_48_020'
  ]

  const { stdout, stderr, code } = await (options.run ?? defaultRunner)(layout.envPython, args)
  const parsed = lastJsonLine(stdout) as
    | { status: 'ok'; [key: string]: unknown }
    | { status: 'error'; code?: string; message?: string }
    | undefined

  if (!parsed) {
    throw new InverseFoldingError(
      'design-failed',
      (stderr || stdout).trim().split('\n').at(-1) || `exit ${code} with no JSON`
    )
  }
  if (parsed.status === 'error') {
    // The script's own codes (engine-missing / weights-unreadable / pdb-unreadable) pass through:
    // they are more specific than anything this layer could infer, and mapping them onto one name
    // would hide which of them actually happened.
    throw new InverseFoldingError(
      'design-failed',
      `${parsed.code ?? 'error'}: ${parsed.message ?? ''}`
    )
  }
  if (code !== 0) {
    throw new InverseFoldingError('design-failed', `exit ${code}`)
  }

  const result = parsed as unknown as InverseFoldingResult & { status: string }
  return {
    engine: 'proteinmpnn',
    model: String(result.model),
    seed: Number(result.seed),
    temperature: Number(result.temperature),
    nativeSequence: String(result.nativeSequence),
    samples: Array.isArray(result.samples) ? (result.samples as InverseFoldingSample[]) : [],
    weightsSha256: String(result.weightsSha256),
    pdbSha256: String(result.pdbSha256),
    engineSha256: String(result.engineSha256)
  }
}
