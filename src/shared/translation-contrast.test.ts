import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TRANSLATION_CONTRAST_LABELS,
  TRANSLATION_CONTRAST_RECIPE,
  buildTranslationContrast,
  renderTranslationContrastMarkdown
} from './translation-contrast'
import {
  translationSourceHashInput,
  type TranslationRecord,
  type TranslationUnit
} from './translation-units'

const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex')

const units: TranslationUnit[] = [
  { id: 'p1#1', page: 1, paragraph: 1, text: 'First paragraph.' },
  { id: 'p1#2', page: 1, paragraph: 2, text: 'Second paragraph.' },
  { id: 'p2#1', page: 2, paragraph: 1, text: 'Third paragraph.' }
]

const record = (id: string, text: string): TranslationRecord => ({
  id,
  page: 1,
  sourceHash: 'unused-here',
  status: 'translated',
  text,
  updatedAt: 1
})

const allRecords: Record<string, TranslationRecord> = {
  'p1#1': record('p1#1', '第一段。'),
  'p1#2': record('p1#2', '第二段。'),
  'p2#1': record('p2#1', '第三段。')
}

describe('A7 对照件（原文 / 译文 并列 + 可复算配方）', () => {
  it('全译完：文件头的计数与正文**数得出来**的一致', () => {
    const document = buildTranslationContrast({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      units,
      records: allRecords,
      sourcePages: 2
    })

    expect(document.counts).toEqual({
      pages: 2,
      paragraphs: 3,
      translated: 3,
      failed: 0,
      missing: 0,
      kept: 0,
      sourcePages: 2,
      pagesWithoutParagraphs: []
    })

    const markdown = renderTranslationContrastMarkdown(document)
    // 数一数：正文里的段标题数就是 counts.paragraphs；页标题数就是 counts.pages。
    expect(markdown.match(/^### /gm)?.length).toBe(document.counts.paragraphs)
    expect(markdown.match(/^## 第 /gm)?.length).toBe(document.counts.pages)
    expect(markdown).toContain('- 原文：First paragraph.')
    expect(markdown).toContain('- 译文：第一段。')
  })

  it('半截：没有记录的段落留在原位并被计入，不被静默删掉', () => {
    const { 'p1#2': _dropped, ...partial } = allRecords
    const document = buildTranslationContrast({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      units,
      records: partial,
      sourcePages: 2
    })

    expect(document.counts.missing).toBe(1)
    expect(document.counts.paragraphs).toBe(units.length)

    const markdown = renderTranslationContrastMarkdown(document)
    expect(markdown.match(/^### /gm)?.length).toBe(units.length)
    // 那一段还在，而且明说没有译文 —— 删掉它会让读者以为全文都翻过。
    expect(markdown).toContain('Second paragraph.')
    expect(markdown).toContain('**本段尚无译文**')
  })

  it('失败段落带具名原因；没有原因时也说得出来', () => {
    const document = buildTranslationContrast({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      units,
      records: {
        ...allRecords,
        'p1#2': { id: 'p1#2', page: 1, sourceHash: 'h', status: 'failed', updatedAt: 1 }
      },
      sourcePages: 2
    })

    expect(document.counts).toEqual(
      expect.objectContaining({ translated: 2, failed: 1, missing: 0 })
    )
    const markdown = renderTranslationContrastMarkdown(document)
    expect(markdown).toContain('**未译（失败）** —— 未说明原因')
  })

  it('整页没有段落（例如没有文本层）⇒ 具名列出，并写进文件头', () => {
    const document = buildTranslationContrast({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      units: units.filter((unit) => unit.page === 1),
      records: allRecords,
      sourcePages: 3
    })

    expect(document.counts.pages).toBe(1)
    expect(document.counts.sourcePages).toBe(3)
    expect(document.counts.pagesWithoutParagraphs).toEqual([2, 3])
    expect(renderTranslationContrastMarkdown(document)).toContain('无段落的页：2、3')
  })

  it('长段落被切开的两半挨着排（1.1 在 1.2 之前）', () => {
    const parts: TranslationUnit[] = [
      { id: 'p1#1.1', page: 1, paragraph: 1, part: 1, text: '前半句。' },
      { id: 'p1#1.2', page: 1, paragraph: 1, part: 2, text: '后半句。' },
      { id: 'p1#2', page: 1, paragraph: 2, text: '第二段。' }
    ]
    const document = buildTranslationContrast({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      units: parts,
      records: {
        'p1#1.1': record('p1#1.1', '译前半。'),
        'p1#1.2': record('p1#1.2', '译后半。'),
        'p1#2': record('p1#2', '译第二段。')
      },
      sourcePages: 1
    })

    const markdown = renderTranslationContrastMarkdown(document)
    expect(markdown.indexOf('### 1.1')).toBeLessThan(markdown.indexOf('### 1.2'))
    expect(markdown.indexOf('### 1.2')).toBeLessThan(markdown.indexOf('### 2'))
  })

  it('文件头带配方与源哈希 ⇒ 谁拿到这份对照件都能说出它属于哪一版原文', () => {
    const document = buildTranslationContrast({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      units,
      records: allRecords,
      sourcePages: 2
    })
    const markdown = renderTranslationContrastMarkdown(document)
    expect(markdown).toContain(TRANSLATION_CONTRAST_RECIPE)
    expect(markdown).toContain('hash-1')
  })

  it('对照件里的原文与记录用的是同一套哈希配方（独立复算，shared 不哈希）', () => {
    // 配方输入是公开的（`translationSourceHashInput`），摘要由主进程/复核者算：这里用 node:crypto 独立复算一遍。
    const first = units[0] as TranslationUnit
    const recomputed = sha256Hex(translationSourceHashInput(first.id, first.text))
    const stored = { ...record(first.id, '第一段。'), sourceHash: recomputed }
    const document = buildTranslationContrast({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      units: [first],
      records: { [first.id]: stored },
      sourcePages: 1
    })
    // 对照件里的原文（paragraph.source）算出来的哈希，与记录里存的那个字段一致 ⇒ 两边说的是同一句。
    expect(
      sha256Hex(
        translationSourceHashInput(first.id, document.pages[0]?.paragraphs[0]?.source ?? '')
      )
    ).toBe(stored.sourceHash)
  })

  it('措辞由调用方给 ⇒ 9 语导出有真口子（默认只是中文的兜底）', () => {
    const document = buildTranslationContrast({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      units: [units[0] as TranslationUnit],
      records: { 'p1#1': record('p1#1', '第一段。') },
      sourcePages: 1
    })
    const english = renderTranslationContrastMarkdown(document, {
      ...DEFAULT_TRANSLATION_CONTRAST_LABELS,
      heading: 'Side-by-side',
      originalLabel: 'Original',
      translatedLabel: 'Translation',
      pageHeading: (page) => `Page ${page}`
    })
    expect(english).toContain('# Side-by-side · paper-1')
    expect(english).toContain('## Page 1')
    expect(english).toContain('- Original：First paragraph.')
    expect(english).toContain('- Translation：第一段。')
    expect(english).not.toContain('对照件')
  })

  it('A5 参考文献：原样保留的段落出现在原位、原文逐字、并与「未译」分开计数', () => {
    const reference = '[1] Smith J. A trial of aspirin. N Engl J Med. 2001;345(3): 245-253.'
    const document = buildTranslationContrast({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      units: [units[0] as TranslationUnit],
      records: { 'p1#1': record('p1#1', '第一段。') },
      sourcePages: 1,
      kept: [{ page: 1, paragraph: 2, text: reference }]
    })

    // 计入 paragraphs 与 kept，**不计入** missing ——「有意不译」不是「还没译」。
    expect(document.counts).toMatchObject({ paragraphs: 2, translated: 1, kept: 1, missing: 0 })
    const keptParagraph = document.pages[0]?.paragraphs[1]
    expect(keptParagraph).toMatchObject({ status: 'kept', paragraph: 2, source: reference })

    const markdown = renderTranslationContrastMarkdown(document)
    // 导出件里参考文献**仍是原文**（逐字），并明说这一条不翻译。
    expect(markdown).toContain(reference)
    expect(markdown).toContain('**原文保留**（参考文献不翻译）')
    expect(markdown).toContain('原样保留 1')
  })

  it('A5 保留段落不参与翻译单元的哈希与记录（它压根不是单元）', () => {
    const document = buildTranslationContrast({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      units: [],
      records: {},
      sourcePages: 1,
      kept: [{ page: 1, paragraph: 1, text: '[1] Foo A. Title. 2001;12: 3-9.' }]
    })
    expect(document.counts).toMatchObject({ paragraphs: 1, kept: 1, missing: 0 })
    // 保留段落的 id 与翻译单元区分开（前缀 kept-），所以它永远不会被当成「有记录但缺译文」。
    expect(document.pages[0]?.paragraphs[0]?.unitId.startsWith('kept-')).toBe(true)
  })

  it('译文里的竖线与换行不会把对照件拆坏', () => {
    const document = buildTranslationContrast({
      sourceId: 'paper-1',
      sourceContentHash: 'hash-1',
      units: [units[0] as TranslationUnit],
      records: { 'p1#1': record('p1#1', '第一行\n第二行 | 带竖线') },
      sourcePages: 1
    })
    const markdown = renderTranslationContrastMarkdown(document)
    expect(markdown).toContain('第一行 第二行 \\| 带竖线')
  })
})
