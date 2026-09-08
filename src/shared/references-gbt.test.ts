import { describe, expect, it } from 'vitest'

import { formatGbt7714, formatGbt7714List, gbt7714AuthorName, gbt7714Authors } from './references'

const sample = {
  title: 'Attention Is All You Need',
  authors: [
    { name: 'Ashish Vaswani' },
    { name: 'Noam Shazeer' },
    { name: 'Niki Parmar' },
    { name: 'Jakob Uszkoreit' }
  ],
  venue: 'Advances in Neural Information Processing Systems',
  year: 2017,
  doi: '10.48550/arXiv.1706.03762',
  arxivId: '1706.03762',
  pmid: undefined,
  pmcid: undefined
}

describe('GB/T 7714-2015 formatting', () => {
  it('renders western journal records surname-first with dotted initials and [J]', () => {
    const three = { ...sample, authors: sample.authors.slice(0, 3) }
    expect(formatGbt7714(three)).toBe(
      'Vaswani A., Shazeer N., Parmar N. Attention Is All You Need[J]. Advances in Neural Information Processing Systems, 2017. 10.48550/arXiv.1706.03762'
    )
  })

  it('abbreviates 4+ western authors with "et al." after the first three', () => {
    const line = formatGbt7714(sample)
    expect(line).toContain('Vaswani A., Shazeer N., Parmar N. et al.')
    expect(line).not.toContain('Uszkoreit')
  })

  it('keeps CJK author names verbatim and uses 等 for long Chinese lists', () => {
    const chinese = {
      title: '中医古籍知识库构建研究',
      authors: [{ name: '李时珍' }, { name: '张仲景' }, { name: '王清任' }, { name: '陈修园' }],
      venue: '中华医史杂志',
      year: 2024,
      doi: undefined,
      arxivId: undefined,
      pmid: undefined,
      pmcid: undefined
    }
    const line = formatGbt7714(chinese)
    expect(line).toContain('李时珍, 张仲景, 王清任, 等')
    expect(line).toContain('[J]')
  })

  it('renders identifier-only records as [EB/OL] with retrieval date and resolver locator', () => {
    const web = {
      title: 'Protein Data Bank',
      authors: [{ name: 'RCSB' }],
      venue: undefined,
      year: undefined,
      doi: undefined,
      arxivId: undefined,
      pmid: '12345678',
      pmcid: undefined
    }
    expect(formatGbt7714(web, { retrievedAt: '2026-09-08' })).toBe(
      'RCSB. Protein Data Bank[EB/OL]. [2026-09-08]. https://pubmed.ncbi.nlm.nih.gov/12345678/'
    )
  })

  it('orders a numbered list for sequential (顺序编码制) in-text citation', () => {
    const list = formatGbt7714List([sample, { ...sample, title: 'BERT' }])
    expect(list.split('\n')).toHaveLength(2)
    expect(list).toMatch(/^\[1\] /)
    expect(list).toMatch(/\n\[2\] .*BERT/)
  })

  it('normalizes common western name orders', () => {
    expect(gbt7714AuthorName('Smith, John A')).toBe('Smith J. A.')
    expect(gbt7714AuthorName('John A Smith')).toBe('Smith J. A.')
    expect(gbt7714AuthorName('Solo')).toBe('Solo')
    expect(gbt7714AuthorName('张三')).toBe('张三')
  })

  it('joins up to three authors with commas and no ellipsis', () => {
    expect(gbt7714Authors([{ name: 'A' }, { name: 'B' }, { name: 'C' }])).toBe('A, B, C')
    expect(gbt7714Authors([{ name: 'A' }])).toBe('A')
  })
})
