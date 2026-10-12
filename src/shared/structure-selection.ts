// D2（v2.0.0 结构工作台）：结构选择的**模型 + 可复算指纹 + 会话上下文块**。
//
// 为什么单独成模块、且必须是无依赖的纯函数：
//  1. 「同一选择复算出同一指纹」是一条**只有单测能钉住**的判定（D3 会把这个指纹带进溯源面板），
//     写进 3D 视图组件里就只能靠肉眼；
//  2. 它同时被**渲染层**（用户在视图中选，构造选择）与**主进程**（把选择注入会话上下文）消费 ⇒
//     两个 tsconfig 都要编译它 ⇒ **不许 import node:crypto**。因此摘要是**调用方给的**
//     （渲染层用 WebCrypto 算内容哈希），本模块只做规范化与指纹组合 ——
//     与 src/shared/search-evidence.ts 头注释那条约束同源。
//
// 指纹配方（第三方可据此复算，别改这里的语义）：
//   structureSelectionComponents(selection) 给出**有序**分量表；把各分量用 NUL 连接后取 32 位 FNV-1a，
//   前缀 `structure-selection:v1-`。分量只包含选择本身的身份（结构 + 内容摘要 + 链 + 区间 + 视图参数），
//   **不含时间** —— 同一选择在任何时刻复算都是同一个值（时间属于「证据记录」，不属于指纹）。

export const STRUCTURE_SELECTION_SCHEMA_VERSION = 1

export type StructureFormatForSelection = 'pdb' | 'cif'

export type StructureSelectionView = {
  /** 表示：cartoon / stick / sphere / surface / line。 */
  style: string
  /** 配色：spectrum / chain / plddt。 */
  colorScheme: string
}

export type StructureSelection = {
  schemaVersion: number
  /** 结构身份：预览项的稳定 id（同一份文件两次打开必须是同一个值）。 */
  structureId: string
  /** 显示名（文件名），进上下文块是为了让人能对上话。 */
  name: string
  format: StructureFormatForSelection
  /**
   * 内容摘要 `sha256:<hex>`；**算不出来时为空串**（块里写 `not-recorded`）。
   * 绝不拿重新序列化的结果冒充原字节的摘要 —— 拿不到就不记。
   */
  contentDigest: string
  chain: string
  residueStart: number
  residueEnd: number
  /** 区间端点的残基名（CYS/GLY…）与插入码：PDB 编号少了插入码会认错残基。 */
  startResidue?: string
  endResidue?: string
  startInsertion?: string
  endInsertion?: string
  view: StructureSelectionView
}

export type StructureSelectionScope = 'residue' | 'range'

const MAX_FIELD = 400

const clip = (value: string): string => value.slice(0, MAX_FIELD)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? clip(trimmed) : undefined
}

const asResidueNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined

/**
 * 单残基还是连续区间 —— 由端点决定，不额外存一个会漂移的字段。
 * **插入码也是身份的一部分**：145 与 145B 是两个残基，编号相同不能当同一个（否则界面会说成
 * 「residue 145」，把用户选中的 145B 说成别的残基）。
 */
export const structureSelectionScope = (selection: StructureSelection): StructureSelectionScope =>
  selection.residueStart === selection.residueEnd &&
  (selection.startInsertion ?? '') === (selection.endInsertion ?? '')
    ? 'residue'
    : 'range'

/** 「chain A residues 145-160」/「chain A residue 145C」——上下文块与界面共用同一句话。 */
export const structureSelectionRangeLabel = (selection: StructureSelection): string => {
  const insert = (code: string | undefined): string => code ?? ''
  if (structureSelectionScope(selection) === 'residue') {
    return `chain ${selection.chain} residue ${selection.residueStart}${insert(
      selection.startInsertion
    )}`
  }
  return `chain ${selection.chain} residues ${selection.residueStart}${insert(
    selection.startInsertion
  )}-${selection.residueEnd}${insert(selection.endInsertion)}`
}

/**
 * 指纹的**有序分量表**（＝可复算的配方）。分量之间不排序：链与区间的位置都带语义。
 * 空/缺失分量写 `not-recorded`，让「没记」与「记了空值」在指纹上也不可混淆。
 */
export const structureSelectionComponents = (selection: StructureSelection): string[] => [
  `structure-selection:v${STRUCTURE_SELECTION_SCHEMA_VERSION}`,
  selection.structureId,
  selection.contentDigest.length > 0 ? selection.contentDigest : 'not-recorded',
  selection.chain,
  `${selection.residueStart}${selection.startInsertion ?? ''}`,
  `${selection.residueEnd}${selection.endInsertion ?? ''}`,
  selection.view.style,
  selection.view.colorScheme
]

// 32 位 FNV-1a，本仓既有的指纹写法（src/shared/task-checkpoint.ts 的 fingerprintInputs 同族）。
// 它只用来「变了就不同」，不是安全边界 —— 内容摘要由调用方给（sha256）。
const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 同一选择 ⇒ 同一指纹；任一分量变了（链 / 区间 / 视图参数 / 内容摘要）⇒ 指纹变。 */
export const structureSelectionFingerprint = (selection: StructureSelection): string =>
  `structure-selection:v${STRUCTURE_SELECTION_SCHEMA_VERSION}-${fnv1a(
    structureSelectionComponents(selection).join('\u0000')
  )}`

/**
 * 主进程侧的**不信输入**规范化：渲染层送来的东西一律重建，缺必填/形状不对就返回 undefined
 * （于是「没有选择」与「选择不合法」都不会被当成一段可注入的上下文）。
 * 端点顺序会被规整（start ≤ end），插入码按端点一起换位，避免区间反向时把两个端点说错。
 */
export const normalizeStructureSelection = (value: unknown): StructureSelection | undefined => {
  if (!isRecord(value)) return undefined

  const structureId = asTrimmedString(value.structureId)
  const name = asTrimmedString(value.name)
  const chain = asTrimmedString(value.chain)
  const format = value.format === 'cif' ? 'cif' : value.format === 'pdb' ? 'pdb' : undefined
  const start = asResidueNumber(value.residueStart)
  const end = asResidueNumber(value.residueEnd)
  const view = isRecord(value.view) ? value.view : undefined
  const style = view ? asTrimmedString(view.style) : undefined
  const colorScheme = view ? asTrimmedString(view.colorScheme) : undefined

  if (!structureId || !name || !chain || !format) return undefined
  if (start === undefined || end === undefined) return undefined
  if (!style || !colorScheme) return undefined

  const reversed = start > end
  const low = reversed ? end : start
  const high = reversed ? start : end
  const startResidue = asTrimmedString(reversed ? value.endResidue : value.startResidue)
  const endResidue = asTrimmedString(reversed ? value.startResidue : value.endResidue)
  const startInsertion = asTrimmedString(reversed ? value.endInsertion : value.startInsertion)
  const endInsertion = asTrimmedString(reversed ? value.startInsertion : value.endInsertion)
  const contentDigest = asTrimmedString(value.contentDigest) ?? ''

  const selection: StructureSelection = {
    schemaVersion: STRUCTURE_SELECTION_SCHEMA_VERSION,
    structureId,
    name,
    format,
    contentDigest,
    chain,
    residueStart: low,
    residueEnd: high,
    view: { style, colorScheme }
  }

  if (startResidue) selection.startResidue = startResidue
  if (endResidue) selection.endResidue = endResidue
  if (startInsertion) selection.startInsertion = startInsertion
  if (endInsertion) selection.endInsertion = endInsertion

  return selection
}

/**
 * 进**会话上下文**的那一块（走 prepared.content，绝不进 request.text）。
 *
 * D2④ 的要求是「上下文里必须带范围、不许用『当前那个结构』这类指代」⇒ 第一句就把这条规则说出来，
 * 载荷里带 `range`（人话）与 `fingerprint`（可复算），让模型有具体范围可引用。
 */
export const buildStructureContextBlock = (selection: StructureSelection): string =>
  [
    '<purescience_structure_context>',
    'The user has a structure open in the viewer and selected a region of it. Answer about that region and refer to it by the chain and residue range given below; do not answer about the structure as a whole, and do not refer to it as "the current structure".',
    JSON.stringify({
      schemaVersion: selection.schemaVersion,
      structureId: selection.structureId,
      name: selection.name,
      format: selection.format,
      contentDigest: selection.contentDigest.length > 0 ? selection.contentDigest : 'not-recorded',
      chain: selection.chain,
      residueStart: selection.residueStart,
      residueEnd: selection.residueEnd,
      ...(selection.startResidue ? { startResidue: selection.startResidue } : {}),
      ...(selection.endResidue ? { endResidue: selection.endResidue } : {}),
      ...(selection.startInsertion ? { startInsertion: selection.startInsertion } : {}),
      ...(selection.endInsertion ? { endInsertion: selection.endInsertion } : {}),
      scope: structureSelectionScope(selection),
      range: structureSelectionRangeLabel(selection),
      view: { style: selection.view.style, colorScheme: selection.view.colorScheme },
      fingerprint: structureSelectionFingerprint(selection)
    }),
    '</purescience_structure_context>'
  ].join('\n')
