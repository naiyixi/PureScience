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
//   前缀 `structure-selection:v2-`（v2 在分量表末尾追加了「种类 / 邻域参数 / 成员表」三分量，
//   三者恒定存在、缺失写占位）。分量只包含选择本身的身份（结构 + 内容摘要 + 链 + 区间 + 视图参数 + 这三项），
//   **不含时间** —— 同一选择在任何时刻复算都是同一个值（时间属于「证据记录」，不属于指纹）。

// 配方（分量表）在 v2 增加了「种类 / 邻域参数 / 成员表」三分量 ⇒ **版本号必须跟着动**：
// 同一段选择在 v1 与 v2 下算出不同的值，拿旧值比对新值只会得到「不一致」这种假结论。
export const STRUCTURE_SELECTION_SCHEMA_VERSION = 2

export type StructureFormatForSelection = 'pdb' | 'cif'

export type StructureSelectionView = {
  /** 表示：cartoon / stick / sphere / surface / line。 */
  style: string
  /** 配色：spectrum / chain / plddt。 */
  colorScheme: string
}

/**
 * 选择的**种类**。不写时按端点推导（D2 时期的记录就是这种），写了就以它为准。
 * 为什么必须有这个字段：**整链**与**空间邻域**表达不成一段区间 —— 邻域是一组**不连续**的残基，
 * 用 `residueStart..End` 描述它等于说假话（那是超集），所以它必须自带成员表。
 */
export type StructureSelectionKind = 'residue' | 'range' | 'chain' | 'neighborhood'

/** 一个具体的残基（链 + 编号）—— 邻域成员的最小身份单位。 */
export type StructureResidueRef = {
  chain: string
  resi: number
}

/** 空间邻域：以某段参考区间为中心、半径内的残基集合。 */
export type StructureNeighborhood = {
  /** 半径（Å，> 0）。 */
  radiusAngstrom: number
  /** 参考区间所在的链与端点（就是用户实际选中的那段）。 */
  ofChain: string
  ofStart: number
  ofEnd: number
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
  /** 种类；缺省时由 `structureSelectionScope()` 按端点推导。 */
  kind?: StructureSelectionKind
  /** 仅 `kind: 'neighborhood'`：半径与参考区间。 */
  neighborhood?: StructureNeighborhood
  /**
   * 仅 `kind: 'neighborhood'`：**成员残基表**（按链与编号排序、去重）—— 这才是那次选择本身。
   * 成员带链：配体口袋那类邻域**跨链**，只用编号数组会把别的链说成同一条链。
   * 此时 `residueStart/End` 只是**包住成员的外沿**（用于高亮与相机），不是「用户选了这些」。
   */
  memberResidues?: StructureResidueRef[]
  view: StructureSelectionView
}

export type StructureSelectionScope = StructureSelectionKind

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
export const structureSelectionScope = (selection: StructureSelection): StructureSelectionScope => {
  // 显式种类优先（整链与邻域推不出来）；D2 时期的记录没有 kind，仍按端点推导。
  if (selection.kind) return selection.kind
  return selection.residueStart === selection.residueEnd &&
    (selection.startInsertion ?? '') === (selection.endInsertion ?? '')
    ? 'residue'
    : 'range'
}

/**
 * 「chain A residues 145-160」/「chain A residue 145C」/「chain A (entire chain)」/
 * 「chain A · 12 residues within 5 Å of residues 145-160」——上下文块与界面共用同一句话。
 * **邻域绝不用区间说法**：它的成员是不连续的，用 start-end 描述就是那个超集在说假话。
 */
export const structureSelectionRangeLabel = (selection: StructureSelection): string => {
  const insert = (code: string | undefined): string => code ?? ''
  const scope = structureSelectionScope(selection)

  if (scope === 'chain') return `chain ${selection.chain} (entire chain)`

  if (scope === 'neighborhood') {
    const members = selection.memberResidues ?? []
    const reference = selection.neighborhood
    const of = reference
      ? `${reference.ofStart}${reference.ofStart === reference.ofEnd ? '' : `-${reference.ofEnd}`}`
      : 'the reference region'
    const radius = reference
      ? `${reference.radiusAngstrom} Å of chain ${reference.ofChain} residue ${of}`
      : 'the reference region'
    const chains = [...new Set(members.map((member) => member.chain))].sort()
    const chainNote = chains.length > 1 ? ` (chains ${chains.join(', ')})` : ''
    return `${members.length} residue${
      members.length === 1 ? '' : 's'
    } within ${radius}${chainNote}`
  }

  if (scope === 'residue') {
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
  selection.view.colorScheme,
  // v2 起：种类、邻域参数、成员表。三者**恒定存在**（缺失写占位），分量表才不会有歧义长度。
  selection.kind ?? 'derived',
  selection.neighborhood
    ? `${selection.neighborhood.radiusAngstrom}|${selection.neighborhood.ofChain}|${selection.neighborhood.ofStart}-${selection.neighborhood.ofEnd}`
    : 'no-neighborhood',
  selection.memberResidues && selection.memberResidues.length > 0
    ? selection.memberResidues.map((member) => `${member.chain}:${member.resi}`).join(',')
    : 'no-members'
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
const asSelectionKind = (value: unknown): StructureSelectionKind | undefined =>
  value === 'residue' || value === 'range' || value === 'chain' || value === 'neighborhood'
    ? value
    : undefined

// 成员表的上限只是防呆（防一段被塞满的输入撑爆上下文），不是业务语义。
const MAX_MEMBER_RESIDUES = 20000

const asResidueRef = (value: unknown): StructureResidueRef | undefined => {
  if (!isRecord(value)) return undefined
  const chain = asTrimmedString(value.chain)
  const resi = asResidueNumber(value.resi)
  if (!chain || resi === undefined) return undefined
  return { chain, resi }
}

const asMemberResidues = (value: unknown): StructureResidueRef[] | undefined => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEMBER_RESIDUES) {
    return undefined
  }
  const refs = value.map(asResidueRef)
  if (refs.some((entry) => entry === undefined)) return undefined
  const byKey = new Map<string, StructureResidueRef>()
  for (const entry of refs) {
    if (entry) byKey.set(`${entry.chain}:${entry.resi}`, entry)
  }
  return [...byKey.values()].sort((a, b) =>
    a.chain === b.chain ? a.resi - b.resi : a.chain.localeCompare(b.chain)
  )
}

const asNeighborhood = (value: unknown): StructureNeighborhood | undefined => {
  if (!isRecord(value)) return undefined
  const radiusAngstrom = value.radiusAngstrom
  const ofChain = asTrimmedString(value.ofChain)
  const ofStart = asResidueNumber(value.ofStart)
  const ofEnd = asResidueNumber(value.ofEnd)
  if (
    typeof radiusAngstrom !== 'number' ||
    !Number.isFinite(radiusAngstrom) ||
    radiusAngstrom <= 0
  ) {
    return undefined
  }
  if (!ofChain || ofStart === undefined || ofEnd === undefined) return undefined
  return {
    radiusAngstrom,
    ofChain,
    ofStart: Math.min(ofStart, ofEnd),
    ofEnd: Math.max(ofStart, ofEnd)
  }
}

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

  const kind = asSelectionKind(value.kind)
  const neighborhood = asNeighborhood(value.neighborhood)
  const members = asMemberResidues(value.memberResidues)

  // 成员表三态分开、且都 fail-closed（不做静默丢弃）：
  //   给了但不成形（不是 {chain,resi} 数组）⇒ 整条拒收；
  //   邻域**没有**成员表 ⇒ 等于用外沿冒充选择本身（那个超集）⇒ 拒收；
  //   非邻域却带着成员表 ⇒ 自相矛盾的记录 ⇒ 拒收。
  if (value.memberResidues !== undefined && !members) return undefined
  if (kind === 'neighborhood' && (!neighborhood || !members)) return undefined
  if (kind !== 'neighborhood' && members) return undefined

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
  if (kind) selection.kind = kind
  if (kind === 'neighborhood' && neighborhood && members) {
    selection.neighborhood = neighborhood
    selection.memberResidues = members
  }

  return selection
}

/**
 * 进**会话上下文**的那一块（走 prepared.content，绝不进 request.text）。
 *
 * D2④ 的要求是「上下文里必须带范围、不许用『当前那个结构』这类指代」⇒ 第一句就把这条规则说出来，
 * 载荷里带 `range`（人话）与 `fingerprint`（可复算），让模型有具体范围可引用。
 */
// 说法跟着种类走：邻域与整链都不是「一段区间」，用同一句话会诱导模型把外沿当选择本身。
const structureContextSentence = (selection: StructureSelection): string => {
  switch (structureSelectionScope(selection)) {
    case 'chain':
      return 'The user has a structure open in the viewer and selected an ENTIRE chain of it. Answer about that chain; do not answer about the whole structure, and do not refer to it as "the current structure".'
    case 'neighborhood':
      return 'The user has a structure open in the viewer and selected every residue within a radius of a reference region. Those residues are listed explicitly in memberResidues below and they are NOT a contiguous range — the residueStart/residueEnd fields are only the outer bounds. Answer about the listed residues, refer to them by the member list, and do not refer to it as "the current structure".'
    default:
      return 'The user has a structure open in the viewer and selected a region of it. Answer about that region and refer to it by the chain and residue range given below; do not answer about the structure as a whole, and do not refer to it as "the current structure".'
  }
}

export const buildStructureContextBlock = (selection: StructureSelection): string =>
  [
    '<purescience_structure_context>',
    structureContextSentence(selection),
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
      ...(selection.kind ? { kind: selection.kind } : {}),
      ...(selection.neighborhood ? { neighborhood: selection.neighborhood } : {}),
      ...(selection.memberResidues
        ? {
            memberResidueCount: selection.memberResidues.length,
            memberResidues: selection.memberResidues
          }
        : {}),
      scope: structureSelectionScope(selection),
      range: structureSelectionRangeLabel(selection),
      view: { style: selection.view.style, colorScheme: selection.view.colorScheme },
      fingerprint: structureSelectionFingerprint(selection)
    }),
    '</purescience_structure_context>'
  ].join('\n')
