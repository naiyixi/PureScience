/**
 * OCSR（图 → 结构式）的**判定与指纹**：纯函数，不碰模型、不碰网络、不碰磁盘。
 *
 * 红线（与插图理解同源）：**通用描述不许冒充化学结构式**。所以这一路的结果只有两种形态 ——
 *
 * - `agreed`：**至少两台相互独立的引擎**给出同一个（规范化之后的）结构。单引擎的读法再合理也不算高置信，
 *   因为一台 OCSR 引擎对一张模糊位图会给出「看起来很像那么回事」的错误 SMILES；
 * - `refused`：具名说为什么没有结果（没有引擎 / 只有一台 / 两台不一致），并把每台各自说了什么**原样带出**，
 *   让人能自己去看，而不是被一个「空」误导。
 *
 * 指纹算的是**输入**（页、框、渲染 DPI、参与的引擎与它们的版本），不是结果：换 DPI、换框、换引擎版本都会让指纹
 * 变，而任何人只要知道这几样，就能在应用之外把同样的像素与同样的引擎重跑一遍来复算它。
 */
import { createHash } from 'node:crypto'

export type StructureRecognitionEngineName = 'decimer' | 'molscribe'

export type StructureRecognitionReading =
  | {
      engine: StructureRecognitionEngineName
      state: 'read'
      /** 引擎自己的版本串，原样（它决定了这一读法能不能被复算）。 */
      revision: string
      /** 引擎原样给出的结构式。 */
      smiles: string
      /** 规范化后的结构式（用于跨引擎比较）：比较的是化学，不是拼法。 */
      canonical: string
      formula?: string
    }
  | { engine: StructureRecognitionEngineName; state: 'unavailable'; detail: string }
  | { engine: StructureRecognitionEngineName; state: 'failed'; reason: string; detail: string }

/** 高置信的门槛：**两台相互独立**的引擎一致。一台不算，读不出也不算。 */
export const STRUCTURE_RECOGNITION_MIN_ENGINES = 2

export type StructureRecognitionRefusal =
  // 一台引擎都没有（本机没装，或缺依赖）。
  | 'recognizer-unavailable'
  // 只有一台引擎给出了结果 —— 单引擎不足以判高置信。
  | 'recognizer-single-engine'
  // 两台都读了，但规范化之后不是同一个结构。
  | 'recognizer-disagreement'

export type StructureRecognitionOutcome =
  | {
      state: 'agreed'
      canonical: string
      /** 代表性写法：取第一台同意引擎的原样输出（不改写它的拼法）。 */
      smiles: string
      formula?: string
      /** 同意的引擎与它们各自的版本 —— 复算要的就是这两样。 */
      engines: readonly { engine: StructureRecognitionEngineName; revision: string }[]
      /** 每台引擎（含没给出结果的）说了什么，原样。 */
      readings: readonly StructureRecognitionReading[]
    }
  | {
      state: 'refused'
      reason: StructureRecognitionRefusal
      readings: readonly StructureRecognitionReading[]
    }

const readReadings = (
  readings: readonly StructureRecognitionReading[]
): Extract<StructureRecognitionReading, { state: 'read' }>[] =>
  readings.filter(
    (reading): reading is Extract<StructureRecognitionReading, { state: 'read' }> =>
      reading.state === 'read' && reading.canonical.trim() !== ''
  )

export const agreeOnStructure = (
  readings: readonly StructureRecognitionReading[]
): StructureRecognitionOutcome => {
  const readable = readReadings(readings)
  if (readable.length === 0) {
    return { state: 'refused', reason: 'recognizer-unavailable', readings }
  }

  const groups = new Map<string, typeof readable>()
  for (const reading of readable) {
    const group = groups.get(reading.canonical)
    if (group) group.push(reading)
    else groups.set(reading.canonical, [reading])
  }

  const ranked = [...groups.entries()].sort((left, right) => right[1].length - left[1].length)
  const [canonical, agreeing] = ranked[0]
  const needed = STRUCTURE_RECOGNITION_MIN_ENGINES
  // 只有一台引擎读了 ⇒ 「单引擎」是**具名**的拒答，不是「判不出」：它缺的是第二台引擎，不是图像质量。
  if (readable.length < needed) {
    return { state: 'refused', reason: 'recognizer-single-engine', readings }
  }
  // 需要严格多数：两台读数各半时，谁也不能代表这张图。
  const isStrictMajority = agreeing.length > readable.length / 2
  if (agreeing.length < needed || !isStrictMajority) {
    return { state: 'refused', reason: 'recognizer-disagreement', readings }
  }

  const first = agreeing[0]
  return {
    state: 'agreed',
    canonical,
    smiles: first.smiles,
    ...(first.formula === undefined ? {} : { formula: first.formula }),
    engines: agreeing.map((reading) => ({ engine: reading.engine, revision: reading.revision })),
    readings
  }
}

export const STRUCTURE_RECOGNITION_FINGERPRINT_RECIPE = 'purescience/structure-recognition/v1'
export const STRUCTURE_RECOGNITION_FINGERPRINT_PREFIX = 'sha256:'

export type StructureRecognitionFingerprintInput = {
  page: number
  bbox: { x: number; y: number; width: number; height: number }
  /** 渲染用的 DPI：同一页同一个框，换个 DPI 就是另一张图。 */
  dpi: number
  engines: readonly { engine: StructureRecognitionEngineName; revision: string }[]
}

/** 定点写法：浮点在不同语言里的默认格式化不一样，而指纹必须逐字节一致。 */
const fixed = (value: number, digits = 3): string => value.toFixed(digits)

/**
 * 输入的规范串：没有时间戳、没有计数器，只有复算所需要的那几样，且顺序固定（引擎按名字排序）。
 */
export const structureRecognitionRecipe = (input: StructureRecognitionFingerprintInput): string => {
  const engines = [...input.engines]
    .map((engine) => `${engine.engine}@${engine.revision}`)
    .sort()
    .join(',')
  return [
    STRUCTURE_RECOGNITION_FINGERPRINT_RECIPE,
    `page=${input.page}`,
    `bbox=${fixed(input.bbox.x)},${fixed(input.bbox.y)},${fixed(input.bbox.width)},${fixed(input.bbox.height)}`,
    `dpi=${input.dpi}`,
    `engines=${engines}`
  ].join('|')
}

export const structureRecognitionFingerprint = (
  input: StructureRecognitionFingerprintInput
): string =>
  `${STRUCTURE_RECOGNITION_FINGERPRINT_PREFIX}${createHash('sha256')
    .update(structureRecognitionRecipe(input), 'utf8')
    .digest('hex')}`

/** 给人看的一行：结果，或**具名的为什么没有结果**（与证据档同源）。 */
export const describeStructureRecognition = (outcome: StructureRecognitionOutcome): string => {
  if (outcome.state === 'agreed') {
    return `agreed on ${outcome.canonical} by ${outcome.engines
      .map((engine) => `${engine.engine} ${engine.revision}`)
      .join(' + ')}`
  }
  const detail = outcome.readings
    .map((reading) =>
      reading.state === 'read'
        ? `${reading.engine}: ${reading.canonical}`
        : `${reading.engine}: ${reading.state} (${reading.state === 'failed' ? reading.reason : reading.detail})`
    )
    .join('; ')
  return `refused: ${outcome.reason}${detail === '' ? '' : ` — ${detail}`}`
}
