// U4-d：**插图派生结果**在既有溯源面上的形状，与它的**输入指纹配方**。
//
// 与 `reading-fingerprint.ts` 同一套分工（照抄不是偷懒，是让两条证据链长得一样）：**shared 拥有配方、
// 形状与判定，主进程算摘要**。配方是公开常量，摘要**先算配方那一行**，所以任何拿到这段记录的人都能在
// 应用之外复算它 —— 这正是差异化 ④「派生结果带 revision + 输入指纹、换输入即标过期」的判据。
//
// 为什么指纹算的是**输入**而不是输出：输出是派生的结果，输入才是「这段结果是由什么产出的」。同一个
// 输入（同一页、同一个框、同一段图注与图内文字）必须得到同一个指纹；换了其中任何一样，指纹就变，读侧
// 据此把旧结果标过期 —— 而不是让人凭时间戳猜。

import type { FigureDerivation } from './figure-derivation'
import type { FigureClass } from './figure-understanding'

/** 配方的第一行：一个可读的、版本化的名字。改配方必须改它（否则旧摘要会被当成新配方的产物）。 */
export const FIGURE_DERIVATION_FINGERPRINT_RECIPE = 'purescience/figure-derivation/v1'

export const FIGURE_DERIVATION_FINGERPRINT_PREFIX = 'sha256:'
export const FIGURE_DERIVATION_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/

/** 算指纹用的输入：派生所依据的一切，且**只有**这些。 */
export type FigureDerivationInput = {
  page: number
  bbox: { x: number; y: number; width: number; height: number }
  caption?: string
  /** 落在图框内的文字项，按页上顺序（顺序是输入的一部分：同一批字换了位置/顺序就是另一份证据）。 */
  inFigureText: readonly string[]
}

/**
 * 把输入写成**规范串**（配方）。没有时间戳、没有计数器、没有主机相关信息 —— 任何人拿同一份输入都能
 * 拼出逐字节相同的一段文本，因此摘要可复算。数字一律按定点写法，避开浮点格式化的平台差异。
 */
export const figureDerivationRecipe = (input: FigureDerivationInput): string => {
  const fixed = (value: number): string => value.toFixed(3)
  const lines = [
    FIGURE_DERIVATION_FINGERPRINT_RECIPE,
    `page=${String(input.page)}`,
    `bbox=${fixed(input.bbox.x)},${fixed(input.bbox.y)},${fixed(input.bbox.width)},${fixed(input.bbox.height)}`,
    `caption=${input.caption ?? ''}`,
    `in-figure-text=${String(input.inFigureText.length)}`,
    ...input.inFigureText
  ]
  return `${lines.join('\n')}\n`
}

/** 落在既有溯源面上的那一条：派生结果 + 它是**由什么**产出的。 */
export type FigureDerivationObservation = {
  page: number
  index: number
  bbox: { x: number; y: number; width: number; height: number }
  figureClass: FigureClass | 'undetermined'
  /** 输入指纹（`sha256:<64 hex>`）—— 换输入即变，读侧据此标过期。 */
  inputFingerprint: string
  /** 化学一路所用模型的 revision；**没有引擎时缺席**（不写一个假的）。 */
  modelRevision?: string
  /** 这一类的派生结果，或它的具名拒答（拒答也是结果）。 */
  derivation: FigureDerivation
}

/**
 * 读侧判决：这条派生结果**是否仍被当前的依据支持**。
 *
 * 记下来的东西只有输入指纹与模型版本两样；这两样正是「这段结果是由什么产出的」。所以判决只需要把同一张图
 * （同一页、同一图序）**后来**的派生与它比一次：
 *  - 同一张图后来没有派生过 ⇒ `current`（没人推翻它）；
 *  - 后来那一条的输入指纹不同 ⇒ `input-changed`（旧结果算的是**另一份输入**，页面/框/图注/图内文字变过）；
 *  - 输入相同但模型版本不同 ⇒ `model-revision-changed`（换了引擎版本，同一个输入算出了另一份结果）；
 *  - 两样都相同 ⇒ 仍是 `current`：那只是同一份输入用同一批模型又算了一次，结论没有变。
 *
 * 判决不落到「缺失」上：`current` 也是判决，会被写进值里 —— 于是渲染层看到「没有这个字段」只意味着一件事：
 * 这一行不是派生行。**缺席 ≠ 通过**在这条契约里是结构性的，不靠读的人猜。
 */
export type FigureDerivationStatus =
  | { state: 'current' }
  | {
      state: 'superseded'
      reason: 'input-changed' | 'model-revision-changed'
      /** 取代它那一条的录制时刻（ISO 8601），读的人据此去找那一条。 */
      supersededAt: string
      /** 取代它那一条的输入指纹（`sha256:<64 hex>`），供逐字符比对。 */
      supersededBy: string
    }

/** 判决只需要这两样：录制时刻（给人看）与那条派生本身。 */
export type FigureDerivationJournalRow = {
  recordedAt: string
  figureDerivation?: FigureDerivationObservation
}

/** 同一张图的身份：页 + 图序。派生是在这张图上做的，指纹之外的这两项就是「哪一张图」。 */
const figureIdentity = (derivation: FigureDerivationObservation): string =>
  `${String(derivation.page)}:${String(derivation.index)}`

/**
 * 模型版本：这一路结果由哪一套模型产出。确定性的一路（图内数值取自文字层、库号查真库）**没有模型**
 * ⇒ 缺席，绝不写一个看起来像版本号的假值；化学一路是「引擎@版本」按引擎原样拼起来，两台引擎各自可比。
 */
export const figureDerivationModelRevision = (derivation: FigureDerivation): string | undefined =>
  derivation.kind === 'structure'
    ? derivation.engines.map((engine) => `${engine.engine}@${engine.revision}`).join('+')
    : undefined

/**
 * 逐行判决，**按日志顺序**（追加顺序就是时间顺序；不拿时间戳排序 —— 同毫秒的两条会互相盖掉，而顺序是载体
 * 自己的事实）。只对派生行给判决；其余行返回 `undefined`（它们没有「是否被推翻」这回事）。
 */
export const figureDerivationStatuses = (
  rows: readonly FigureDerivationJournalRow[]
): (FigureDerivationStatus | undefined)[] => {
  // 每张图**最后一次**派生。后来的每一条都会覆盖前一条 —— 判决永远只跟「最新的那一份依据」比。
  const latest = new Map<string, number>()
  rows.forEach((row, index) => {
    if (row.figureDerivation) latest.set(figureIdentity(row.figureDerivation), index)
  })

  return rows.map((row, index) => {
    const derivation = row.figureDerivation
    if (!derivation) return undefined
    const latestIndex = latest.get(figureIdentity(derivation))
    if (latestIndex === undefined || latestIndex === index) return { state: 'current' }
    const newer = rows[latestIndex]?.figureDerivation
    if (!newer) return { state: 'current' }
    if (newer.inputFingerprint !== derivation.inputFingerprint) {
      return {
        state: 'superseded',
        reason: 'input-changed',
        supersededAt: rows[latestIndex]?.recordedAt ?? '',
        supersededBy: newer.inputFingerprint
      }
    }
    if ((newer.modelRevision ?? null) !== (derivation.modelRevision ?? null)) {
      return {
        state: 'superseded',
        reason: 'model-revision-changed',
        supersededAt: rows[latestIndex]?.recordedAt ?? '',
        supersededBy: newer.inputFingerprint
      }
    }
    return { state: 'current' }
  })
}

/** 形状守卫：读侧据此把「坏了的一条」与「没有的一条」分开，绝不把坏记录当空记录。 */
export const isFigureDerivationObservation = (
  value: unknown
): value is FigureDerivationObservation => {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<FigureDerivationObservation>
  return (
    typeof entry.page === 'number' &&
    typeof entry.index === 'number' &&
    typeof entry.figureClass === 'string' &&
    typeof entry.inputFingerprint === 'string' &&
    FIGURE_DERIVATION_FINGERPRINT_PATTERN.test(entry.inputFingerprint) &&
    typeof entry.derivation === 'object' &&
    entry.derivation !== null &&
    entry.bbox !== undefined &&
    typeof entry.bbox === 'object'
  )
}
