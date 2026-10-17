import { describe, expect, it } from 'vitest'
import { formatRisEntry, formatRisList } from './ris'
import type { CitationItem } from './types'

const article: CitationItem = {
  title: 'Aspirin in secondary prevention',
  authors: [{ name: 'John A Smith' }, { name: '张三' }],
  containerTitle: 'Lancet',
  year: 2023,
  volume: '401',
  issue: '10375',
  pages: '123-130',
  doi: '10.1000/xyz123',
  pmid: '12345678',
  itemType: 'journal-article'
}

describe('RIS export', () => {
  it('writes a complete journal record with one tag per line', () => {
    const formatted = formatRisEntry(article)
    expect(formatted.styleId).toBe('ris')
    expect(formatted.text).toBe(
      [
        'TY  - JOUR',
        'AU  - Smith, John A',
        'AU  - 张三',
        'TI  - Aspirin in secondary prevention',
        'T2  - Lancet',
        'PY  - 2023',
        'VL  - 401',
        'IS  - 10375',
        'SP  - 123',
        'EP  - 130',
        'DO  - 10.1000/xyz123',
        'AN  - PMID:12345678',
        'ER  - ',
        ''
      ].join('\n')
    )
    expect(formatted.warnings).toEqual([])
  })

  it('writes a page range as its two halves and a single page as one', () => {
    expect(formatRisEntry({ ...article, pages: '123-130' }).text).toContain('SP  - 123\nEP  - 130')
    const single = formatRisEntry({ ...article, pages: '77' }).text
    expect(single).toContain('SP  - 77')
    expect(single).not.toContain('EP  - ')
  })

  it('omits a value it does not have and names the omission', () => {
    const formatted = formatRisEntry({
      title: 'Untitled work',
      authors: [],
      itemType: 'journal-article'
    })
    expect(formatted.warnings).toEqual(['field:authors', 'field:containerTitle', 'field:year'])
    expect(formatted.text).not.toContain('PY  - ')
    expect(formatted.text).not.toContain('T2  - ')
  })

  it('marks a preprint as a preprint rather than a journal article', () => {
    const formatted = formatRisEntry({
      title: 'A preprint',
      authors: [{ name: 'Wang Fang' }],
      year: 2024,
      arxivId: '2401.00001',
      itemType: 'preprint'
    })
    expect(formatted.text.startsWith('TY  - GEN')).toBe(true)
    expect(formatted.text).toContain('AN  - arXiv:2401.00001')
    expect(formatted.text).toContain('M3  - Preprint')
    expect(formatted.text).not.toContain('TY  - JOUR')
  })

  it('says when a type had no faithful mapping', () => {
    const formatted = formatRisEntry({ title: 'Something', authors: [{ name: 'A B' }], year: 2020 })
    expect(formatted.warnings).toContain('type:unknown-as-gen')
    expect(formatted.text.startsWith('TY  - GEN')).toBe(true)
  })

  it('separates records with one blank line and ends every record with ER', () => {
    const text = formatRisList([article, { ...article, title: 'A second study' }])
    const records = text.split('\n\n')
    expect(records).toHaveLength(2)
    expect(records[0].endsWith('ER  - ')).toBe(true)
    expect(records[1].startsWith('TY  - JOUR')).toBe(true)
    expect(formatRisList([article, { ...article, title: 'A second study' }])).toBe(text)
  })
})
