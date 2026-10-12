import { describe, expect, it } from 'vitest'

import { buildTranslationViewModel } from './translation-view-model'
import type { TranslationRecord } from './translation-units'

const body = 'First body paragraph.\n\nSecond body paragraph, with aspirin in it.'
const references =
  '\n\n[1] Smith J. A trial of aspirin. N Engl J Med. 2001;345(3): 245-253.\n\n[2] Chen L, et al. Meta-analysis of imaging. Lancet. 2015;386: 1000-1010.'

const record = (id: string, page: number, text: string): TranslationRecord => ({
  id,
  page,
  sourceHash: 'h',
  status: 'translated',
  text,
  updatedAt: 1
})

describe('A 线视图模型：一次组装出面板与导出件要的全部东西', () => {
  it('参考文献不进翻译单元（按分段器自己的编号判），并作为 kept 参与渲染与计数', () => {
    const model = buildTranslationViewModel({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      pages: [{ page: 1, text: `${body}${references}` }],
      records: {
        'p1#1': record('p1#1', 1, '第一段正文。'),
        'p1#2': record('p1#2', 1, '第二段正文，含阿司匹林。')
      },
      pageCount: 1
    })

    // 正文两段进单元，文献两条不进。
    expect(model.units.map((unit) => unit.id)).toEqual(['p1#1', 'p1#2'])
    // 文献条目按**原来的段号**保留下来（3、4），且原文逐字（两半拼回时用空格）。
    expect(model.kept.map((entry) => [entry.page, entry.paragraph])).toEqual([
      [1, 3],
      [1, 4]
    ])
    expect(model.kept[0]?.text).toContain('[1] Smith J.')
    expect(model.contrast.counts).toMatchObject({
      paragraphs: 4,
      translated: 2,
      kept: 2,
      missing: 0
    })
    // 逐页状态里，文献**不算未译**（它不是待办）。
    expect(model.pageStatuses[0]).toMatchObject({
      kind: 'translated',
      paragraphs: 2,
      translated: 2
    })
  })

  it('三层的数字对得上：行数＝对照件段落数，逐页已译合计＝对照件已译数', () => {
    const model = buildTranslationViewModel({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      pages: [
        { page: 1, text: 'One.\n\nTwo.' },
        { page: 2, text: 'Three.' }
      ],
      records: { 'p1#1': record('p1#1', 1, '一。'), 'p2#1': record('p2#1', 2, '三。') },
      pageCount: 3
    })

    expect(model.rows).toHaveLength(model.contrast.counts.paragraphs)
    const statuses = model.pageStatuses
    expect(statuses.map((status) => status.page)).toEqual([1, 2, 3])
    expect(statuses.reduce((total, status) => total + status.translated, 0)).toBe(
      model.contrast.counts.translated
    )
    expect(statuses.reduce((total, status) => total + status.missing, 0)).toBe(
      model.contrast.counts.missing
    )
    // 第 3 页没有文本层：两层都要说出这件事（对照件列出无段落的页，逐页状态给 no-text-layer）。
    expect(statuses[2]?.kind).toBe('no-text-layer')
    expect(model.contrast.counts.pagesWithoutParagraphs).toEqual([3])
    expect(model.summary).toMatchObject({
      pages: 2,
      pageCount: 3,
      paragraphs: 3,
      translated: 2,
      missing: 1
    })
  })

  it('术语只查已有译文：没译的段落不产生噪声偏离', () => {
    const model = buildTranslationViewModel({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      pages: [{ page: 1, text: 'Aspirin was given.\n\nAspirin was given again.' }],
      records: {
        'p1#1': record('p1#1', 1, '给予了阿司匹林。')
        // p1#2 没有记录 ⇒ 它不该被拿去查术语
      },
      pageCount: 1
    })

    expect(model.deviations).toEqual([])
    // 只查了 p1#1 的那一处 aspirin。
    expect(model.summary.terminologyChecked).toBe(1)
  })

  it('术语偏离在视图模型里也具名（与面板用的是同一份判据）', () => {
    const model = buildTranslationViewModel({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      pages: [{ page: 1, text: 'Aspirin was given.' }],
      records: { 'p1#1': record('p1#1', 1, '给予了布洛芬。') },
      pageCount: 1
    })

    expect(model.deviations).toEqual([
      { unitId: 'p1#1', english: 'aspirin', accepted: ['阿司匹林', '乙酰水杨酸'] }
    ])
    expect(model.summary.terminologyChecked).toBe(1)
  })

  it('关掉术语校验时如实回 0（不假装查过）', () => {
    const model = buildTranslationViewModel({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      pages: [{ page: 1, text: 'Aspirin was given.' }],
      records: { 'p1#1': record('p1#1', 1, '给予了布洛芬。') },
      pageCount: 1,
      checkTerminology: false
    })
    expect(model.deviations).toEqual([])
    expect(model.summary.terminologyChecked).toBe(0)
  })

  it('同一份输入算出同一份输出（没有时间/随机）', () => {
    const input = {
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      pages: [{ page: 1, text: `${body}${references}` }],
      records: { 'p1#1': record('p1#1', 1, '第一段正文。') },
      pageCount: 1
    }
    expect(buildTranslationViewModel(input)).toEqual(buildTranslationViewModel(input))
  })
})
