// Molecular dynamics, run as a subprocess of a named environment. Same shape as inverse folding on
// purpose: one layout convention, one set of named refusals, one place that knows how a run is
// identified.
//
// The one thing that differs is what a result can promise. Measured on this engine (GROMACS 2025.4,
// ARM Mac): output differed between runs at 4 threads, at `-nt 1`, and at `-nt 1 -ntomp 1 -dlb no`.
// So this module reports the input fingerprint (recomputable anywhere) plus the quantities two runs
// should agree on (frames, atoms, mean temperature, mean potential) and the digests of *this*
// artifact — never a claim that the bytes can be regenerated.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type MolecularDynamicsLayout = {
  /** The engine binary (`bin/gmx` inside the named environment). */
  gmx: string
}

export type MolecularDynamicsAvailability = MolecularDynamicsLayout & {
  installed: boolean
  missing: string[]
}

export const resolveMolecularDynamicsLayout = (dataRoot: string): MolecularDynamicsLayout => ({
  gmx: join(dataRoot, 'runtime', 'envs', 'md', 'bin', 'gmx')
})

export const checkMolecularDynamics = (
  layout: MolecularDynamicsLayout
): MolecularDynamicsAvailability => {
  const missing = existsSync(layout.gmx) ? [] : [layout.gmx]
  return { ...layout, installed: missing.length === 0, missing }
}

export type MolecularDynamicsRequest = {
  pdbPath: string
  steps?: number
  temperature?: number
  seed?: number
}

export type MolecularDynamicsResult = {
  engine: 'gromacs'
  engineVersion: string
  pdbSha256: string
  steps: number
  temperature: number
  seed: number
  solvent: string
  forceField: string
  waterModel: string
  frames: number | null
  atoms: number | null
  finalStructure: { sha256: string; bytes: number }
  trajectory: { sha256: string; bytes: number }
  statistics: { meanTemperature: number | null; meanPotential: number | null }
  reproducible: { inputFingerprint: boolean; byteIdenticalOutput: boolean; note: string }
}

export class MolecularDynamicsError extends Error {
  readonly code: 'engine-not-provisioned' | 'run-failed' | 'invalid-input'

  constructor(code: MolecularDynamicsError['code'], message: string) {
    super(message)
    this.name = 'MolecularDynamicsError'
    this.code = code
  }
}

export type MolecularDynamicsRunner = (
  python: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string; code: number }>

const defaultRunner: MolecularDynamicsRunner = (python, args) =>
  new Promise((resolve) => {
    // A 10 ps run took ~12 s here; the ceiling is generous because a slower machine is not a failure,
    // and a run that exceeds it is reported as failed with the engine's own last lines.
    execFile(
      python,
      args,
      { timeout: 900_000, maxBuffer: 8 * 1024 * 1024 },
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

/** The wrapper script's own resolution order: explicit, then env override, then packaged, then the tree. */
export const resolveMolecularDynamicsScript = (
  deps: { scriptPath?: string; resourcesPath?: string; env?: NodeJS.ProcessEnv } = {}
): string => {
  if (deps.scriptPath) return deps.scriptPath
  const env = deps.env ?? process.env
  const override = env.PURESCIENCE_MD_SCRIPT
  if (override && existsSync(override)) return override
  const resourcesPath = deps.resourcesPath ?? process.resourcesPath
  if (resourcesPath) {
    const packaged = join(resourcesPath, 'engines', 'md.py')
    if (existsSync(packaged)) return packaged
  }
  let cursor = __dirname
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(cursor, 'resources', 'engines', 'md.py')
    if (existsSync(candidate)) return candidate
    const parent = join(cursor, '..')
    if (parent === cursor) break
    cursor = parent
  }
  return join(__dirname, '../../../resources/engines/md.py')
}

export const runMolecularDynamics = async (options: {
  layout: MolecularDynamicsLayout
  scriptPath: string
  /** Interpreter for the wrapper — it only uses the standard library, so any Python 3 works. */
  python: string
  outDir: string
  request: MolecularDynamicsRequest
  run?: MolecularDynamicsRunner
}): Promise<MolecularDynamicsResult> => {
  const { layout, scriptPath, python, outDir, request } = options
  if (!request.pdbPath || !request.pdbPath.trim()) {
    throw new MolecularDynamicsError('invalid-input', 'pdbPath is required')
  }
  const availability = checkMolecularDynamics(layout)
  if (!availability.installed) {
    throw new MolecularDynamicsError(
      'engine-not-provisioned',
      `missing: ${availability.missing.join(', ')}`
    )
  }

  const args = [
    scriptPath,
    'run',
    '--pdb',
    request.pdbPath,
    '--out',
    outDir,
    '--gmx',
    layout.gmx,
    '--steps',
    String(request.steps ?? 5000),
    '--temperature',
    String(request.temperature ?? 300),
    '--seed',
    String(request.seed ?? 37)
  ]

  const { stdout, stderr, code } = await (options.run ?? defaultRunner)(python, args)
  const parsed = lastJsonLine(stdout) as
    | ({ status: 'ok' } & Record<string, unknown>)
    | { status: 'error'; code?: string; message?: string }
    | undefined

  if (!parsed) {
    throw new MolecularDynamicsError(
      'run-failed',
      (stderr || stdout).trim().split('\n').at(-1) || `exit ${code} with no JSON`
    )
  }
  if (parsed.status === 'error') {
    throw new MolecularDynamicsError(
      'run-failed',
      `${parsed.code ?? 'error'}: ${parsed.message ?? ''}`
    )
  }
  if (code !== 0) {
    throw new MolecularDynamicsError('run-failed', `exit ${code}`)
  }

  const result = parsed as unknown as MolecularDynamicsResult
  return {
    engine: 'gromacs',
    engineVersion: String(result.engineVersion),
    pdbSha256: String(result.pdbSha256),
    steps: Number(result.steps),
    temperature: Number(result.temperature),
    seed: Number(result.seed),
    solvent: String(result.solvent),
    forceField: String(result.forceField),
    waterModel: String(result.waterModel),
    frames: result.frames === null ? null : Number(result.frames),
    atoms: result.atoms === null ? null : Number(result.atoms),
    finalStructure: result.finalStructure,
    trajectory: result.trajectory,
    statistics: result.statistics,
    reproducible: result.reproducible
  }
}
