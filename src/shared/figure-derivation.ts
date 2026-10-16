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

import { accessionLookupRetryHint } from './figure-accession'
import type {
  StructureRecognitionOutcome,
  StructureRecognitionReading
} from './structure-recognition'
import type { AccessionLookupOutcome, AccessionRecord } from './figure-accession'
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
  // 化学结构式：**只有一台**引擎给出了结果 —— 缺的是第二台独立引擎，不是图像质量，所以与「判不出」分开。
  | 'recognizer-single-engine'
  // 化学结构式：两台都读了，但规范化之后不是同一个结构 —— 谁也不能代表这张图。
  | 'recognizer-disagreement'
  // 蛋白结构图：库号在图上，但「按库号查真实数据」这条路还没接（装配点没给查询口）。
  | 'accession-lookup-not-wired'
  // 查过了，库里没有这一条 —— 与「没查」不是一回事。
  | 'accession-lookup-not-found'
  // 查不动（网络/代理/超时）。**不是**「以后再说」：下面会带一句这台机器能走的下一步。
  | 'accession-lookup-unavailable'
  // 通用示意图：需要一台通用描述模型，本机没有配置。
  | 'description-model-not-configured'
  // 图表：图框内没有任何数值文字项（数值可能是矢量画的，文字层里没有）。
  | 'no-numbers-in-box'
  // 判不出类别（见 verdict.reason）。
  | 'undetermined'

export type FigureDerivation =
  | { kind: 'numbers'; source: 'pdf-text-in-bbox'; values: readonly DerivedFigureNumber[] }
  // 蛋白/生物图：图上读到的库号已经**换成库里真取的记录**（不靠模型编）。每条都带来源与依据
  // （实验测定 / 预测），因为这两者在证据链上不是同一件事。
  | { kind: 'records'; source: 'accession-lookup'; records: readonly AccessionRecord[] }
  // 化学结构式：图进结构式出，且**至少两台相互独立的引擎**给出同一个（规范化之后的）结果。这一路只在高置信
  // 时存在；只有一台、两台不一致、一台都没有，全部退回下面的具名拒答。
  | {
      kind: 'structure'
      source: 'ocsr'
      /** 代表写法：第一台同意引擎原样给出的结构式（不改写它的拼法）。 */
      smiles: string
      /** 规范化后的结构式（跨引擎比较的是化学，不是拼法）。 */
      canonical: string
      formula?: string
      /** 同意的引擎与各自版本 —— 复算要的就是这两样。 */
      engines: readonly { engine: string; revision: string }[]
      /** 输入指纹（页 + 框 + 渲染 DPI + 参与引擎与版本）：换任何一样都会变，且可在应用之外复算。 */
      recognitionFingerprint: string
    }
  | {
      kind: 'refused'
      reason: FigureDerivationRefusal
      /** 这一类允许派生什么、前提是什么（来自判定带回来的 route，不另写一份）。 */
      requires?: string
      /** 蛋白一路：图上读到的库号（就是「本该拿去查」的那些）；没有就缺席。 */
      accessions?: readonly FigureAccession[]
      /** 判不出时的具名理由，原样带出来。 */
      detail?: 'no-signals' | 'insufficient-signals' | 'conflicting-signals'
      /** 化学结构式一路：每台引擎各自说了什么（含没给出结果的），原样上屏，让人能自己看。 */
      structureReadings?: readonly StructureRecognitionReading[]
    }

/**
 * 把识别结果贴回派生：只有「化学结构式、但识别口没接」这一种拒答会被升级。高置信（≥2 台独立引擎一致）⇒
 * `structure`；其余（一台、两台不一致、一台都没有）⇒ **换成对应的具名拒答**并带上每台引擎的读数。别的派生
 * 一个字不动 —— 这一步只做升级与具名，不改判据。
 */
export const applyStructureRecognition = (
  derivation: FigureDerivation,
  outcome: StructureRecognitionOutcome,
  recognitionFingerprint: string
): FigureDerivation => {
  if (derivation.kind !== 'refused') return derivation
  if (derivation.reason !== 'recognizer-unavailable') return derivation
  if (outcome.state === 'agreed') {
    return {
      kind: 'structure',
      source: 'ocsr',
      smiles: outcome.smiles,
      canonical: outcome.canonical,
      ...(outcome.formula === undefined ? {} : { formula: outcome.formula }),
      engines: outcome.engines.map((engine) => ({
        engine: engine.engine,
        revision: engine.revision
      })),
      recognitionFingerprint
    }
  }
  return { ...derivation, reason: outcome.reason, structureReadings: outcome.readings }
}

/**
 * 把查询结果贴回派生：只有「库号在图上、但查询口没接」这一种拒答会被**升级**成 `records`；查过了但没有、
 * 或查不动，都改成对应的**具名拒答**并带上可操作的那一步。其余派生原样返回 —— 这一步只做升级与具名，
 * 不改判据。
 */
export const applyAccessionLookups = (
  derivation: FigureDerivation,
  outcomes: readonly AccessionLookupOutcome[]
): FigureDerivation => {
  if (derivation.kind !== 'refused') return derivation
  if (derivation.reason !== 'accession-lookup-not-wired') return derivation
  if (outcomes.length === 0) return derivation

  const records = outcomes.flatMap((outcome) =>
    outcome.state === 'resolved' ? [...outcome.records] : []
  )
  if (records.length > 0) return { kind: 'records', source: 'accession-lookup', records }

  const unavailable = outcomes.find((outcome) => outcome.state === 'unavailable')
  if (unavailable && unavailable.state === 'unavailable') {
    return {
      ...derivation,
      reason: 'accession-lookup-unavailable',
      requires: `${unavailable.id}: ${unavailable.reason}. ${accessionLookupRetryHint}`
    }
  }

  const missing = outcomes.find((outcome) => outcome.state === 'not-found')
  if (missing) {
    return {
      ...derivation,
      reason: 'accession-lookup-not-found',
      requires: 'the entry service answered: no such entry. Nothing was invented to fill the gap.'
    }
  }

  return derivation
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
  if (derivation.kind === 'records') {
    // 库里的记录：写清**哪一条**与**依据**（实验测定 / 预测），两者在证据链上不是同一件事。
    return `${derivation.records.length} record(s) from ${derivation.source}: ${derivation.records
      .map((record) => `${record.id} (${record.basis})`)
      .join(', ')}`
  }
  if (derivation.kind === 'structure') {
    // 结构式：写法 + 规范化 + **哪几台引擎同意**（复算要的就是后者的版本）。
    return `${derivation.smiles} (${derivation.source}; canonical ${derivation.canonical}; agreed by ${derivation.engines
      .map((engine) => `${engine.engine} ${engine.revision}`)
      .join(' + ')})`
  }
  const requires = derivation.requires === undefined ? '' : ` — requires: ${derivation.requires}`
  const detail = derivation.detail === undefined ? '' : ` (${derivation.detail})`
  const accessions =
    derivation.accessions === undefined || derivation.accessions.length === 0
      ? ''
      : ` — accessions on the figure: ${derivation.accessions.map((a) => `${a.kind}:${a.id}`).join(', ')}`
  return `refused: ${derivation.reason}${detail}${accessions}${requires}`
}
