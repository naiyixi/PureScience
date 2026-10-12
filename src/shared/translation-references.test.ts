import { describe, expect, it } from 'vitest'

import {
  detectReferenceBlock,
  isReferenceEntry,
  splitReferenceParagraphs
} from './translation-references'

// 夹具用**真实形态**的文献条目（编号 + 年份/卷期页/DOI 各一路），以及几条容易误判的正文。
const entries = [
  '[1] Smith J, Doe A. A randomized controlled trial of aspirin. N Engl J Med. 2001;345(3): 245-253.',
  '[2] Chen L, et al. Meta-analysis of magnetic resonance imaging. Lancet. 2015;386: 1000-1010.',
  '[3] Wang Q. Deep learning for protein structure. Nature. 2020. doi:10.1038/s41586-020-1234-5'
]

describe('A5 参考文献判定（保守：假阳会丢内容，假阴只是混了中文）', () => {
  it('真实形态的文献条目认得出（编号 + 书目信号）', () => {
    for (const entry of entries) expect(isReferenceEntry(entry)).toBe(true)
    // 年份、卷(期): 页、DOI、et al. 四种信号各自都能单独成立。
    expect(isReferenceEntry('12. Foo B. Title. J. Bar. 1998;12: 3-9.')).toBe(true)
    expect(isReferenceEntry('(4) Baz C. Title. 2011. doi:10.1000/xyz')).toBe(true)
  })

  it('只有引文标记的正文段落**不**当文献（否则会跳过一整段内容）', () => {
    // 正文里句中带引用标记是极常见的，光凭它跳过整段是在拿内容赌博。
    expect(
      isReferenceEntry('As shown in [12], the effect was significant in every cohort we examined.')
    ).toBe(false)
    expect(
      isReferenceEntry(
        '12. This sentence is ordinary prose about the trial design and its outcomes.'
      )
    ).toBe(false)
  })

  it('只有书目信号的正文段落也不当文献', () => {
    expect(isReferenceEntry('The study was conducted in (2001) and repeated in (2003).')).toBe(
      false
    )
    expect(isReferenceEntry('We compared 12(3): 45-67 style page ranges across journals.')).toBe(
      false
    )
  })

  it('末尾连续 ≥2 条 ⇒ 认定文献区，给出要跳过的区间', () => {
    const paragraphs = ['Body paragraph one.', 'Body paragraph two.', ...entries]
    const detection = detectReferenceBlock(paragraphs)
    expect(detection.reason).toBe('numbered-block')
    expect(detection.entries).toEqual([2, 3, 4])
    expect(detection.block).toEqual({ start: 2, end: 4 })
  })

  it('末尾只有一条 ⇒ **报出来但不跳过**（很可能只是正文最后一句）', () => {
    const paragraphs = ['Body paragraph one.', entries[0] as string]
    const detection = detectReferenceBlock(paragraphs)
    expect(detection.reason).toBe('single-entry')
    expect(detection.block).toBeUndefined()
    expect(detection.entries).toEqual([1])
  })

  it('正文中间的条目不成区（文献区在正文之后）', () => {
    const paragraphs = [
      entries[0] as string,
      'Body paragraph about the method.',
      entries[1] as string
    ]
    const detection = detectReferenceBlock(paragraphs)
    // 末尾那一条是孤条 ⇒ 不跳过；中间那条也不因为「像文献」就被单独跳过。
    expect(detection.reason).toBe('single-entry')
    expect(detection.block).toBeUndefined()
  })

  it('分流：要翻的段落与保留的段落各自保持原顺序', () => {
    const paragraphs = [
      'Body paragraph one.',
      'Body paragraph two.',
      entries[0] as string,
      entries[1] as string
    ]
    const split = splitReferenceParagraphs(paragraphs)
    expect(split.translatable.map((item) => item.index)).toEqual([0, 1])
    expect(split.kept.map((item) => item.index)).toEqual([2, 3])
    // 保留的段落原文**逐字未动**（这就是「导出件里参考文献仍是原文」的实现方式）。
    expect(split.kept.map((item) => item.text)).toEqual([entries[0], entries[1]])
  })

  it('没有文献区时，全部段落都进要翻的那一半', () => {
    const paragraphs = ['Only body text here.', 'And more body text.']
    const split = splitReferenceParagraphs(paragraphs)
    expect(split.detection.reason).toBe('none')
    expect(split.kept).toEqual([])
    expect(split.translatable.map((item) => item.index)).toEqual([0, 1])
  })

  it('空段落与空输入都判 none（不制造文献区）', () => {
    expect(detectReferenceBlock([])).toEqual({ entries: [], reason: 'none' })
    expect(detectReferenceBlock(['', '   '])).toEqual({ entries: [], reason: 'none' })
    expect(isReferenceEntry('')).toBe(false)
  })
})
