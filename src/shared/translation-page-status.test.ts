import { describe, expect, it } from 'vitest'

import {
  TRANSLATION_PAGE_LABEL_KEYS,
  translationPageStatusCounts,
  translationPageStatuses
} from './translation-page-status'
import type { TranslationRecord, TranslationUnit } from './translation-units'

const units: TranslationUnit[] = [
  { id: 'p1#1', page: 1, paragraph: 1, text: 'First paragraph.' },
  { id: 'p1#2', page: 1, paragraph: 2, text: 'Second paragraph.' },
  { id: 'p2#1', page: 2, paragraph: 1, text: 'Third paragraph.' }
]

const ok = (id: string, page: number, text: string): TranslationRecord => ({
  id,
  page,
  sourceHash: 'h',
  status: 'translated',
  text,
  updatedAt: 1
})

const failed = (id: string, page: number): TranslationRecord => ({
  id,
  page,
  sourceHash: 'h',
  status: 'failed',
  reason: '端点超时',
  updatedAt: 1
})

describe('A6 逐页状态：没有文本层是一个**事实**，不是一个失败', () => {
  it('没有段落的页 ⇒ 明说没有文本层（带着段落数 0 这条判据）', () => {
    // 三页的文档，但第 3 页一个段落都没有（扫描件/纯图页）。
    const statuses = translationPageStatuses({
      pageCount: 3,
      units,
      records: {
        'p1#1': ok('p1#1', 1, '第一段。'),
        'p1#2': ok('p1#2', 1, '第二段。'),
        'p2#1': ok('p2#1', 2, '第三段。')
      }
    })

    expect(statuses).toHaveLength(3)
    expect(statuses[2]).toEqual({
      page: 3,
      kind: 'no-text-layer',
      paragraphs: 0,
      translated: 0,
      failed: 0,
      missing: 0,
      labelKey: 'translation.page.noTextLayer'
    })
    expect(statuses[0]?.kind).toBe('translated')
    expect(statuses[1]?.kind).toBe('translated')
  })

  it('有段落但还没翻 ⇒ untranslated（与「没有文本层」是两件事，都显示 0/0 时最容易糊）', () => {
    const statuses = translationPageStatuses({ pageCount: 2, units, records: {} })
    expect(statuses[0]?.kind).toBe('untranslated')
    expect(statuses[0]?.paragraphs).toBe(2)
    expect(statuses[0]?.labelKey).toBe('translation.page.untranslated')
    // 对照：第 3 页那种没有段落的情况才是 no-text-layer，两者键不同、数字也不同。
    expect(statuses[0]?.kind).not.toBe('no-text-layer')
  })

  it('部分译完 ⇒ partial，并且四个数字都对得上', () => {
    const statuses = translationPageStatuses({
      pageCount: 1,
      units,
      records: { 'p1#1': ok('p1#1', 1, '第一段。') }
    })
    expect(statuses[0]).toEqual({
      page: 1,
      kind: 'partial',
      paragraphs: 2,
      translated: 1,
      failed: 0,
      missing: 1,
      labelKey: 'translation.page.partial'
    })
  })

  it('整页段落全部失败 ⇒ failed（与「还没开始」修法不同）', () => {
    const statuses = translationPageStatuses({
      pageCount: 1,
      units,
      records: { 'p1#1': failed('p1#1', 1), 'p1#2': failed('p1#2', 1) }
    })
    expect(statuses[0]).toMatchObject({ kind: 'failed', translated: 0, failed: 2, missing: 0 })
    expect(statuses[0]?.labelKey).toBe(TRANSLATION_PAGE_LABEL_KEYS.failed)
  })

  it('「翻过但是空文本」不算已译（空译文不是结果）', () => {
    const statuses = translationPageStatuses({
      pageCount: 1,
      units,
      records: { 'p1#1': ok('p1#1', 1, ''), 'p1#2': ok('p1#2', 1, '第二段。') }
    })
    expect(statuses[0]).toMatchObject({ kind: 'partial', translated: 1, missing: 1 })
  })

  it('首行汇总：每一类各几页，且总数等于页数', () => {
    const statuses = translationPageStatuses({
      pageCount: 4,
      units,
      records: { 'p1#1': ok('p1#1', 1, '第一段。') }
    })
    const counts = translationPageStatusCounts(statuses)
    expect(counts).toEqual({
      'no-text-layer': 2,
      untranslated: 1,
      partial: 1,
      translated: 0,
      failed: 0
    })
    // 逐页状态覆盖 1..pageCount，一页不落（否则「整篇都看了」这句话没有证据）。
    expect(statuses.map((status) => status.page)).toEqual([1, 2, 3, 4])
    expect(Object.values(counts).reduce((total, value) => total + value, 0)).toBe(4)
  })
})
