// 插图理解的第一层：**按图形类别分派**，并且**判不出就拒答**。
//
// 为什么需要这一层（台账 §一百六十三 §二 §五）：通用视觉语言模型「读」分子结构式会编造不存在的键与
// 官能团 —— 而本产品的红线正是防幻觉、可核验。所以插图一路按类别分派、确定性优先：
//
//   化学结构式 ⇒ OCSR（图像 ⇒ SMILES/InChI，机器可复算）        —— 需引擎，本层只**判类别**
//   蛋白/生物结构图 ⇒ 不读图：取图上标注的库号去**查真实数据**   —— 查库是硬事实，读图必然幻觉
//   图表/曲线/热图 ⇒ 数值抽取，且**每项带来源**                 —— 数值必须可追溯
//   通用示意图 ⇒ 留给通用描述模型（低风险场景）                 —— **只覆盖这一类**
//
// 本模块只做第一层，而且把它做成**纯函数**：输入是应用已经拿到的东西（图注文本 + 落在图框内的文字项），
// 不碰网络、不碰模型、不碰磁盘。三条不放松的地方：
//
//   ① **没有默认类别**。判不出就是 `undetermined` 并给具名理由（无信号 / 信号不足 / 信号互相矛盾），
//      绝不允许「沉默地落到通用示意图」—— 那正是让通用描述冒充前三类的入口。
//   ② **每一票都点名**。判定结果里逐条带着是**哪条证据**投的票（原文片段 + 它在图注里还是图框内），
//      读者据此复核，调用方据此拒绝把一个弱信号当成结论。
//   ③ **不产出表示**。判别给出的类别决定**允许**派生什么（见 `FIG_UNDERSTANDING_ROUTES`），本模块
//      不生成 SMILES、不生成数值、不写结论。
//
// 类别判据刻意保守：图表的轴/统计标记要**两种不同**才算数（一个 `n = 12` 会出现在任何图注里），
// 蛋白库号要么带 `PDB`/`UniProt` 关键词，要么是库号形状**且**同处出现结构性词。

export type FigureClass = 'chemical-structure' | 'protein-structure' | 'chart' | 'schematic'

/** 票来自哪里：图注，还是落在图框内的文字项。 */
export type FigureSignalWhere = 'caption' | 'in-figure-text'

export type FigureSignal = {
  /** 投给哪个类别。 */
  figureClass: FigureClass
  /** 这条信号的机器可读种类（同一类别的不同信号种类才互相印证）。 */
  kind: string
  /** 命中的原文片段（原样，不加工）。 */
  matched: string
  where: FigureSignalWhere
}

export type FigureAccession = {
  kind: 'pdb' | 'uniprot'
  id: string
  where: FigureSignalWhere
}

export type FigureClassVerdict =
  | {
      class: 'chemical-structure'
      signals: readonly FigureSignal[]
    }
  | {
      class: 'protein-structure'
      signals: readonly FigureSignal[]
      /** 图上读到的库号；**空数组也能出现**（结构性词命中但没有库号）⇒ 调用方必须拒答而不是编一个。 */
      accessions: readonly FigureAccession[]
    }
  | { class: 'chart'; signals: readonly FigureSignal[] }
  | { class: 'schematic'; signals: readonly FigureSignal[] }
  | {
      class: 'undetermined'
      reason: 'no-signals' | 'insufficient-signals' | 'conflicting-signals'
      signals: readonly FigureSignal[]
    }

export type FigureUnderstandingInput = {
  /** 文档放在图旁边的标注；没有就传 undefined（**不要**传空串表示「没有」和「空标注」的混合体）。 */
  caption?: string
  /** 落在图框内的文字项，按页上顺序。图注自身的文字项也算（库里就是这么给的）。没有就省略。 */
  inFigureText?: readonly string[]
}

/** 每类**允许**派生什么、以及派生的前提。给调用方与界面用，读的地方只有这一处。 */
export const FIG_UNDERSTANDING_ROUTES: Readonly<
  Record<FigureClass, { readonly derivation: string; readonly requires: string }>
> = Object.freeze({
  'chemical-structure': {
    derivation:
      'OCSR：图像 ⇒ SMILES/InChI（机器可复算的表示；≥2 个独立引擎一致才算高置信，低置信即拒答）',
    requires: '一个已安装且 revision 固定的光学化学结构识别引擎'
  },
  'protein-structure': {
    derivation: '取图上标注的库号（PDB/UniProt）去查真实数据；派生结果挂连接器读数',
    requires: '图上确实有库号；没有就拒答，绝不生成一个'
  },
  chart: {
    derivation: '图内数值抽取，每一项带页级几何作为来源标注',
    requires: '图框内确有数值文字项'
  },
  schematic: {
    derivation: '通用描述（低风险场景）',
    requires: '一个通用描述模型；本类之外不得使用它'
  }
})

type Rule = {
  figureClass: FigureClass
  kind: string
  pattern: RegExp
}

// 化学结构式：Scheme 号、化合物/衍生物编号、合成语汇与常见试剂记号。
const CHEMISTRY_RULES: readonly Rule[] = [
  { figureClass: 'chemical-structure', kind: 'scheme-label', pattern: /\bscheme\s*s?\d+/i },
  {
    figureClass: 'chemical-structure',
    kind: 'compound-label',
    pattern: /\b(?:compound|analog(?:ue)?|derivative)\s*[0-9]+[a-z]?\b/i
  },
  {
    figureClass: 'chemical-structure',
    kind: 'synthesis-vocabulary',
    pattern: /合成|反应|产率|\b(?:yield|reagents?|equiv\.?|mmol|synthesis)\b/i
  },
  {
    figureClass: 'chemical-structure',
    kind: 'reagent-token',
    pattern: /\b(?:Et3N|DMF|THF|DMSO|DCM|NaOH|KOH|HCl|H2SO4|Pd\/C|LiAlH4)\b/
  },
  { figureClass: 'chemical-structure', kind: 'substituent-token', pattern: /\bR[1-9]\b|\bAr\b/ }
]

// 蛋白/生物结构图：库号（带关键词，或库号形状 + 结构性词）。
const PDB_SHAPED = /\b[1-9][A-Za-z0-9]{3}\b/g
const UNIPROT_ID = /\b[A-NR-Z][0-9][A-Z0-9]{3}[0-9]\b|\b[OPQ][0-9][A-Z0-9]{3}[0-9]\b/g

// 图表：轴/统计/图形语汇，且**两种不同种类**才算数。
const CHART_RULES: readonly Rule[] = [
  {
    figureClass: 'chart',
    kind: 'unit-axis',
    pattern: /\((?:nM|µM|uM|mM|pM|mg\/kg|%|a\.u\.|AU)\)/i
  },
  {
    figureClass: 'chart',
    kind: 'statistic',
    pattern:
      /\b(?:IC50|EC50|Ki|Kd|HR|OR|RR|AUC|fold[-\s]?change|95%\s*CI|SEM|SD|error\s*bars?|p\s*[<=]\s*0?\.\d+)\b/i
  },
  { figureClass: 'chart', kind: 'sample-size', pattern: /\bn\s*=\s*\d+/i },
  {
    figureClass: 'chart',
    kind: 'chart-word',
    pattern:
      /曲线|柱状|散点|热图|森林图|\b(?:bar\s*chart|scatter|heatmap|forest\s*plot|kaplan[-\s]?meier|box\s*plot|dose[-\s]?response)\b/i
  },
  {
    figureClass: 'chart',
    kind: 'axis-word',
    pattern: /\b(?:axis|log\s*scale|concentration|viability|inhibition)\b|纵轴|横轴/
  }
]

// 通用示意图：只有明写这一类才算。
const SCHEMATIC_RULES: readonly Rule[] = [
  {
    figureClass: 'schematic',
    kind: 'schematic-word',
    pattern: /示意图|流程|\bschematic\b|\bflow\s*chart\b|\bworkflow\b/i
  }
]

const STRUCTURAL_CONTEXT =
  /\b(?:ribbon|surface|cartoon|chain|residues?|crystal\s*structure|homology\s*model)\b|结构|链|晶体/i

const signalize = (rule: Rule, text: string, where: FigureSignalWhere): FigureSignal[] => {
  const matches = text.match(rule.pattern)
  if (!matches || matches.length === 0) return []
  return matches.slice(0, 3).map((matched) => ({
    figureClass: rule.figureClass,
    kind: rule.kind,
    matched,
    where
  }))
}

const collect = (rules: readonly Rule[], text: string, where: FigureSignalWhere): FigureSignal[] =>
  rules.flatMap((rule) => signalize(rule, text, where))

const accessionsIn = (text: string, where: FigureSignalWhere): FigureAccession[] => {
  const found: FigureAccession[] = []
  const keywordPdb = text.match(/\bPDB(?:\s*(?:ID|id|entry))?\s*[:#]?\s*([1-9][A-Za-z0-9]{3})\b/)
  if (keywordPdb?.[1]) found.push({ kind: 'pdb', id: keywordPdb[1].toUpperCase(), where })
  const keywordUniprot = text.match(
    /\bUniProt(?:\s*(?:ID|id|accession))?\s*[:#]?\s*([A-NR-Z][0-9][A-Z0-9]{3}[0-9]|[OPQ][0-9][A-Z0-9]{3}[0-9])\b/i
  )
  if (keywordUniprot?.[1])
    found.push({ kind: 'uniprot', id: keywordUniprot[1].toUpperCase(), where })
  if (found.length === 0 && STRUCTURAL_CONTEXT.test(text)) {
    // 没有关键词，但同处有结构性词 ⇒ 库里那种「图注写着 1abc 的绑带图」。
    for (const token of text.match(PDB_SHAPED) ?? []) {
      found.push({ kind: 'pdb', id: token.toUpperCase(), where })
    }
    for (const token of text.match(UNIPROT_ID) ?? []) {
      found.push({ kind: 'uniprot', id: token.toUpperCase(), where })
    }
  }
  const seen = new Set<string>()
  return found.filter((entry) => {
    const key = `${entry.kind}:${entry.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 判定一张插图的类别。**判不出就拒答**（三种具名理由），并且每一票都带原文与出处。
 */
export const classifyFigure = (input: FigureUnderstandingInput): FigureClassVerdict => {
  const texts: { text: string; where: FigureSignalWhere }[] = []
  if (input.caption !== undefined && input.caption.trim() !== '') {
    texts.push({ text: input.caption, where: 'caption' })
  }
  for (const item of input.inFigureText ?? []) {
    if (item.trim() !== '') texts.push({ text: item, where: 'in-figure-text' })
  }

  const chemistry = texts.flatMap(({ text, where }) => collect(CHEMISTRY_RULES, text, where))
  const proteinKeywords = texts.flatMap(({ text, where }) =>
    signalize(
      {
        figureClass: 'protein-structure',
        kind: 'accession-keyword',
        pattern: /\b(?:PDB|UniProt)\b/i
      },
      text,
      where
    )
  )
  const proteinContext = texts.flatMap(({ text, where }) =>
    signalize(
      {
        figureClass: 'protein-structure',
        kind: 'structural-context',
        pattern: STRUCTURAL_CONTEXT
      },
      text,
      where
    )
  )
  const accessions = texts.flatMap(({ text, where }) => accessionsIn(text, where))
  // 类别成立的条件是「读到库号」**或**「同处写着结构性词」：一张绑带图就算没印库号，它也不是通用
  // 示意图 —— 归到这一类，下游必须**拒答派生**（`accessions: []` 就是那个拒答的依据），而不是让通用
  // 描述把它盖过去。
  const protein =
    accessions.length > 0 || proteinContext.length > 0
      ? [...proteinKeywords, ...proteinContext]
      : []

  const chart = texts.flatMap(({ text, where }) => collect(CHART_RULES, text, where))
  const schematic = texts.flatMap(({ text, where }) => collect(SCHEMATIC_RULES, text, where))

  const distinctChartKinds = new Set(chart.map((signal) => signal.kind))
  const distinctChemistryKinds = new Set(chemistry.map((signal) => signal.kind))

  const verdicts: FigureClassVerdict[] = []
  // 化学一路：**强信号**（Scheme 号、化合物/衍生物编号）单独即可立类；弱信号（试剂/取代基记号）
  // 要**两种不同种类**才算。真机读数当场证明这条必要：一张非化学的图只因图内有 `R2` 这个记号就被判成
  // 化学结构式 —— 而 `R2` 也可能是 R² 或一个行号。判不清就拒答，不许拿弱信号立类。
  const strongChemistry = chemistry.some(
    (signal) => signal.kind === 'scheme-label' || signal.kind === 'compound-label'
  )
  if (chemistry.length > 0 && (strongChemistry || distinctChemistryKinds.size >= 2)) {
    verdicts.push({ class: 'chemical-structure', signals: chemistry })
  }
  if (protein.length > 0) {
    verdicts.push({ class: 'protein-structure', signals: protein, accessions })
  }
  if (distinctChartKinds.size >= 2) {
    verdicts.push({ class: 'chart', signals: chart })
  }
  if (schematic.length > 0) {
    verdicts.push({ class: 'schematic', signals: schematic })
  }

  if (verdicts.length === 1) return verdicts[0] as FigureClassVerdict

  const allSignals = [...chemistry, ...protein, ...chart, ...schematic]
  if (verdicts.length > 1) {
    return {
      class: 'undetermined',
      reason: 'conflicting-signals',
      signals: allSignals
    }
  }
  // 一票都没有 ⇒ 无信号；有票但不够一个类别（例如图表只命中 `n = 12` 这一种）⇒ 信号不足。
  return {
    class: 'undetermined',
    reason: allSignals.length === 0 ? 'no-signals' : 'insufficient-signals',
    signals: allSignals
  }
}

/**
 * 一张插图上屏/上报时携带的理解结果：判定 + 这一类**允许**派生什么。
 *
 * `basis` 不另存一份：判定本身已经逐条带着票（`verdict.signals`），多存一份就有两份会漂移的口径；
 * 要给人看的那一行由 `describeFigureVerdict` 现算。
 */
export type PdfFigureUnderstanding = {
  verdict: FigureClassVerdict
  /** `undetermined` 时**没有** route —— 没有类别就没有被允许的派生。 */
  route?: { readonly derivation: string; readonly requires: string }
}

/** 判定 + 查表拿 route（表的唯一读点在这里，调用方不必自己 case）。 */
export const figureUnderstandingFor = (input: FigureUnderstandingInput): PdfFigureUnderstanding => {
  const verdict = classifyFigure(input)
  if (verdict.class === 'undetermined') return { verdict }
  return { verdict, route: FIG_UNDERSTANDING_ROUTES[verdict.class] }
}

/** 给人看的一行（英文，与界面/证据档同源）。**不改变判定**，只是把判定与它的票写出来。 */
export const describeFigureVerdict = (verdict: FigureClassVerdict): string => {
  const votes = verdict.signals
    .map((signal) => `${signal.figureClass}:${signal.kind} "${signal.matched}" (${signal.where})`)
    .join('; ')
  if (verdict.class === 'undetermined') {
    return `undetermined (${verdict.reason})${votes === '' ? '' : ` — ${votes}`}`
  }
  if (verdict.class === 'protein-structure') {
    const ids = verdict.accessions.map((entry) => `${entry.kind}:${entry.id}`).join(', ')
    return `protein-structure — accessions [${ids}] — ${votes}`
  }
  return `${verdict.class} — ${votes}`
}
