// D5（v2.0.0 结构工作台）：**中文口语 → 选择/测量意图**的纯函数层。
//
// 为什么单独成模块、且是纯函数：
//  1. 判据是「一句中文 → 选区正确」，而「哪句中文被解析成什么」只有单测能逐个钉住（界面上点不出来）；
//  2. 口语解析最容易犯的错是**猜**：猜链、猜残基号、猜单位。本模块的原则是**解析不出来就具名拒绝**，
//     并把「拒绝原因」当成返回值的一部分（界面据此上屏，而不是静默什么都不发生）。
//
// 与中文术语归一的关系：这里**不重写**任何术语表，只用 `chinese-terms.ts` 已有的 `normaliseQueryPunctuation`
// 统一标点（全角/半角、中文顿号等），避免各写一套。残基名走本模块自己的小表（20 种标准氨基酸），
// 表里没有的名字**具名拒绝**，不回落到"当作某个残基"。

import { normaliseQueryPunctuation } from './chinese-terms'
import type { StructureSelectionKind } from './structure-selection'

/** 本模块能产出的意图种类（残基/区间/整链/半径邻域）。 */
export type StructureInstructionKind = Extract<
  StructureSelectionKind,
  'residue' | 'range' | 'chain' | 'neighborhood'
>

/** 具名拒绝：解析不出来时**必须**说清是哪一种，不许静默变成"没有动作"。 */
export const STRUCTURE_INSTRUCTION_REFUSALS = [
  /** 一句话里没有任何可用的选择信息（没有残基、没有链、没有半径）。 */
  'no-selection-expressed',
  /** 说了残基名，但不在本模块的表里（不猜 CYS）。 */
  'unknown-residue-name',
  /** 说了半径但没说要围绕什么（邻域缺参考）。 */
  'neighborhood-without-reference',
  /** 半径数值不是有限正数。 */
  'invalid-radius',
  /** 同时给出了互相矛盾的形状（例如既是整链又给了区间端点）。 */
  'conflicting-shape',
  /** 句子里有好几个编号、又没有区间连接词或残基名把它们分开 ⇒ 不猜是哪一个。 */
  'ambiguous-residue-number'
] as const

export type StructureInstructionRefusal = (typeof STRUCTURE_INSTRUCTION_REFUSALS)[number]

export type StructureInstructionRefusalResult = {
  ok: false
  reason: StructureInstructionRefusal
  /** 给界面用的一句话（中文，因为输入就是中文；界面不再二次拼装原因）。 */
  detail: string
}

export type StructureResidueSelector = {
  chain?: string
  residueStart: number
  residueEnd: number
}

export type StructureInstruction =
  | { ok: true; kind: 'residue' | 'range'; residue: StructureResidueSelector; residueName?: string }
  | { ok: true; kind: 'chain'; chain?: string }
  | {
      ok: true
      kind: 'neighborhood'
      radiusAngstrom: number
      reference: StructureResidueSelector
      residueName?: string
    }

export type StructureInstructionResult = StructureInstruction | StructureInstructionRefusalResult

// 20 种标准氨基酸的中文名（简体/繁体）、三字母与单字母。**表里没有的具名拒绝**，不做模糊匹配。
const RESIDUE_NAMES: ReadonlyArray<{
  code: string
  one: string
  zh: readonly string[]
  zhHant?: readonly string[]
}> = [
  { code: 'ALA', one: 'A', zh: ['丙氨酸'] },
  { code: 'ARG', one: 'R', zh: ['精氨酸'] },
  { code: 'ASN', one: 'N', zh: ['天冬酰胺', '天门冬酰胺'] },
  { code: 'ASP', one: 'D', zh: ['天冬氨酸', '天门冬氨酸'] },
  { code: 'CYS', one: 'C', zh: ['半胱氨酸'] },
  { code: 'GLN', one: 'Q', zh: ['谷氨酰胺', '麩氨酰胺'] },
  { code: 'GLU', one: 'E', zh: ['谷氨酸', '麩氨酸'] },
  { code: 'GLY', one: 'G', zh: ['甘氨酸'] },
  { code: 'HIS', one: 'H', zh: ['组氨酸'] },
  { code: 'ILE', one: 'I', zh: ['异亮氨酸'] },
  { code: 'LEU', one: 'L', zh: ['亮氨酸'] },
  { code: 'LYS', one: 'K', zh: ['赖氨酸'] },
  { code: 'MET', one: 'M', zh: ['甲硫氨酸', '蛋氨酸'] },
  { code: 'PHE', one: 'F', zh: ['苯丙氨酸'] },
  { code: 'PRO', one: 'P', zh: ['脯氨酸'] },
  { code: 'SER', one: 'S', zh: ['丝氨酸'] },
  { code: 'THR', one: 'T', zh: ['苏氨酸'] },
  { code: 'TRP', one: 'W', zh: ['色氨酸'] },
  { code: 'TYR', one: 'Y', zh: ['酪氨酸'] },
  { code: 'VAL', one: 'V', zh: ['缬氨酸'] }
]

/** 中文名 / 三字母 / 单字母 → PDB 三字母码；不认识返回 undefined（**不猜**）。 */
export const resolveResidueCode = (token: string): string | undefined => {
  const trimmed = token.trim()
  if (!trimmed) return undefined

  const upper = trimmed.toUpperCase()
  const byCode = RESIDUE_NAMES.find((entry) => entry.code === upper || entry.one === upper)
  if (byCode) return byCode.code

  // 单字母只在**单独成词**时才算（避免把「A 链」里的 A 读成丙氨酸）。
  return RESIDUE_NAMES.find((entry) => entry.zh.includes(trimmed))?.code
}

/** 三字母码 → 中文名（界面回显用；找不到就回显原码）。 */
export const residueCodeForDisplay = (code: string): string =>
  RESIDUE_NAMES.find((entry) => entry.code === code)?.zh[0] ?? code

const CHAIN_PATTERN = /(?:链\s*([A-Za-z])|([A-Za-z])\s*链)/
const RADIUS_PATTERN = /(\d+(?:\.\d+)?)\s*(?:埃|Å|å|angstrom|A\b)/i
const RANGE_PATTERN = /(\d+)\s*(?:-|–|到|至|~)\s*(\d+)/
const CHAIN_WIDE_PATTERN = /(整条链|整链|全链|整條鏈|整鏈)/

// 「像氨基酸名但不在表里」的形状：以 氨酸/胺酸 结尾的词。用它而不是"任意一段中文"，
// 否则「看一下这个结构」这种没有残基的句子会被误报成"不认识该残基名"。
const UNKNOWN_RESIDUE_PATTERN = /[\u4e00-\u9fa5]{1,6}(?:氨酸|胺酸|酰胺)/

// 可以贴着残基名的**助词**：中文里名字与编号靠它们相接（「145 号半胱氨酸」「把 A 链的…」）。
// 除了这些，名字两侧必须是边界 —— 否则「硒代半胱氨酸」会被读成「半胱氨酸」（CYS），那是**猜**。
const NAME_BOUNDARY_PARTICLES = new Set([
  '号',
  '號',
  '的',
  '在',
  '到',
  '至',
  '把',
  '和',
  '与',
  '及',
  '取',
  '选',
  '選',
  '边',
  '邊',
  '上',
  '：',
  ':',
  '，',
  ',',
  '。',
  '、',
  ' '
])

const isNameBoundary = (character: string): boolean =>
  character === '' || !/[\u4e00-\u9fa5]/.test(character) || NAME_BOUNDARY_PARTICLES.has(character)

const findResidueName = (text: string): { code: string; index: number } | undefined => {
  const candidates: { code: string; index: number }[] = []

  for (const entry of RESIDUE_NAMES) {
    for (const name of entry.zh) {
      const index = text.indexOf(name)
      if (index < 0) continue
      if (
        !isNameBoundary(text[index - 1] ?? '') ||
        !isNameBoundary(text[index + name.length] ?? '')
      ) {
        continue
      }
      candidates.push({ code: entry.code, index })
    }

    const codeMatch = new RegExp(`(^|[^A-Za-z])${entry.code}(?![A-Za-z])`, 'i').exec(text)
    if (codeMatch) {
      candidates.push({ code: entry.code, index: (codeMatch.index ?? 0) + codeMatch[1].length })
    }

    // 单字母只认**单独成词**的，且**不紧邻「链」**——「A 链」里的 A 是链名，不是丙氨酸。
    const onePattern = new RegExp(`(^|[^A-Za-z])${entry.one}(?![A-Za-z])`, 'g')
    for (const match of text.matchAll(onePattern)) {
      const index = (match.index ?? 0) + match[1].length
      const around = text.slice(Math.max(0, index - 2), index + 3)
      if (around.includes('链')) continue
      candidates.push({ code: entry.code, index })
    }
  }

  return candidates.sort((a, b) => a.index - b.index)[0]
}

const hasUnknownResidueName = (text: string): boolean => UNKNOWN_RESIDUE_PATTERN.test(text)

const refusal = (
  reason: StructureInstructionRefusal,
  detail: string
): StructureInstructionRefusalResult => ({ ok: false, reason, detail })

/**
 * 解析一句中文，产出**选择意图**或**具名拒绝**。
 *
 * 支持的形状（都来自真实说法，用例逐条钉）：
 *   - 「145 号半胱氨酸」「半胱氨酸 145」「CYS145」「Cys 145」
 *   - 「A 链 145 到 160」「链 A 的 145-160 残基」
 *   - 「整条链」「A 链整链」
 *   - 「145 号半胱氨酸 5 埃以内的残基」「半径 5 埃，围绕 145 号半胱氨酸」
 */
export const parseStructureInstruction = (raw: string): StructureInstructionResult => {
  // 标点先归一到半角（复用既有那一条，不另写一套）。
  const text = normaliseQueryPunctuation(raw ?? '').trim()
  if (!text) return refusal('no-selection-expressed', '没有听到任何选择信息。')

  // 半径数值**先摘出来**再从文本里去掉：否则「5 埃以内」会被残基正则读成「残基 5 名埃以内」
  // （实测踩到：半径数字被当成残基编号，于是整句被判成"不认识这个残基名"）。
  const radiusMatch = text.match(RADIUS_PATTERN)
  const radius = radiusMatch ? Number(radiusMatch[1]) : undefined
  if (radius !== undefined && (!Number.isFinite(radius) || radius <= 0)) {
    return refusal('invalid-radius', `半径「${radiusMatch?.[1]}」不是正数。`)
  }
  const withoutRadius = radiusMatch ? text.replace(radiusMatch[0], ' ') : text

  const chainMatch = withoutRadius.match(CHAIN_PATTERN)
  const chain = chainMatch?.[1] ?? chainMatch?.[2]
  const chainWide = CHAIN_WIDE_PATTERN.test(withoutRadius)

  // 残基名靠**已知名字**锚定，而不是"取一段中文当名字"：后者会把 半径/残基/号 这些指令词
  // 吃成残基名（实测踩到：「残基 20 半径 8 埃」里的「半径」被当成残基名 ⇒ 整句变成"不认识该残基"）。
  const named = findResidueName(withoutRadius)
  const residueName: string | undefined = named?.code
  let residueStart: number | undefined
  let residueEnd: number | undefined

  // 说了个"像氨基酸名但表里没有"的词 ⇒ **先拒**（不因为它旁边恰好有个编号就把它当编号处理）：
  // 用户明明在指名一个残基，而我们不能确定那是哪个。
  if (!named && hasUnknownResidueName(withoutRadius)) {
    const unknown = withoutRadius.match(UNKNOWN_RESIDUE_PATTERN)?.[0] ?? ''
    return refusal(
      'unknown-residue-name',
      `残基名「${unknown}」不在本模块的 20 种标准氨基酸表里，无法确定是哪个残基。`
    )
  }

  const rangeMatch = withoutRadius.match(RANGE_PATTERN)
  const numbers = [...withoutRadius.matchAll(/\d+/g)].map((match) => ({
    value: Number(match[0]),
    index: match.index ?? 0
  }))

  if (rangeMatch) {
    residueStart = Number(rangeMatch[1])
    residueEnd = Number(rangeMatch[2])
  } else if (numbers.length === 1) {
    residueStart = numbers[0].value
    residueEnd = numbers[0].value
  } else if (numbers.length > 1 && named) {
    // 有名字就把**离名字最近**的那个编号当成残基号（「链 A 残基 20 半径 8」这种句子里半径已被摘掉）。
    const nearest = numbers.reduce((best, entry) =>
      Math.abs(entry.index - named.index) < Math.abs(best.index - named.index) ? entry : best
    )
    residueStart = nearest.value
    residueEnd = nearest.value
  } else if (numbers.length > 1) {
    return refusal(
      'ambiguous-residue-number',
      `这句话里出现了 ${numbers.length} 个编号又没说哪段区间，无法确定你要的是哪一个。`
    )
  }

  // 半径邻域：**必须**有半径数值才算（只说「附近/以内」而没给数字，不是一条半径指令，
  // 让它落到后面的普通解析；最后什么都没有时给 no-selection-expressed）。
  if (radius !== undefined) {
    if (residueStart === undefined) {
      return refusal('neighborhood-without-reference', '说了半径，但没说围绕哪个残基。')
    }
    return {
      ok: true,
      kind: 'neighborhood',
      radiusAngstrom: radius,
      reference: {
        ...(chain ? { chain } : {}),
        residueStart,
        residueEnd: residueEnd ?? residueStart
      },
      ...(residueName ? { residueName } : {})
    }
  }

  if (residueStart !== undefined && residueEnd !== undefined && residueStart !== residueEnd) {
    if (chainWide) return refusal('conflicting-shape', '同时说了「整条链」和一段编号区间。')
    return {
      ok: true,
      kind: 'range',
      residue: { ...(chain ? { chain } : {}), residueStart, residueEnd },
      ...(residueName ? { residueName } : {})
    }
  }

  if (residueStart !== undefined) {
    if (chainWide) return refusal('conflicting-shape', '同时说了「整条链」和一个残基编号。')
    return {
      ok: true,
      kind: 'residue',
      residue: { ...(chain ? { chain } : {}), residueStart, residueEnd: residueStart },
      ...(residueName ? { residueName } : {})
    }
  }

  if (chainWide || chain) return { ok: true, kind: 'chain', ...(chain ? { chain } : {}) }

  return refusal('no-selection-expressed', '这句话里没有可以落实成选择的信息。')
}

// ── D5 余项：中文口令 → **测量**（距离/角度） ──────────────────────────────────────────────
//
// 与选择同一条口径：解析不出来就**具名拒绝**、把原因上屏，绝不静默、绝不替用户挑。
// 这里有一条额外的诚实规则：**残基级距离必须拒绝**。只说「145 号和 160 号之间」时，量哪个原子
// （CA？SG？任意最近对？）是一个歧义 —— 挑一个看起来合理的原子等于替用户编了一个他没有的意图，
// 所以要求写出原子名（如 CA），说不出来就说清楚要怎么写。

export const STRUCTURE_MEASUREMENT_INSTRUCTION_REFUSALS = [
  /** 没听出要量距离还是角度。 */
  'measurement-kind-not-stated',
  /** 一个原子都没解析出来。 */
  'measurement-no-atoms-expressed',
  /** 说了编号但没说原子名（如 CA）⇒ 残基级距离有歧义，不替用户挑原子。 */
  'measurement-atom-missing',
  /** 距离要两个原子（第三个顶点不存在）。 */
  'measurement-needs-two-atoms',
  /** 角度要三个原子，中间那个是顶点。 */
  'measurement-needs-three-atoms'
] as const

export type StructureMeasurementInstructionRefusal =
  (typeof STRUCTURE_MEASUREMENT_INSTRUCTION_REFUSALS)[number]

export type StructureMeasurementAtomSelector = {
  /** 链（可缺）：apply 时按「在这份结构里唯一」解析，与选择同一条规则。 */
  chain?: string
  resi: number
  /** 原子名（CA/SG/N…）：**必填**，见上面那条诚实规则。 */
  atomName: string
}

export type StructureMeasurementInstruction =
  | {
      ok: true
      kind: 'distance'
      atoms: [StructureMeasurementAtomSelector, StructureMeasurementAtomSelector]
    }
  | {
      ok: true
      kind: 'angle'
      atoms: [
        StructureMeasurementAtomSelector,
        StructureMeasurementAtomSelector,
        StructureMeasurementAtomSelector
      ]
    }

export type StructureMeasurementInstructionResult =
  | StructureMeasurementInstruction
  | { ok: false; reason: StructureMeasurementInstructionRefusal; detail: string }

// 「[链 A] 145 号 CA」这一种写法：**编号在前、原子名在后**（中文语序）。只支持这一种并在拒绝里
// 写清楚要怎么写 —— 同时猜多种语序会让「145 号 A 链」这种句子被读成原子名 A、链 145。
const ATOM_REFERENCE_PATTERN =
  /(?:(?:链\s*([A-Za-z]))|([A-Za-z])\s*链)?\s*(\d+)\s*号?\s*([A-Za-z]{1,3})/g

const DIGIT_PATTERN = /\d/

export const parseStructureMeasurementInstruction = (
  raw: string
): StructureMeasurementInstructionResult => {
  const text = normaliseQueryPunctuation(raw ?? '').trim()
  const wantsDistance = /距离|间距|多远/.test(text)
  const wantsAngle = /角度|夹角/.test(text)
  if (!wantsDistance && !wantsAngle) {
    return {
      ok: false,
      reason: 'measurement-kind-not-stated',
      detail: '没听出要量什么：说「距离」（两个原子）或「角度」（三个原子，中间是顶点）。'
    }
  }

  const atoms: StructureMeasurementAtomSelector[] = []
  for (const match of text.matchAll(ATOM_REFERENCE_PATTERN)) {
    const chain = match[1] ?? match[2]
    const resi = Number(match[3])
    const atomName = match[4]
    atoms.push({ ...(chain ? { chain } : {}), resi, atomName })
  }

  if (atoms.length === 0) {
    // 有编号却一个原子都没解析出来 ⇒ 就是把残基编号当成了要量的东西。
    return DIGIT_PATTERN.test(text)
      ? {
          ok: false,
          reason: 'measurement-atom-missing',
          detail:
            '只说到残基编号，没说原子名：残基之间的距离是有歧义的（量哪对原子？），请写成「145 号 CA 与 160 号 CA 之间的距离」。'
        }
      : {
          ok: false,
          reason: 'measurement-no-atoms-expressed',
          detail: '没有听到要量哪几个原子，例如「145 号 CA 与 160 号 CA 之间的距离」。'
        }
  }

  if (wantsAngle) {
    if (atoms.length !== 3) {
      const detail =
        atoms.length < 3
          ? `角度要三个原子（现在只解析出 ${atoms.length} 个）：中间那个是顶点，例如「145 号 CA 与 155 号 CA 与 160 号 CA 之间的夹角」。`
          : `角度只要三个原子（现在解析出 ${atoms.length} 个）—— 多出来的编号说不清哪个是顶点。`
      return { ok: false, reason: 'measurement-needs-three-atoms', detail }
    }
    return { ok: true, kind: 'angle', atoms: [atoms[0]!, atoms[1]!, atoms[2]!] }
  }

  if (atoms.length !== 2) {
    return {
      ok: false,
      reason: 'measurement-needs-two-atoms',
      detail:
        atoms.length < 2
          ? `距离要两个原子（现在只解析出 ${atoms.length} 个），例如「145 号 CA 与 160 号 CA 之间的距离」。`
          : `距离只要两个原子（现在解析出 ${atoms.length} 个）—— 请说清楚量哪两个。`
    }
  }
  return { ok: true, kind: 'distance', atoms: [atoms[0]!, atoms[1]!] }
}

export const structureMeasurementInstructionParameterLine = (
  instruction: StructureMeasurementInstruction
): string => {
  const atom = (selector: StructureMeasurementAtomSelector): string =>
    `${selector.chain ? `${selector.chain} 链 ` : ''}${selector.resi} 号 ${selector.atomName}`
  return instruction.kind === 'distance'
    ? `距离：${atom(instruction.atoms[0])} — ${atom(instruction.atoms[1])}`
    : `角度：${atom(instruction.atoms[0])} — ${atom(instruction.atoms[1])}（顶点）— ${atom(instruction.atoms[2])}`
}

/** 把解析结果写成**参数行**（界面要上屏的就是它：用户得看见"实际发出去的是什么"）。 */
export const structureInstructionParameterLine = (instruction: StructureInstruction): string => {
  if (instruction.kind === 'chain') {
    return `整条链${instruction.chain ? ` ${instruction.chain}` : ''}`
  }
  if (instruction.kind === 'neighborhood') {
    const { reference, radiusAngstrom } = instruction
    const chain = reference.chain ? `链 ${reference.chain} ` : ''
    const name = instruction.residueName ? ` (${instruction.residueName})` : ''
    return `邻域：半径 ${radiusAngstrom} Å · 参考 ${chain}残基 ${reference.residueStart}${name}`
  }
  const chain = instruction.residue.chain ? `链 ${instruction.residue.chain} ` : ''
  const name = instruction.residueName ? ` (${instruction.residueName})` : ''
  return instruction.kind === 'range'
    ? `区间：${chain}残基 ${instruction.residue.residueStart}-${instruction.residue.residueEnd}`
    : `单残基：${chain}残基 ${instruction.residue.residueStart}${name}`
}
