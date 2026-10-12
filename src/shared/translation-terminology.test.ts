import { describe, expect, it } from 'vitest'

import { CHINESE_TERMS } from './chinese-terms'
import {
  acceptedSpellings,
  checkTranslationTerminology,
  chineseSpellingPresent,
  englishTermOccursIn
} from './translation-terminology'

// 夹具全部取自那张表里的**真实行**（不编造术语对），断言里连认可的写法一起写死 ——
// 判据可复查的前提是：表改了而这里没改时，用例会红。
describe('A4 译文术语一致性（判据＝仓库唯一那张中文术语表）', () => {
  it('抽查三个术语：译文用了表里的写法 ⇒ 一致，且报出「查了几条」', () => {
    const check = checkTranslationTerminology([
      {
        unitId: 'p1#1',
        source: 'Aspirin was given to every participant.',
        translated: '所有受试者都接受了阿司匹林。'
      },
      {
        unitId: 'p1#2',
        source: 'We pooled the results in a meta-analysis.',
        translated: '我们用荟萃分析合并了结果。'
      },
      {
        unitId: 'p2#1',
        source: 'A randomized controlled trial was conducted.',
        translated: '开展了一项随机对照试验。'
      }
    ])

    expect(check.deviations).toEqual([])
    // 0 条偏离**配上查了 3 条**才读作「一致」。
    expect(check.checked).toBe(3)
  })

  it('造一条偏离：被具名标注（哪一段、哪个术语、该用哪些写法）', () => {
    const check = checkTranslationTerminology([
      {
        unitId: 'p3#7',
        source: 'Patients received aspirin daily.',
        translated: '患者每天服用布洛芬。'
      }
    ])

    expect(check.deviations).toEqual([
      { unitId: 'p3#7', english: 'aspirin', accepted: ['阿司匹林', '乙酰水杨酸'] }
    ])
    expect(check.checked).toBe(1)
  })

  it('用 variant 写也算一致（只认一种写法会把规范译名判成错）', () => {
    const check = checkTranslationTerminology([
      {
        unitId: 'p1#1',
        source: 'Aspirin was given.',
        translated: '给予了乙酰水杨酸。'
      },
      {
        unitId: 'p1#2',
        source: 'A meta-analysis of the trials.',
        translated: '对这些试验做了元分析。'
      }
    ])

    expect(check.deviations).toEqual([])
    expect(check.checked).toBe(2)
  })

  it('源文里的形态差异照认：大小写、连字符、复数', () => {
    expect(englishTermOccursIn('aspirin', 'ASPIRIN')).toBe(true)
    expect(
      englishTermOccursIn(
        'randomized controlled trial',
        'Randomized-controlled TRIALS were included.'
      )
    ).toBe(true)
    expect(englishTermOccursIn('meta-analysis', 'meta analysis')).toBe(true)
    // 复数后缀只挂最后一个词上：不该把 trialss 这种拼法当成命中。
    expect(englishTermOccursIn('trial', 'trials')).toBe(true)
    expect(englishTermOccursIn('trial', 'trialss')).toBe(false)
    // 词边界：不能把另一张表里的更短词substring 命中当成本术语出现。
    expect(englishTermOccursIn('trial', 'industrial')).toBe(false)
  })

  it('源文里没提的术语不参与判定（否则会把「没人提过」报成「译文漏了」）', () => {
    const check = checkTranslationTerminology([
      { unitId: 'p1#1', source: 'Only aspirin appears here.', translated: '这里只出现了阿司匹林。' }
    ])
    // 那张表有几百行，但只有真的出现在源文里的那一条被查过。
    expect(CHINESE_TERMS.length).toBeGreaterThan(100)
    expect(check.checked).toBe(1)
    expect(check.deviations).toEqual([])
  })

  it('一条都没查过时，结果只能读作「没有被表覆盖的术语」，不能读作「全部一致」', () => {
    const check = checkTranslationTerminology([
      {
        unitId: 'p1#1',
        source: 'Nothing in here is a table term.',
        translated: '这里没有表里的术语。'
      }
    ])
    expect(check).toEqual({ checked: 0, deviations: [] })
    // 这条用例的意义就是把这句话钉在代码里：`deviations: []` 单独出现时不足以说明「一致」。
  })

  it('偏离按段落归属：同一个术语在两个段落里，只有没写对的那一段被标注', () => {
    const check = checkTranslationTerminology([
      { unitId: 'p1#1', source: 'Aspirin was used.', translated: '使用了阿司匹林。' },
      { unitId: 'p1#2', source: 'Aspirin was used again.', translated: '再次使用了对乙酰氨基酚。' }
    ])
    expect(check.checked).toBe(2)
    expect(check.deviations.map((deviation) => deviation.unitId)).toEqual(['p1#2'])
  })

  it('更长的术语与它的子串术语可以同时满足（网络荟萃分析 含 荟萃分析）', () => {
    const check = checkTranslationTerminology([
      {
        unitId: 'p1#1',
        source: 'We ran a network meta-analysis.',
        translated: '我们做了网络荟萃分析。'
      }
    ])
    expect(check.deviations).toEqual([])
    expect(check.checked).toBe(2)
  })

  it('认可的写法来自表本身，且去重（canonical 在前）', () => {
    const row = CHINESE_TERMS.find(
      (entry): entry is { canonical: string; kind: string; english: string; variants?: string[] } =>
        'english' in entry && entry.english === 'aspirin'
    )
    expect(row).toBeDefined()
    expect(acceptedSpellings(row as never)).toEqual(['阿司匹林', '乙酰水杨酸'])
    expect(chineseSpellingPresent('阿司匹林', '每天服用 阿司匹林 一次')).toBe(true)
    expect(chineseSpellingPresent('阿司匹林', '每天服用布洛芬')).toBe(false)
  })
})
