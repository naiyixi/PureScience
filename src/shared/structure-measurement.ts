// D3（v2.0.0 结构工作台）：**测量**的模型 + 可复算指纹 + 会话上下文块。
//
// 与 `structure-selection.ts` 分开的理由：选择回答「我选了哪一块」，测量回答「哪几个原子之间有多远/多大角」。
// 把测量硬塞进选择模型只会让两边的字段互相说谎（测量既不是区间也不是集合）。
//
// 与研究纪律一致的三条：
//  1. **量的是哪几个原子要写全**（链 + 编号 + 插入码 + 原子名 + serial）：只写「残基 145 与 160 的距离」
//     是不确定的 —— 同一个残基里不同原子对的距离可以差好几埃；
//  2. 量值**随记录一起走**（不进指纹），指纹只描述「量的是什么」+ 结构身份 + 内容摘要 ⇒ 同一测量复算同一指纹；
//  3. 共享层不 import `node:crypto`（渲染器也编译它）：配方是常量 + 分量表，摘要由调用方给。

export const STRUCTURE_MEASUREMENT_SCHEMA_VERSION = 1

/** 参与测量的一个原子（写全身份，否则「距离」这个词没有确定含义）。 */
export type StructureMeasurementAtom = {
  chain: string
  resi: number
  resiInsertion?: string
  /** 残基名（CYS/GLY…），给人核对用。 */
  resiName?: string
  /** 原子名（SG/CA…）与它在文件里的 serial；两者都可缺，缺了就如实不写。 */
  atomName?: string
  serial?: number
}

export type StructureMeasurementKind = 'distance' | 'angle'

export type StructureMeasurement = {
  schemaVersion: number
  /** 结构身份与内容摘要：与选择同一套身份（同一次打开的结构）。 */
  structureId: string
  name: string
  format: 'pdb' | 'cif'
  contentDigest: string
  kind: StructureMeasurementKind
  /** 距离＝2 个原子；角度＝3 个原子（第 2 个是顶点）。 */
  atoms: StructureMeasurementAtom[]
  /** 距离单位 Å；角度单位 度。**缺失表示还没量出来**（不写 0 冒充）。 */
  value?: number
}

const MAX_FIELD = 400

const clip = (value: string): string => value.slice(0, MAX_FIELD)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? clip(trimmed) : undefined
}

const asInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export const structureMeasurementUnit = (measurement: StructureMeasurement): 'Å' | '°' =>
  measurement.kind === 'distance' ? 'Å' : '°'

/** 该测量需要几个原子（距离 2、角度 3）—— 判定与界面共用这一个来源。 */
export const structureMeasurementAtomCount = (kind: StructureMeasurementKind): number =>
  kind === 'distance' ? 2 : 3

/** 「CYS145.SG — GLY160.CA：3.82 Å」这类一行话；量值缺失时只写量的是什么。 */
export const structureMeasurementLabel = (measurement: StructureMeasurement): string => {
  const atomLabel = (atom: StructureMeasurementAtom): string => {
    const residue = `${atom.resiName ?? '?'}${atom.resi}`
    return atom.atomName ? `${residue}.${atom.atomName}` : residue
  }
  const atoms = measurement.atoms.map(atomLabel).join(measurement.kind === 'angle' ? ' – ' : ' — ')
  if (measurement.value === undefined) return atoms
  return `${atoms}: ${measurement.value} ${structureMeasurementUnit(measurement)}`
}

/**
 * 配方（第三方可据此复算）：**有序**分量表按 NUL 连接后取 32 位 FNV-1a，前缀
 * `structure-measurement:v1-`。分量＝结构身份 + 内容摘要 + 种类 + 每个原子的完整身份。
 * **不含量值与时间**：同一测量（同几个原子、同一份结构内容）在任何时刻、任何机器上复算都是同一个值。
 */
export const structureMeasurementComponents = (measurement: StructureMeasurement): string[] => [
  `structure-measurement:v${STRUCTURE_MEASUREMENT_SCHEMA_VERSION}`,
  measurement.structureId,
  measurement.contentDigest.length > 0 ? measurement.contentDigest : 'not-recorded',
  measurement.kind,
  ...measurement.atoms.map(
    (atom) =>
      `${atom.chain}:${atom.resi}${atom.resiInsertion ?? ''}` +
      `.${atom.atomName ?? 'unnamed'}#${atom.serial ?? 'no-serial'}`
  )
]

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export const structureMeasurementFingerprint = (measurement: StructureMeasurement): string =>
  `structure-measurement:v${STRUCTURE_MEASUREMENT_SCHEMA_VERSION}-${fnv1a(
    structureMeasurementComponents(measurement).join('\u0000')
  )}`

const asMeasurementAtom = (value: unknown): StructureMeasurementAtom | undefined => {
  if (!isRecord(value)) return undefined
  const chain = asTrimmedString(value.chain)
  const resi = asInteger(value.resi)
  if (!chain || resi === undefined) return undefined

  const atom: StructureMeasurementAtom = { chain, resi }
  const resiInsertion = asTrimmedString(value.resiInsertion)
  const resiName = asTrimmedString(value.resiName)
  const atomName = asTrimmedString(value.atomName)
  const serial = asInteger(value.serial)
  if (resiInsertion) atom.resiInsertion = resiInsertion
  if (resiName) atom.resiName = resiName
  if (atomName) atom.atomName = atomName
  if (serial !== undefined) atom.serial = serial
  return atom
}

/**
 * 主进程侧的**不信输入**规范化：原子个数必须与种类相符（距离 2 / 角度 3），
 * 否则整条拒收 —— 少一个原子的「角度」是另一种东西，不能注入。
 */
export const normalizeStructureMeasurement = (value: unknown): StructureMeasurement | undefined => {
  if (!isRecord(value)) return undefined

  const structureId = asTrimmedString(value.structureId)
  const name = asTrimmedString(value.name)
  const format = value.format === 'cif' ? 'cif' : value.format === 'pdb' ? 'pdb' : undefined
  const kind = value.kind === 'distance' ? 'distance' : value.kind === 'angle' ? 'angle' : undefined
  if (!structureId || !name || !format || !kind) return undefined
  if (!Array.isArray(value.atoms)) return undefined

  const atoms = value.atoms.map(asMeasurementAtom)
  if (atoms.some((atom) => atom === undefined)) return undefined
  const resolvedAtoms = atoms.filter((atom): atom is StructureMeasurementAtom => atom !== undefined)
  if (resolvedAtoms.length !== structureMeasurementAtomCount(kind)) return undefined

  const measurement: StructureMeasurement = {
    schemaVersion: STRUCTURE_MEASUREMENT_SCHEMA_VERSION,
    structureId,
    name,
    format,
    contentDigest: asTrimmedString(value.contentDigest) ?? '',
    kind,
    atoms: resolvedAtoms
  }

  // 量值是可选的，但「给了就必须是有限数」——NaN/Infinity 不是测量结果。
  if (value.value !== undefined) {
    const measured = asFiniteNumber(value.value)
    if (measured === undefined) return undefined
    measurement.value = measured
  }

  return measurement
}

/** 进**会话上下文**的那一块（走 prepared.content，绝不进 request.text）。 */
export const buildStructureMeasurementBlock = (measurement: StructureMeasurement): string =>
  [
    '<purescience_structure_measurement>',
    'The user measured a geometry in the structure they have open. Answer about these specific atoms and this distance/angle; do not generalise it to "the current structure".',
    JSON.stringify({
      schemaVersion: measurement.schemaVersion,
      structureId: measurement.structureId,
      name: measurement.name,
      format: measurement.format,
      contentDigest:
        measurement.contentDigest.length > 0 ? measurement.contentDigest : 'not-recorded',
      kind: measurement.kind,
      atoms: measurement.atoms,
      value: measurement.value ?? 'not-measured',
      unit: structureMeasurementUnit(measurement),
      measurement: structureMeasurementLabel(measurement),
      fingerprint: structureMeasurementFingerprint(measurement)
    }),
    '</purescience_structure_measurement>'
  ].join('\n')
