// A2 + A3 的判据层：三种阅读模式的**同一批行**，以及「点译文段 → 回跳原文那一行」的锚。
//
// 这一层要回答的是 A2「对照模式滚动同步」到底怎么保证。答案是**结构性的**，不是事件驱动的：
//
//   原文列与译文列**共用同一批行**（一行 = 一段）。两列之间不存在「两条各自滚动的滚动位置」，
//   所以也没有需要同步的时机 —— 一行的高度取两列中较高的那个，行与行永远对齐。
//   事件驱动式的「滚动时互相追」反而会在慢帧里露馅（追的动作看得见）。
//
// 三条规矩：
//
//  1. **未译/失败的段落照样占一行**。把它们塌掉（不渲染）会让两列从此错位一格，而且错位会越滚越远 ——
//     这正是「一起渲染、按行对齐」要防的事。
//  2. **行的顺序就是文档的顺序**（页升序、段内 part 升序），不重排：读者看到的次序必须和原文一致。
//  3 **回跳锚就是行号**（A3）：点某一段的译文，要落回**同一行**的原文格子。锚由 unitId 查得，
//     查不到就 `undefined`（不猜、不就近取一行 —— 就近会让读者以为跳对了）。

import type { ContrastDocument, ContrastParagraph } from './translation-contrast'

export const TRANSLATION_READING_MODES = ['source', 'translated', 'contrast'] as const

export type TranslationReadingMode = (typeof TRANSLATION_READING_MODES)[number]

/** 每种模式显示哪几列。三种模式**只有列的可见性不同**，行与锚完全一样。 */
export const TRANSLATION_READING_COLUMNS: Record<
  TranslationReadingMode,
  { source: boolean; translation: boolean }
> = {
  source: { source: true, translation: false },
  translated: { source: false, translation: true },
  contrast: { source: true, translation: true }
}

export type ReadingTranslationCell =
  | { kind: 'translated'; text: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'missing' }
  /** 原样保留（参考文献）：不是「没译」，是**有意不译**。 */
  | { kind: 'kept' }

export type ReadingRow = {
  /** 在整份对照件里的行号（两列共用；A3 的回跳目标就是它）。 */
  rowIndex: number
  unitId: string
  page: number
  paragraph: number
  part?: number
  /** 原文格子。缺原文时如实为 undefined（不编）。 */
  source?: string
  translation: ReadingTranslationCell
}

const cellOf = (paragraph: ContrastParagraph): ReadingTranslationCell => {
  if (paragraph.status === 'translated')
    return { kind: 'translated', text: paragraph.translated ?? '' }
  if (paragraph.status === 'failed')
    return { kind: 'failed', reason: paragraph.reason ?? '未说明原因' }
  if (paragraph.status === 'kept') return { kind: 'kept' }
  return { kind: 'missing' }
}

/** 把对照件摊成阅读用的行（页顺序 → 段顺序 → part 顺序，原样不重排）。 */
export const buildReadingRows = (document: ContrastDocument): ReadingRow[] => {
  const rows: ReadingRow[] = []
  for (const page of document.pages) {
    for (const paragraph of page.paragraphs) {
      rows.push({
        rowIndex: rows.length,
        unitId: paragraph.unitId,
        page: paragraph.page,
        paragraph: paragraph.paragraph,
        ...(paragraph.part !== undefined ? { part: paragraph.part } : {}),
        ...(paragraph.source !== undefined ? { source: paragraph.source } : {}),
        translation: cellOf(paragraph)
      })
    }
  }
  return rows
}

/**
 * A3 的回跳锚：某一段落在第几行。查不到就 `undefined`。
 *
 * 两种真需要解释的输入都不猜：没有这一段（例如译文来自另一版原文）⇒ undefined；空 id ⇒ undefined。
 */
export const readingRowIndexForUnit = (
  rows: readonly ReadingRow[],
  unitId: string
): number | undefined => {
  if (unitId === '') return undefined
  const row = rows.find((candidate) => candidate.unitId === unitId)
  return row?.rowIndex
}

/** 这一行在给定模式下要渲染的格子（原文 / 译文 / 两者）。缺的那一侧返回 undefined，不返回空串。 */
export const readingCellsForMode = (
  row: ReadingRow,
  mode: TranslationReadingMode
): { source?: string; translation?: ReadingTranslationCell } => {
  const columns = TRANSLATION_READING_COLUMNS[mode]
  return {
    ...(columns.source && row.source !== undefined ? { source: row.source } : {}),
    ...(columns.translation ? { translation: row.translation } : {})
  }
}

/**
 * 对照模式下两列的对齐关系：第 i 行的两列格子属于**同一段**。
 * 导出成表是为了让它可断言 —— 对齐不是「看起来对齐」，而是同一行号的两个格子来自同一个 unitId。
 */
export const readingRowAlignment = (
  document: ContrastDocument
): { rowIndex: number; unitId: string }[] =>
  buildReadingRows(document).map((row) => ({ rowIndex: row.rowIndex, unitId: row.unitId }))
