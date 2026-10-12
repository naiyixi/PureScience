import { describe, expect, it } from 'vitest'

import { buildTranslationContrast } from './translation-contrast'
import {
  TRANSLATION_READING_COLUMNS,
  buildReadingRows,
  readingCellsForMode,
  readingRowAlignment,
  readingRowIndexForUnit
} from './translation-reading'
import type { TranslationRecord, TranslationUnit } from './translation-units'

const units: TranslationUnit[] = [
  { id: 'p1#1', page: 1, paragraph: 1, text: 'First paragraph.' },
  { id: 'p1#2', page: 1, paragraph: 2, text: 'Second paragraph.' },
  { id: 'p2#1', page: 2, paragraph: 1, text: 'Third paragraph.' }
]

const translated = (id: string, page: number, text: string): TranslationRecord => ({
  id,
  page,
  sourceHash: 'h',
  status: 'translated',
  text,
  updatedAt: 1
})

const document = (
  records: Record<string, TranslationRecord>
): ReturnType<typeof buildTranslationContrast> =>
  buildTranslationContrast({
    sourceId: 'paper-1',
    sourceContentHash: 'hash-1',
    units,
    records,
    sourcePages: 2
  })

const allTranslated = document({
  'p1#1': translated('p1#1', 1, '第一段。'),
  'p1#2': translated('p1#2', 1, '第二段。'),
  'p2#1': translated('p2#1', 2, '第三段。')
})

describe('A2/A3 三模式阅读：行、列与回跳锚', () => {
  it('三种模式共用同一批行（行的个数与顺序都一样）', () => {
    const rows = buildReadingRows(allTranslated)
    expect(rows.map((row) => row.unitId)).toEqual(['p1#1', 'p1#2', 'p2#1'])
    expect(rows.map((row) => row.rowIndex)).toEqual([0, 1, 2])
    // 顺序＝文档顺序：页升序、段升序（不重排）。
    expect(rows.map((row) => [row.page, row.paragraph])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1]
    ])
  })

  it('列可见性：原文模式只有原文列，译文模式只有译文列，对照模式两列都在', () => {
    const row = buildReadingRows(allTranslated)[0]!
    expect(readingCellsForMode(row, 'source')).toEqual({ source: 'First paragraph.' })
    expect(readingCellsForMode(row, 'translated')).toEqual({
      translation: { kind: 'translated', text: '第一段。' }
    })
    expect(readingCellsForMode(row, 'contrast')).toEqual({
      source: 'First paragraph.',
      translation: { kind: 'translated', text: '第一段。' }
    })
    expect(TRANSLATION_READING_COLUMNS.source).toEqual({ source: true, translation: false })
    expect(TRANSLATION_READING_COLUMNS.translated).toEqual({ source: false, translation: true })
    expect(TRANSLATION_READING_COLUMNS.contrast).toEqual({ source: true, translation: true })
  })

  it('对照模式的对齐是结构性的：第 i 行两列来自**同一个** unitId（没有需要同步的两条滚动位置）', () => {
    const alignment = readingRowAlignment(allTranslated)
    expect(alignment).toEqual([
      { rowIndex: 0, unitId: 'p1#1' },
      { rowIndex: 1, unitId: 'p1#2' },
      { rowIndex: 2, unitId: 'p2#1' }
    ])
    // 行号唯一 ⇒ 两列各取一次同一行号，取到的必然是同一段。
    expect(new Set(alignment.map((entry) => entry.rowIndex)).size).toBe(alignment.length)
  })

  it('未译与失败的段落照样占一行（塌掉会让两列从此错位）', () => {
    const rows = buildReadingRows(
      document({
        'p1#1': translated('p1#1', 1, '第一段。')
        // p1#2 没有记录；p2#1 记为失败
      })
    )
    expect(rows).toHaveLength(units.length)
    expect(rows[1]?.translation).toEqual({ kind: 'missing' })
    expect(rows[2]?.translation).toEqual({ kind: 'missing' })

    const withFailure = buildReadingRows(
      document({
        'p1#1': translated('p1#1', 1, '第一段。'),
        'p2#1': {
          id: 'p2#1',
          page: 2,
          sourceHash: 'h',
          status: 'failed',
          reason: '端点超时',
          updatedAt: 1
        }
      })
    )
    expect(withFailure[2]?.translation).toEqual({ kind: 'failed', reason: '端点超时' })
    // 没有原因的失败也说得出话（不显示空白）。
    const noReason = buildReadingRows(
      document({ 'p2#1': { id: 'p2#1', page: 2, sourceHash: 'h', status: 'failed', updatedAt: 1 } })
    )
    expect(noReason[2]?.translation).toEqual({ kind: 'failed', reason: '未说明原因' })
  })

  it('A3 回跳锚：点某段译文落回**同一行**的原文格子；查不到就不猜', () => {
    const rows = buildReadingRows(allTranslated)
    expect(readingRowIndexForUnit(rows, 'p1#2')).toBe(1)
    // 锚在两种列里是同一个行号 —— 这就是「点译文回到原文那一段」的实现方式。
    expect(rows[1]?.source).toBe('Second paragraph.')
    // 不认识 / 空的 unitId ⇒ undefined（就近取一行会让读者以为跳对了）。
    expect(readingRowIndexForUnit(rows, 'p9#9')).toBeUndefined()
    expect(readingRowIndexForUnit(rows, '')).toBeUndefined()
  })

  it('原文缺失的段落仍占一行，但不编原文', () => {
    const noSourceUnits: TranslationUnit[] = [{ id: 'p1#1', page: 1, paragraph: 1, text: '' }]
    const doc = buildTranslationContrast({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      units: noSourceUnits,
      records: { 'p1#1': translated('p1#1', 1, '第一段。') },
      sourcePages: 1
    })
    const row = buildReadingRows(doc)[0]!
    expect(row.source).toBe('')
    expect(readingCellsForMode(row, 'source')).toEqual({ source: '' })
    expect(readingCellsForMode(row, 'contrast').translation).toEqual({
      kind: 'translated',
      text: '第一段。'
    })
  })
})
