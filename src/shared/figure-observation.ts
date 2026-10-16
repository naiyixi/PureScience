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
