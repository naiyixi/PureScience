// 视图模型：把「每页文本层 + 译文记录」一次组装成面板与导出件要的全部东西。
//
// 这一层存在是为了让**接线只剩一行**：缝（pdf 侧）给 `pages` 与 `records`，面板要的行/逐页状态/术语偏离/
// 对照件由这里一次算出来。放在 shared 里是因为它全是纯计算，且两处（窗口与导出）必须算出**同一份**。
//
// 三条规矩：
//
//  1. **参考文献不进翻译单元**（A5）：先把页内的段落从**分段器自己的输出**里还原出来，再判末尾的文献区 ——
//     还原而不是重写切分规则，段落的编号才和分段器一致（重写一份切分规则，两处的编号迟早会漂）。
//  2. **三层的数字必须对得上**：对照件、阅读行、逐页状态都从同一批单元与记录算出来；用例直接断言
//     「行数＝对照件段落数」「逐页状态的已译合计＝对照件已译数」—— 三个说法不一致时，读者不知道该信哪个。
//  3. **术语只查已有译文**（A4）：没译的段落查术语会把每个术语都报成缺失，那是噪声不是发现；
//     所以 `terminologyChecked` 数的是**真的查过**的 (段落, 术语) 对，0 不能读作「术语全对」。

import {
  buildTranslationContrast,
  type ContrastDocument,
  type ContrastKeptParagraph
} from './translation-contrast'
import { translationPageStatuses, type TranslationPageStatus } from './translation-page-status'
import { buildReadingRows, type ReadingRow } from './translation-reading'
import { detectReferenceBlock } from './translation-references'
import { checkTranslationTerminology, type TerminologyDeviation } from './translation-terminology'
import {
  segmentPageIntoTranslationUnits,
  type TranslationRecord,
  type TranslationUnit
} from './translation-units'

export type TranslationViewModelInput = {
  sourceId: string
  /** 源内容哈希（进对照件的可复算头）—— 由调用方给，因为它是存储判据的一部分。 */
  sourceContentHash: string
  /** 每页的文本层。顺序无所谓，按页码归位。 */
  pages: readonly { page: number; text: string }[]
  records: Readonly<Record<string, TranslationRecord>>
  /** 源页数（用来报「有页没进来」与「没有文本层」）。缺省取 `pages` 里最大的页码。 */
  pageCount?: number
  /** 关掉术语校验（默认开）。 */
  checkTerminology?: boolean
}

export type TranslationViewModel = {
  /** 要翻的单元（**已剔除**参考文献区）。 */
  units: TranslationUnit[]
  /** 原样保留的段落（参考文献区），按原位参与渲染与计数。 */
  kept: ContrastKeptParagraph[]
  contrast: ContrastDocument
  rows: ReadingRow[]
  pageStatuses: TranslationPageStatus[]
  deviations: TerminologyDeviation[]
  summary: {
    pages: number
    pageCount: number
    paragraphs: number
    translated: number
    failed: number
    missing: number
    kept: number
    /** 真的查过的 (段落, 术语) 对数。0 ⇒ 「没有被表覆盖的术语」，不是「术语全对」。 */
    terminologyChecked: number
  }
}

/** 把一页的段落从分段器的输出里还原出来（同一段落被切开的几半按序拼回）。 */
const paragraphsOfPage = (
  units: readonly TranslationUnit[]
): { paragraph: number; text: string }[] => {
  const byParagraph = new Map<number, string[]>()
  for (const unit of units) {
    const parts = byParagraph.get(unit.paragraph) ?? []
    parts.push(unit.text)
    byParagraph.set(unit.paragraph, parts)
  }
  return [...byParagraph.entries()]
    .sort(([left], [right]) => left - right)
    .map(([paragraph, parts]) => ({ paragraph, text: parts.join(' ') }))
}

export const buildTranslationViewModel = ({
  sourceId,
  sourceContentHash,
  pages,
  records,
  pageCount,
  checkTerminology = true
}: TranslationViewModelInput): TranslationViewModel => {
  const highestPage = pages.reduce((max, page) => Math.max(max, page.page), 0)
  const declaredPageCount = pageCount ?? highestPage

  const units: TranslationUnit[] = []
  const kept: ContrastKeptParagraph[] = []

  for (const page of [...pages].sort((left, right) => left.page - right.page)) {
    const pageUnits = segmentPageIntoTranslationUnits(page.page, page.text)
    const paragraphs = paragraphsOfPage(pageUnits)
    // 判定跑在**还原出来的段落**上：因此「第几段」与分段器的编号是同一个编号。
    const detection = detectReferenceBlock(paragraphs.map((paragraph) => paragraph.text))
    const block = detection.block
    const referenceParagraphs =
      block === undefined
        ? new Set<number>()
        : new Set(
            paragraphs.slice(block.start, block.end + 1).map((paragraph) => paragraph.paragraph)
          )

    for (const unit of pageUnits) {
      if (referenceParagraphs.has(unit.paragraph)) continue
      units.push(unit)
    }
    for (const paragraph of paragraphs) {
      if (!referenceParagraphs.has(paragraph.paragraph)) continue
      kept.push({ page: page.page, paragraph: paragraph.paragraph, text: paragraph.text })
    }
  }

  const contrast = buildTranslationContrast({
    sourceId,
    sourceContentHash,
    units,
    records,
    sourcePages: declaredPageCount,
    kept
  })
  const rows = buildReadingRows(contrast)
  const pageStatuses = translationPageStatuses({ pageCount: declaredPageCount, units, records })

  // 只查**已有译文**的段落：没译的段落查术语会把每个术语都报成缺失（噪声，不是发现）。
  const translatedRows = rows.filter(
    (row): row is ReadingRow & { translation: { kind: 'translated'; text: string } } =>
      row.translation.kind === 'translated'
  )
  const terminology = checkTerminology
    ? checkTranslationTerminology(
        translatedRows.map((row) => ({
          unitId: row.unitId,
          source: row.source ?? '',
          translated: row.translation.text
        }))
      )
    : { checked: 0, deviations: [] }

  return {
    units,
    kept,
    contrast,
    rows,
    pageStatuses,
    deviations: terminology.deviations,
    summary: {
      pages: contrast.counts.pages,
      pageCount: declaredPageCount,
      paragraphs: contrast.counts.paragraphs,
      translated: contrast.counts.translated,
      failed: contrast.counts.failed,
      missing: contrast.counts.missing,
      kept: contrast.counts.kept,
      terminologyChecked: terminology.checked
    }
  }
}
