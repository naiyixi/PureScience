// D1（v2.0.0 结构工作台）纯函数层：格式识别、AlphaFold 判别与 pLDDT 配色。
//
// 为什么单独成模块：这三件事都是**可单测的判定**（拍屏或手点验不了它们），而视图组件里混着 3Dmol 的生命周期，
// 判定写在那里就只能靠肉眼。计划书对 D1 的要求是「PDB/mmCIF/AlphaFold 产物加载；表示与配色；相机/焦点」——
// 本模块负责前两项里"认得出是什么"的部分。

import {
  STRUCTURE_SELECTION_SCHEMA_VERSION,
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
  return selection
}

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
