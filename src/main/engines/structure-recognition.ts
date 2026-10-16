/**
 * OCSR 的**主进程侧运行器**：把图框渲染成像素 → 交给**每台独立的引擎**去读 → 规范化后比较 → 判高置信或具名拒答。
 *
 * 分工刻意如此：
 * - 真正的活儿（渲染、推理、规范化）在 python 脚本里（`resources/engines/structure_recognition.py`，随包走，
 *   与 `resources/notebook/python_loop.py` 同一套解析规矩），因为栅格化与化学都在 python 生态里；
 * - **判定**在 shared 的纯函数里（`agreeOnStructure`），因为「几台引擎一致才算数」是可测的规矩，不该混进 I/O；
 * - 这里只做两件容易出错、所以必须显式的事：**找到解释器与脚本**，以及**把失败具名**（缺解释器、超时、输出读
 *   不懂、引擎自报不可用，四种都不是同一件事）。
 *
 * 没有静默回退：一台引擎失败就是一台引擎失败，绝不拿另一台的结果冒充它。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  agreeOnStructure,
  structureRecognitionFingerprint,
  type StructureRecognitionEngineName,
  type StructureRecognitionOutcome,
  type StructureRecognitionReading
} from '../../shared/structure-recognition'
import { modelWeightPath } from './model-weight-cache'

/** 产品清单里那条「图 → 结构式」资产的 id：DECIMER 的模型就是它。 */
export const PRODUCT_RECOGNITION_ASSET_ID = 'structure-recognition-primary'

/**
 * 每台引擎默认去哪拿权重：
 * - DECIMER：**产品自己那份已经下载并校验过**的资产（产品的清单条目就是 DECIMER-V2 的 models.zip，
 *   引擎自己的源码里那个 Zenodo 8300489 与产品的 revision 是同一个）；找不到就让引擎按自己的行为走；
 * - MolScribe：它自己的 checkpoint（pip 包不带权重），位置由环境变量给出。
 */
const defaultWeights = (
  deps: StructureRecognitionDeps,
  env: NodeJS.ProcessEnv = process.env
): Partial<Record<StructureRecognitionEngineName, string>> => {
  const weights: Partial<Record<StructureRecognitionEngineName, string>> = {}
  const dataRoot = (deps.dataRoots ?? [])[0]
  if (dataRoot) {
    const asset = modelWeightPath(dataRoot, PRODUCT_RECOGNITION_ASSET_ID)
    if (existsSync(asset)) weights.decimer = asset
  }
  const checkpoint = env.PURESCIENCE_OCSR_MOLSCRIBE_CKPT
  if (checkpoint && existsSync(checkpoint)) weights.molscribe = checkpoint
  return weights
}

/** 支持的两台引擎：互相独立（一台 Transformer+CNN 走 TensorFlow，一台 Swin+分子解码器走 PyTorch）。 */
export const STRUCTURE_RECOGNITION_ENGINES: readonly StructureRecognitionEngineName[] = [
  'decimer',
  'molscribe'
]

export const DEFAULT_RASTER_DPI = 200
export const DEFAULT_ENGINE_TIMEOUT_MS = 180_000

export type StructureRecognitionDeps = {
  /** 引擎脚本；默认：环境变量 → resourcesPath → 开发树（与 notebook 的 loop 脚本同规矩）。 */
  scriptPath?: string
  resourcesPath?: string
  /** app 自有的数据根（调用方给 `resolveDataRoot()`）；引擎解释器从 `<root>/runtime/envs/...` 找。 */
  dataRoots?: readonly string[]
  /** 显式指定某台引擎的解释器（装配点或测试用）。 */
  pythonFor?: Partial<Record<StructureRecognitionEngineName, string>>
  /** 测试缝：跑脚本并拿回它的 JSON。 */
  runJson?: (python: string, args: readonly string[], timeoutMs: number) => Promise<unknown>
  timeoutMs?: number
}

/** 每台引擎解释器所在的 env 名与可执行名（产品自有的命名环境约定）。 */
const ENGINE_ENV: Record<StructureRecognitionEngineName, { env: string; binary: string }> = {
  // DECIMER 带着 TensorFlow，单独一个环境，免得与其它环境的栈打架。
  decimer: { env: 'structure-recognition', binary: 'python' },
  // MolScribe 要 torch<2.0（装不进 default-python 的 torch 2.x），所以也有自己的环境 ——
  // 两台引擎各自独立运行时本来就是更干净的做法。
  molscribe: { env: 'structure-recognition-molscribe', binary: 'python' }
}

const ENV_OVERRIDE: Record<StructureRecognitionEngineName, string> = {
  decimer: 'PURESCIENCE_OCSR_DECIMER_PYTHON',
  molscribe: 'PURESCIENCE_OCSR_MOLSCRIBE_PYTHON'
}

export const resolveStructureRecognitionScript = (
  deps: StructureRecognitionDeps = {},
  env: NodeJS.ProcessEnv = process.env
): string => {
  const override = env.PURESCIENCE_STRUCTURE_RECOGNITION_SCRIPT
  if (override && existsSync(override)) return override
  const resourcesPath = deps.resourcesPath ?? process.resourcesPath
  if (resourcesPath) {
    const packaged = join(resourcesPath, 'engines', 'structure_recognition.py')
    if (existsSync(packaged)) return packaged
    // resources/** ships unpacked, so this also covers a packaged build whose resourcesPath is the asar root.
    const unpacked = join(
      resourcesPath,
      'app.asar.unpacked',
      'resources',
      'engines',
      'structure_recognition.py'
    )
    if (existsSync(unpacked)) return unpacked
  }
  return join(__dirname, '../../../resources/engines/structure_recognition.py')
}

export const resolveEnginePython = (
  engine: StructureRecognitionEngineName,
  deps: StructureRecognitionDeps = {},
  env: NodeJS.ProcessEnv = process.env
): string | undefined => {
  const explicit = deps.pythonFor?.[engine]
  if (explicit && existsSync(explicit)) return explicit
  const override = env[ENV_OVERRIDE[engine]]
  if (override && existsSync(override)) return override
  const binary = ENGINE_ENV[engine]
  for (const root of deps.dataRoots ?? []) {
    const candidate = join(root, 'runtime', 'envs', binary.env, 'bin', binary.binary)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const runJsonWith = async (
  python: string,
  args: readonly string[],
  timeoutMs: number
): Promise<unknown> => {
  return await new Promise((resolve) => {
    execFile(
      python,
      [...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const text = String(stdout ?? '').trim()
        if (error) {
          resolve({
            ok: false,
            reason: 'runner-failed',
            detail: `${(error as { killed?: boolean }).killed ? `no answer within ${timeoutMs}ms` : error.message}${
              String(stderr ?? '').trim() === ''
                ? ''
                : ` :: ${String(stderr).trim().split('\n').slice(-2).join(' ')}`
            }`
          })
          return
        }
        try {
          resolve(JSON.parse(text) as unknown)
        } catch {
          resolve({
            ok: false,
            reason: 'runner-output-unreadable',
            detail: text.slice(0, 200) === '' ? 'no output' : text.slice(0, 200)
          })
        }
      }
    )
  })
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

export type FigureRasterResult = {
  ok: boolean
  pngPath: string
  width: number
  height: number
  detail?: string
}

/**
 * 把图框渲染成 PNG。确定性：同一份 PDF + 同一个框 + 同一个 DPI 得到逐字节相同的图，指纹才可能被复算。
 */
export const rasterizeFigureRegion = async (input: {
  pdfPath: string
  page: number
  bbox: { x: number; y: number; width: number; height: number }
  outPath: string
  dpi?: number
  deps?: StructureRecognitionDeps
}): Promise<FigureRasterResult> => {
  const deps = input.deps ?? {}
  const python = resolveEnginePython('decimer', deps)
  if (!python) {
    return {
      ok: false,
      pngPath: input.outPath,
      width: 0,
      height: 0,
      detail: 'no engine interpreter on this machine'
    }
  }
  const dpi = input.dpi ?? DEFAULT_RASTER_DPI
  const run = deps.runJson ?? runJsonWith
  const raw = asRecord(
    await run(
      python,
      [
        resolveStructureRecognitionScript(deps),
        'rasterize',
        '--pdf',
        input.pdfPath,
        '--page',
        String(input.page),
        '--bbox',
        `${input.bbox.x},${input.bbox.y},${input.bbox.width},${input.bbox.height}`,
        '--dpi',
        String(dpi),
        '--out',
        input.outPath
      ],
      deps.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS
    )
  )
  if (!raw || raw.ok !== true) {
    return {
      ok: false,
      pngPath: input.outPath,
      width: 0,
      height: 0,
      detail: raw
        ? `${asText(raw.reason) || 'rasterize-failed'}: ${asText(raw.detail)}`
        : 'no answer'
    }
  }
  const pixels = asRecord(raw.pixels)
  return {
    ok: true,
    pngPath: input.outPath,
    width: typeof pixels?.width === 'number' ? pixels.width : 0,
    height: typeof pixels?.height === 'number' ? pixels.height : 0
  }
}

/** 一台引擎的一次读法；失败一律**具名**（缺解释器 / 跑不动 / 自报不可用 / 结构式读不懂）。 */
const readWithEngine = async (input: {
  engine: StructureRecognitionEngineName
  pngPath: string
  weightsPath?: string
  deps: StructureRecognitionDeps
}): Promise<StructureRecognitionReading> => {
  const python = resolveEnginePython(input.engine, input.deps)
  if (!python) {
    return {
      engine: input.engine,
      state: 'unavailable',
      detail: 'no interpreter for this engine on this machine'
    }
  }
  const run = input.deps.runJson ?? runJsonWith
  const timeoutMs = input.deps.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS
  const script = resolveStructureRecognitionScript(input.deps)

  const raw = asRecord(
    await run(
      python,
      [
        script,
        'recognize',
        '--engine',
        input.engine,
        '--image',
        input.pngPath,
        ...(input.weightsPath === undefined ? [] : ['--weights', input.weightsPath])
      ],
      timeoutMs
    )
  )
  if (!raw || raw.ok !== true) {
    const reason = raw ? asText(raw.reason) : ''
    const detail = raw ? asText(raw.detail) : 'no answer'
    if (reason === 'engine-unavailable') {
      return { engine: input.engine, state: 'unavailable', detail }
    }
    return { engine: input.engine, state: 'failed', reason: reason || 'runner-failed', detail }
  }

  const smiles = asText(raw.smiles).trim()
  if (smiles === '') {
    return {
      engine: input.engine,
      state: 'failed',
      reason: 'empty-smiles',
      detail: 'the engine answered with an empty structure'
    }
  }
  const revision = asText(raw.revision) || `${input.engine} (version unreported)`

  const canonicalRaw = asRecord(
    await run(python, [script, 'canonicalize', '--smiles', smiles], timeoutMs)
  )
  if (!canonicalRaw || canonicalRaw.ok !== true) {
    // 读出来了但规范化不了：这不是「没读出来」，而是**这一读法无法与别人比较** ⇒ 不算一台可用的读数。
    return {
      engine: input.engine,
      state: 'failed',
      reason: 'unparsable-smiles',
      detail: `${smiles} (${canonicalRaw ? asText(canonicalRaw.detail) : 'no answer'})`
    }
  }
  const canonical = asText(canonicalRaw.canonical).trim()
  if (canonical === '') {
    return { engine: input.engine, state: 'failed', reason: 'unparsable-smiles', detail: smiles }
  }
  const formula = asText(canonicalRaw.formula)
  return {
    engine: input.engine,
    state: 'read',
    revision,
    smiles,
    canonical,
    ...(formula === '' ? {} : { formula })
  }
}

export type FigureStructureRecognition = {
  outcome: StructureRecognitionOutcome
  /** 输入指纹：页 + 框 + DPI + 参与引擎与版本 —— 换任何一样都会变，且可在应用之外复算。 */
  fingerprint: string
  raster: FigureRasterResult
  /** 临时图已清理；这里只留下它当时的像素尺寸，供读者核对渲染是否合理。 */
  rasterPixels: { width: number; height: number }
}

/**
 * 一张图的完整一路：渲染 → 每台引擎各读一次 → 判高置信或具名拒答。**总是不抛**：失败也是一种结果，
 * 它带着名字回到调用方，而不是让一次读图整体崩塌。
 */
export const recognizeFigureStructure = async (input: {
  pdfPath: string
  page: number
  bbox: { x: number; y: number; width: number; height: number }
  dpi?: number
  /** 每台引擎各自的权重路径：DECIMER 用**产品自己那份**校验过的资产；MolScribe 用它的 checkpoint。 */
  weightsFor?: Partial<Record<StructureRecognitionEngineName, string>>
  deps?: StructureRecognitionDeps
}): Promise<FigureStructureRecognition> => {
  const deps = input.deps ?? {}
  const dpi = input.dpi ?? DEFAULT_RASTER_DPI
  const weightsFor = { ...defaultWeights(deps), ...(input.weightsFor ?? {}) }
  const workDir = mkdtempSync(join(tmpdir(), 'ps-ocsr-'))
  const pngPath = join(workDir, 'figure.png')
  try {
    const raster = await rasterizeFigureRegion({
      pdfPath: input.pdfPath,
      page: input.page,
      bbox: input.bbox,
      outPath: pngPath,
      dpi,
      deps
    })
    const readings: StructureRecognitionReading[] = []
    if (raster.ok) {
      for (const engine of STRUCTURE_RECOGNITION_ENGINES) {
        const weights = weightsFor[engine]
        readings.push(
          await readWithEngine({
            engine,
            pngPath,
            ...(weights === undefined ? {} : { weightsPath: weights }),
            deps
          })
        )
      }
    } else {
      for (const engine of STRUCTURE_RECOGNITION_ENGINES) {
        readings.push({
          engine,
          state: 'unavailable',
          detail: `the figure could not be rendered: ${raster.detail ?? 'unknown'}`
        })
      }
    }

    const outcome = agreeOnStructure(readings)
    // 指纹里的引擎取自**实际参与**的那些（含版本），而不是「打算用」的那些。
    const used = readings
      .filter((reading) => reading.state === 'read')
      .map((reading) => ({
        engine: reading.engine,
        revision: (reading as { revision: string }).revision
      }))
    const fingerprint = structureRecognitionFingerprint({
      page: input.page,
      bbox: input.bbox,
      dpi,
      engines: used
    })
    return {
      outcome,
      fingerprint,
      raster,
      rasterPixels: { width: raster.width, height: raster.height }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
