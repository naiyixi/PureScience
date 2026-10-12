// D1（v2.0.0 结构工作台）纯函数层：格式识别、AlphaFold 判别与 pLDDT 配色。
//
// 为什么单独成模块：这三件事都是**可单测的判定**（拍屏或手点验不了它们），而视图组件里混着 3Dmol 的生命周期，
// 判定写在那里就只能靠肉眼。计划书对 D1 的要求是「PDB/mmCIF/AlphaFold 产物加载；表示与配色；相机/焦点」——
// 本模块负责前两项里"认得出是什么"的部分。

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

  // mmCIF 的数据块以 `data_` 开头，且字段行形如 `_atom_site.Cartn_x`
  const head = content.slice(0, 4096)
  if (/^\s*data_/m.test(head) && /_atom_site\./i.test(head)) return 'cif'
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
