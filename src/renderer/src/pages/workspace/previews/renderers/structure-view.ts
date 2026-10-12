// D1（v2.0.0 结构工作台）纯函数层：格式识别、AlphaFold 判别与 pLDDT 配色。
//
// 为什么单独成模块：这三件事都是**可单测的判定**（拍屏或手点验不了它们），而视图组件里混着 3Dmol 的生命周期，
// 判定写在那里就只能靠肉眼。计划书对 D1 的要求是「PDB/mmCIF/AlphaFold 产物加载；表示与配色；相机/焦点」——
// 本模块负责前两项里"认得出是什么"的部分。

import type {
  StructureMeasurementAtom,
  StructureMeasurementKind
} from '../../../../../../shared/structure-measurement'
import {
  STRUCTURE_SELECTION_SCHEMA_VERSION,
  structureSelectionScope,
  type StructureNeighborhood,
  type StructureResidueRef,
  type StructureSelection
} from '../../../../../../shared/structure-selection'

export type StructureFormat = 'pdb' | 'cif'

const CIF_EXTENSIONS = ['.cif', '.mmcif', '.mcif']

/**
 * 结构文件格式：先看扩展名（最可靠），扩展名不带信息时才看内容首部。
 * 认不出时**回落到 pdb** —— 与改动前的行为一致，不让"认不出"变成一条新的失败路径。
 */
export const detectStructureFormat = (name: string, content: string): StructureFormat => {
  const lower = name.toLowerCase()
  if (CIF_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'cif'
  if (lower.endsWith('.pdb') || lower.endsWith('.ent')) return 'pdb'

  // mmCIF：数据块以 `data_` 开头，字段行形如 `_atom_site.Cartn_x`。
  // **不要只扫首部窗口**：真 RCSB mmCIF 的头部（`_cell.` / `_entity.` / `_struct.` …）很容易超过几 KB，
  // 而 `_atom_site.` 出现在后面的 loop_ 里 —— 实测 1CRN.cif（69,506 B）用 4096 字节窗口会判成 pdb（真机数据抓到的）。
  if (/^\s*data_/m.test(content) && content.includes('_atom_site.')) return 'cif'
  return 'pdb'
}

/**
 * AlphaFold 产物判别：AF- 命名的模型把 **pLDDT 存在 B-factor 列**（0–100，带两位小数），
 * 这是它与其他 PDB 最可靠的区别；仅按文件名判会把用户重命名的文件漏掉，仅按数值判会把
 * B-factor 恰好落在 0–100 的普通结构误判 ⇒ 两条同时成立才算。
 */
export const looksLikeAlphaFoldModel = (name: string, content: string): boolean => {
  const nameLooks = /(^|[/\\])AF[-_]|alphafold/i.test(name)
  let seen = 0
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith('ATOM')) continue
    const raw = line.slice(60, 66).trim()
    if (raw === '') continue
    const value = Number(raw)
    if (!Number.isFinite(value)) return false
    if (value < 0 || value > 100) return false
    // 带小数点是 pLDDT 的典型形状（普通结构 B-factor 多为整数或两位小数但范围不符）
    if (!/^\d+(\.\d+)?$/.test(raw)) return false
    seen += 1
    if (seen >= 20) break
  }
  return nameLooks && seen >= 20
}

export type StructureColorScheme = 'spectrum' | 'chain' | 'plddt'

/** pLDDT 色带（AlphaFold 官方口径的四档），供视图侧直接喂给 3Dmol 的 colorfunc。 */
export const PLDDT_BANDS: { min: number; color: string; label: string }[] = [
  { min: 90, color: '#0053D6', label: 'very high (>90)' },
  { min: 70, color: '#65CBF3', label: 'confident (70-90)' },
  { min: 50, color: '#FFDB13', label: 'low (50-70)' },
  { min: 0, color: '#FF7D45', label: 'very low (<50)' }
]

export const plddtColorFor = (value: number): string =>
  (PLDDT_BANDS.find((band) => value >= band.min) ?? PLDDT_BANDS[PLDDT_BANDS.length - 1]).color

/**
 * 可用的配色：只有 AlphaFold 产物才给 pLDDT —— 对普通结构显示它等于给一个没有含义的颜色。
 * 顺序即界面顺序（默认项由调用方决定）。
 */
export const availableColorSchemes = (isAlphaFold: boolean): StructureColorScheme[] =>
  isAlphaFold ? ['spectrum', 'chain', 'plddt'] : ['spectrum', 'chain']

// ---------------------------------------------------------------------------------------------
// D2：点击 → 选择的**纯函数**层。
//
// 3Dmol 的命中回调住在组件里（要活着的 viewer），但「这次点击意味着选中什么」是可单测的判定 ——
// 判定留在这里，才能被用例钉住（jsdom 里没有 WebGL，组件级点选验不了）。
// ---------------------------------------------------------------------------------------------

export type StructureAtomRef = {
  chain: string
  resi: number
  resn?: string
  icode?: string
}

/** 从 3Dmol 给的 atom 取一个**可命名**的残基引用；没有链号或没有残基号 ⇒ undefined（不猜）。 */
export const toStructureAtomRef = (atom: unknown): StructureAtomRef | undefined => {
  if (typeof atom !== 'object' || atom === null) return undefined
  const candidate = atom as { chain?: unknown; resi?: unknown; resn?: unknown; icode?: unknown }
  const chain = typeof candidate.chain === 'string' ? candidate.chain.trim() : ''
  const resi =
    typeof candidate.resi === 'number' && Number.isInteger(candidate.resi)
      ? candidate.resi
      : undefined
  if (!chain || resi === undefined) return undefined

  const ref: StructureAtomRef = { chain, resi }
  const resn = typeof candidate.resn === 'string' ? candidate.resn.trim() : ''
  const icode = typeof candidate.icode === 'string' ? candidate.icode.trim() : ''
  if (resn) ref.resn = resn
  if (icode) ref.icode = icode
  return ref
}

// 端点按 (残基号, 插入码) 排序；残基名与插入码跟着**自己那一端**走（跨端点交换会把两个端点说错）。
const orderResidueRefs = (
  a: StructureAtomRef,
  b: StructureAtomRef
): { start: StructureAtomRef; end: StructureAtomRef } => {
  if (a.resi !== b.resi) return a.resi < b.resi ? { start: a, end: b } : { start: b, end: a }
  return (a.icode ?? '') <= (b.icode ?? '') ? { start: a, end: b } : { start: b, end: a }
}

/**
 * 点击 → 新的锚点与区间（D2 的选择动作）。
 * - 没有锚点、`extend` 为假、或锚点在**另一条链**上 ⇒ 单残基（跨链区间不是一段连续区间，不编）。
 * - `extend` 为真且同链 ⇒ 从锚点到本次点击的连续区间。
 */
export const resolveStructureSelectionRange = (
  anchor: StructureAtomRef | undefined,
  clicked: StructureAtomRef,
  options: { extend: boolean }
): { start: StructureAtomRef; end: StructureAtomRef; anchor: StructureAtomRef } => {
  if (!options.extend || !anchor || anchor.chain !== clicked.chain) {
    return { start: clicked, end: clicked, anchor: clicked }
  }
  const ordered = orderResidueRefs(anchor, clicked)
  return { ...ordered, anchor: clicked }
}

/**
 * 组一份可上行的选择。端点顺序与残基名的归属在这里**只写一次**（组件与真机 spec 都别再各排一遍）。
 */
export const buildStructureSelection = (input: {
  structureId: string
  name: string
  format: StructureFormat
  contentDigest: string
  start: StructureAtomRef
  end: StructureAtomRef
  view: { style: string; colorScheme: string }
  /** v2 种类：整链与邻域都必须显式说出来（否则会被读成一段区间）。 */
  kind?: 'chain' | 'neighborhood'
  neighborhood?: StructureNeighborhood
  memberResidues?: StructureResidueRef[]
}): StructureSelection => {
  const ordered = orderResidueRefs(input.start, input.end)
  const selection: StructureSelection = {
    schemaVersion: STRUCTURE_SELECTION_SCHEMA_VERSION,
    structureId: input.structureId,
    name: input.name,
    format: input.format,
    contentDigest: input.contentDigest,
    chain: ordered.start.chain,
    residueStart: ordered.start.resi,
    residueEnd: ordered.end.resi,
    view: { style: input.view.style, colorScheme: input.view.colorScheme }
  }
  if (ordered.start.resn) selection.startResidue = ordered.start.resn
  if (ordered.end.resn) selection.endResidue = ordered.end.resn
  if (ordered.start.icode) selection.startInsertion = ordered.start.icode
  if (ordered.end.icode) selection.endInsertion = ordered.end.icode
  if (input.kind) selection.kind = input.kind
  if (input.kind === 'neighborhood' && input.neighborhood && input.memberResidues) {
    selection.neighborhood = input.neighborhood
    selection.memberResidues = input.memberResidues
  }
  return selection
}

/**
 * 测量用的原子：**带坐标与原子名**。
 * 为什么不能只留 {链, 编号}：同一个残基里不同原子对的距离可以差好几埃 —— 只说「145 与 160 的距离」
 * 是一句没有确定含义的话。
 */
export type StructureAtomPick = {
  ref: StructureAtomRef
  x: number
  y: number
  z: number
  atomName?: string
  serial?: number
}

/** 从 3Dmol 的 atom 取一个**可测量**的原子（坐标必须是有限数，否则不量）。 */
export const toStructureAtomPick = (atom: unknown): StructureAtomPick | undefined => {
  const ref = toStructureAtomRef(atom)
  if (!ref) return undefined
  const candidate = atom as {
    x?: unknown
    y?: unknown
    z?: unknown
    atom?: unknown
    serial?: unknown
  }
  const { x, y, z } = candidate
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof z !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z)
  ) {
    return undefined
  }

  const pick: StructureAtomPick = { ref, x, y, z }
  const atomName = typeof candidate.atom === 'string' ? candidate.atom.trim() : ''
  if (atomName) pick.atomName = atomName
  if (typeof candidate.serial === 'number' && Number.isInteger(candidate.serial)) {
    pick.serial = candidate.serial
  }
  return pick
}

const distanceBetween = (a: StructureAtomPick, b: StructureAtomPick): number =>
  Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)

/** 单位：距离 Å、角度 度（顶点是第二个原子）。原子数不符时 undefined —— 不猜一个值出来。 */
export const measureGeometry = (
  kind: StructureMeasurementKind,
  picks: readonly StructureAtomPick[]
): number | undefined => {
  if (kind === 'distance') {
    if (picks.length !== 2) return undefined
    return distanceBetween(picks[0], picks[1])
  }
  if (picks.length !== 3) return undefined

  const [first, vertex, last] = picks
  const toFirst = [first.x - vertex.x, first.y - vertex.y, first.z - vertex.z]
  const toLast = [last.x - vertex.x, last.y - vertex.y, last.z - vertex.z]
  const dot = toFirst[0] * toLast[0] + toFirst[1] * toLast[1] + toFirst[2] * toLast[2]
  const magFirst = Math.hypot(...toFirst)
  const magLast = Math.hypot(...toLast)
  if (magFirst === 0 || magLast === 0) return undefined
  const cosine = Math.min(1, Math.max(-1, dot / (magFirst * magLast)))
  return (Math.acos(cosine) * 180) / Math.PI
}

/** 把拾取的原子变成测量记录里的原子身份（写全：链、编号、插入码、残基名、原子名、serial）。 */
export const toMeasurementAtom = (pick: StructureAtomPick): StructureMeasurementAtom => {
  const atom: StructureMeasurementAtom = { chain: pick.ref.chain, resi: pick.ref.resi }
  if (pick.ref.icode) atom.resiInsertion = pick.ref.icode
  if (pick.ref.resn) atom.resiName = pick.ref.resn
  if (pick.atomName) atom.atomName = pick.atomName
  if (pick.serial !== undefined) atom.serial = pick.serial
  return atom
}

/**
 * 收集 3Dmol 给的原子列表 → 去重的 {链, 编号} 成员表（邻域选择用它落成员）。
 * 认不出身份（没链 / 没编号）的原子**直接丢掉**：编一个残基进去等于伪造选择。
 */
export const collectResidueRefs = (atoms: readonly unknown[]): StructureResidueRef[] => {
  const byKey = new Map<string, StructureResidueRef>()
  for (const atom of atoms) {
    const ref = toStructureAtomRef(atom)
    if (!ref) continue
    byKey.set(`${ref.chain}:${ref.resi}`, { chain: ref.chain, resi: ref.resi })
  }
  return [...byKey.values()].sort((a, b) =>
    a.chain === b.chain ? a.resi - b.resi : a.chain.localeCompare(b.chain)
  )
}

/** 一条链的编号外沿（整链选择用它落端点）；没有该链的原子时 undefined（不猜端点）。 */
export const chainResidueExtent = (
  atoms: readonly unknown[],
  chain: string
): { start: StructureAtomRef; end: StructureAtomRef } | undefined => {
  const onChain = atoms
    .map(toStructureAtomRef)
    .filter((ref): ref is StructureAtomRef => ref !== undefined && ref.chain === chain)
  if (onChain.length === 0) return undefined
  const ordered = onChain.reduce((low, ref) => (ref.resi < low.resi ? ref : low))
  const high = onChain.reduce((top, ref) => (ref.resi > top.resi ? ref : top))
  return { start: ordered, end: high }
}

/**
 * 3Dmol 的高亮选区：**一个选择器一条链**。
 * 为什么是数组而不是单个选择器：邻域的成员可能跨链（配体口袋），而 3Dmol 的一个选择器只能选一条链上的
 * 一段编号或一组编号 —— 拼成一个选择器就等于把别的链的成员丢掉。
 */
export const structureSelectionSelectors = (
  selection: StructureSelection
): { chain: string; resi?: number | `${number}-${number}` | number[] }[] => {
  const scope = structureSelectionScope(selection)

  if (scope === 'neighborhood') {
    const byChain = new Map<string, number[]>()
    for (const member of selection.memberResidues ?? []) {
      byChain.set(member.chain, [...(byChain.get(member.chain) ?? []), member.resi])
    }
    return [...byChain.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([chain, residueNumbers]) => ({
        chain,
        resi: [...residueNumbers].sort((a, b) => a - b)
      }))
  }

  if (scope === 'chain') return [{ chain: selection.chain }]

  return [structureSelectionSelector(selection)]
}

/**
 * 相机一次只能对准一个选择器 ⇒ 聚焦用**包住整个选择的那个区间**（成员跨链时它仍是包含所有成员的外沿）。
 * 高亮照旧逐链精确 —— 两者用途不同，别混用。
 */
export const structureSelectionFocusSelector = (
  selection: StructureSelection
): { chain: string; resi: number | `${number}-${number}` } => ({
  chain: selection.chain,
  resi:
    selection.residueStart === selection.residueEnd
      ? selection.residueStart
      : `${selection.residueStart}-${selection.residueEnd}`
})

/**
 * 3Dmol 的选区：整条链上的一段编号或单个编号（`resi` 两种都收，别自己拼数组）。
 * 类型照 3Dmol 自己的写法收窄成 `` `${number}-${number}` `` —— 写宽成 `string` 会当场被
 * `AtomSelectionSpec` 拒收（TS2345），而 vitest 只转译不做类型检查，只有 tsc 看得见。
 */
export const structureSelectionSelector = (
  selection: StructureSelection
): { chain: string; resi: number | `${number}-${number}` } => {
  const resi: number | `${number}-${number}` =
    selection.residueStart === selection.residueEnd
      ? selection.residueStart
      : `${selection.residueStart}-${selection.residueEnd}`
  return { chain: selection.chain, resi }
}
