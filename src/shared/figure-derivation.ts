// U4：拿到「这张图是哪一类」之后，**这一类允许派生什么**就定了 —— 本模块只做**本机能做的那一件**，
// 其余的**具名拒答**并写明缺什么。
//
// 为什么拒答也必须出现在结果里（而不是静默省略）：插图理解的红线是「通用描述不许冒充前三类」
// （台账 §一百六十三 §五）。一个空结果读起来像「这张图没什么可派的」，而真相往往是「这一类需要一样
// 本机没有的东西」——两者必须长得不一样，否则人就拿描述模型把它填上。
//
// 本模块是纯函数：不碰网络、不碰模型、不碰磁盘。图表一路的「数值」取自**页面上已经印出来的文字项**
// （PDF 的文字层），每一项带**它印在的那一行的页级几何** —— 这就是来源标注，读者可以回原文核对。
// 所以这一路给的是**数值本身**，不是结论：不做换算、不做统计、不解释。

import type { FigureAccession, PdfFigureUnderstanding } from './figure-understanding'

export type DerivedFigureNumber = {
  /** 从这一行里取出的数值记号（原样，不加工）。 */
  value: string
  /** 它印在哪一行（整行原文）。 */
  line: string
  /** 那一行的页级几何（PDF 用户空间，原点左下）—— 来源标注。 */
  bbox: { x: number; y: number; width: number; height: number }
}

export type FigureDerivationRefusal =
  // 化学结构式：需要一台 OCSR 引擎，本机没有。
  | 'recognizer-unavailable'
  // 蛋白结构图：库号在图上，但「按库号查真实数据」这条路还没接。
  | 'accession-lookup-not-wired'
  // 通用示意图：需要一台通用描述模型，本机没有配置。
  | 'description-model-not-configured'
  // 图表：图框内没有任何数值文字项（数值可能是矢量画的，文字层里没有）。
  | 'no-numbers-in-box'
  // 判不出类别（见 verdict.reason）。
  | 'undetermined'

export type FigureDerivation =
  | { kind: 'numbers'; source: 'pdf-text-in-bbox'; values: readonly DerivedFigureNumber[] }
  | {
      kind: 'refused'
      reason: FigureDerivationRefusal
      /** 这一类允许派生什么、前提是什么（来自判定带回来的 route，不另写一份）。 */
      requires?: string
      /** 蛋白一路：图上读到的库号（就是「本该拿去查」的那些）；没有就缺席。 */
      accessions?: readonly FigureAccession[]
      /** 判不出时的具名理由，原样带出来。 */
      detail?: 'no-signals' | 'insufficient-signals' | 'conflicting-signals'
    }

export type FigureTextItem = {
  text: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * 一个**数值记号**：可带 `p`/`n` 这类统计前缀与比较/约等号，也可带百分号。
 *
 * 刻意**不接受**任意字母前缀：`IC50` 是指标名不是数值，`R2` 更可能是 R² 或行号 —— 真机读数里就出现过
 * `R2`，把它当数值会把一个标签写进「图内数值」里。所以只有统计意义上**就是数值**的少数前缀放行。
 */
const NUMERIC_TOKEN = /^(?:[pPnN])?\s*(?:[<>≈~=])?\s*[-+]?\d+(?:[.,]\d+)?\s*%?$/

/** 把一行印出来的文字拆成数值记号；原样保留记号。 */
export const numericTokensIn = (line: string): string[] =>
  line
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token !== '' && NUMERIC_TOKEN.test(token))

/**
 * 一张图的派生结果。**判不出与不需要派生是两件事**：前者带 `undetermined` 与它的理由，后者带这一类
 * 缺的那样东西 —— 两者都不会是「什么都没有」。
 */
export const deriveFromFigure = (input: {
  understanding: PdfFigureUnderstanding
  inFigureText: readonly FigureTextItem[]
}): FigureDerivation => {
  const { verdict, route } = input.understanding

  if (verdict.class === 'undetermined') {
    return { kind: 'refused', reason: 'undetermined', detail: verdict.reason }
  }

  if (verdict.class === 'chemical-structure') {
    return {
      kind: 'refused',
      reason: 'recognizer-unavailable',
      ...(route ? { requires: route.requires } : {})
    }
  }

  if (verdict.class === 'protein-structure') {
    return {
      kind: 'refused',
      reason: 'accession-lookup-not-wired',
      ...(route ? { requires: route.requires } : {}),
      ...(verdict.accessions.length > 0 ? { accessions: verdict.accessions } : {})
    }
  }

  if (verdict.class === 'schematic') {
    return {
      kind: 'refused',
      reason: 'description-model-not-configured',
      ...(route ? { requires: route.requires } : {})
    }
  }

  const values: DerivedFigureNumber[] = []
  for (const item of input.inFigureText) {
    for (const value of numericTokensIn(item.text)) {
      values.push({
        value,
        line: item.text,
        bbox: { x: item.x, y: item.y, width: item.width, height: item.height }
      })
    }
  }
  if (values.length === 0) return { kind: 'refused', reason: 'no-numbers-in-box' }
  return { kind: 'numbers', source: 'pdf-text-in-bbox', values }
}

/** 给人看的一行：派生的结果或**具名的缺什么**（英文，与界面/证据档同源）。 */
export const describeFigureDerivation = (derivation: FigureDerivation): string => {
  if (derivation.kind === 'numbers') {
    return `${derivation.values.length} number(s) from ${derivation.source}`
  }
  const requires = derivation.requires === undefined ? '' : ` — requires: ${derivation.requires}`
  const detail = derivation.detail === undefined ? '' : ` (${derivation.detail})`
  const accessions =
    derivation.accessions === undefined || derivation.accessions.length === 0
      ? ''
      : ` — accessions on the figure: ${derivation.accessions.map((a) => `${a.kind}:${a.id}`).join(', ')}`
  return `refused: ${derivation.reason}${detail}${accessions}${requires}`
}
