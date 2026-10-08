import { describe, expect, it } from 'vitest'

import { formatGbt7714 } from '../references'
import {
  compareCitationStyles,
  citationItemFromReference,
  formatCitation,
  formatCitationList,
  inferCitationItemType
} from './format'
import type { CitationItem } from './types'

const journalRecord = {
  title: 'Deep learning for protein design',
  authors: [
    { name: 'Wei Zhang' },
    { name: 'Li Chen' },
    { name: 'John A. Smith' },
    { name: 'Mei Huang' }
  ],
  venue: 'Nature Methods',
  year: 2024,
  volume: '21',
  issue: '3',
  pages: '145-158',
  doi: '10.1038/s41592-024-01234-5'
}

const journalItem = (): CitationItem => citationItemFromReference(journalRecord)

describe('citation item derivation', () => {
  it('infers the item type from the record shape', () => {
    expect(inferCitationItemType(journalRecord)).toBe('journal-article')
    expect(inferCitationItemType({ ...journalRecord, venue: undefined })).toBe('unknown')
    expect(
      inferCitationItemType({ ...journalRecord, venue: undefined, arxivId: '2401.00001' })
    ).toBe('preprint')
    expect(inferCitationItemType({ ...journalRecord, venue: undefined, url: 'https://x.y' })).toBe(
      'web'
    )
    expect(inferCitationItemType({ ...journalRecord, itemType: 'dataset' })).toBe('dataset')
    expect(inferCitationItemType({ ...journalRecord, itemType: 'not-a-type' })).toBe(
      'journal-article'
    )
  })

  it('maps venue to the container title and trims empty fields away', () => {
    const item = citationItemFromReference({ ...journalRecord, volume: '  ', doi: '' })
    expect(item.containerTitle).toBe('Nature Methods')
    expect(item.volume).toBeUndefined()
    expect(item.doi).toBeUndefined()
  })
})

describe('built-in styles render a complete record', () => {
  it('GB/T 7714-2015 adds volume(issue): pages to the serial block', () => {
    expect(formatCitation(journalItem(), 'gbt7714-2015').text).toBe(
      'Zhang W., Chen L., Smith J. A. et al. Deep learning for protein design[J]. Nature Methods, 2024, 21(3): 145-158. 10.1038/s41592-024-01234-5'
    )
  })

  it('APA 7th', () => {
    expect(formatCitation(journalItem(), 'apa-7').text).toBe(
      'Zhang, W., Chen, L., Smith, J. A., & Huang, M. (2024). Deep learning for protein design. Nature Methods, 21(3), 145-158. https://doi.org/10.1038/s41592-024-01234-5'
    )
  })

  it('Vancouver (NLM)', () => {
    expect(formatCitation(journalItem(), 'vancouver-nlm').text).toBe(
      'Zhang W, Chen L, Smith JA, Huang M. Deep learning for protein design. Nature Methods. 2024;21(3):145-158. doi: 10.1038/s41592-024-01234-5.'
    )
  })

  it('IEEE 11th', () => {
    expect(formatCitation(journalItem(), 'ieee-11', { index: 1 }).text).toBe(
      '[1] W. Zhang, L. Chen, J. A. Smith and M. Huang, "Deep learning for protein design," Nature Methods, vol. 21, no. 3, pp. 145-158, 2024.'
    )
  })

  it('Nature', () => {
    expect(formatCitation(journalItem(), 'nature').text).toBe(
      'Zhang, W., Chen, L., Smith, J. A. & Huang, M. Deep learning for protein design. Nature Methods 21, 145-158 (2024).'
    )
  })

  it('AMA 11th', () => {
    expect(formatCitation(journalItem(), 'ama-11').text).toBe(
      'Zhang W, Chen L, Smith JA, Huang M. Deep learning for protein design. Nature Methods. 2024;21(3):145-158. doi:10.1038/s41592-024-01234-5'
    )
  })

  it('Harvard (Cite Them Right 12th)', () => {
    expect(formatCitation(journalItem(), 'harvard-ctr-12').text).toBe(
      "Zhang, W., Chen, L., Smith, J. A. and Huang, M. (2024) 'Deep learning for protein design', Nature Methods, 21(3), pp. 145-158. doi: 10.1038/s41592-024-01234-5."
    )
  })

  it('Chicago 18th (author-date)', () => {
    expect(formatCitation(journalItem(), 'chicago-18-author-date').text).toBe(
      'Zhang, Wei, Li Chen, John A. Smith, and Mei Huang. 2024. "Deep learning for protein design." Nature Methods 21 (3): 145-158. https://doi.org/10.1038/s41592-024-01234-5.'
    )
  })

  it('MLA 9th', () => {
    expect(formatCitation(journalItem(), 'mla-9').text).toBe(
      'Zhang, Wei, Li Chen, John A. Smith, and Mei Huang. "Deep learning for protein design." Nature Methods, vol. 21, no. 3, 2024, pp. 145-158. https://doi.org/10.1038/s41592-024-01234-5'
    )
  })
})

describe('styles never invent what a record does not carry', () => {
  it('drops the volume/issue/page block and names the missing fields', () => {
    const sparse = citationItemFromReference({
      title: 'A short note',
      authors: [{ name: 'Wei Zhang' }],
      year: 2020
    })
    const apa = formatCitation(sparse, 'apa-7')
    expect(apa.text).toBe('Zhang, W. (2020). A short note.')
    expect(apa.warnings).toContain('field:containerTitle')

    const ieee = formatCitation(sparse, 'ieee-11', { index: 3 })
    expect(ieee.text).toBe('[3] W. Zhang, "A short note," 2020.')
    expect(ieee.warnings).toContain('field:containerTitle')
  })

  it('reports a record with no year instead of printing a placeholder year', () => {
    const undated = citationItemFromReference({
      title: 'Undated dataset',
      authors: [{ name: 'Wei Zhang' }],
      itemType: 'dataset'
    })
    const vancouver = formatCitation(undated, 'vancouver-nlm')
    expect(vancouver.text).toBe('Zhang W. Undated dataset.')
    expect(vancouver.warnings).toContain('field:year')
  })

  it('reports an unknown style id rather than falling back silently', () => {
    const missing = formatCitation(journalItem(), 'no-such-style')
    expect(missing.text).toBe('')
    expect(missing.warnings).toEqual(['style:unknown'])
  })
})

describe('the GB/T path stays byte-stable for records without the new fields', () => {
  it('matches the legacy formatter for a venue-only record', () => {
    const legacyShape = {
      title: 'Attention Is All You Need',
      authors: [{ name: 'Ashish Vaswani' }, { name: 'Noam Shazeer' }, { name: 'Niki Parmar' }],
      venue: 'Advances in Neural Information Processing Systems',
      year: 2017,
      doi: '10.48550/arXiv.1706.03762'
    }
    const item = citationItemFromReference(legacyShape)
    expect(formatCitation(item, 'gbt7714-2015').text).toBe(
      formatGbt7714({ ...legacyShape, arxivId: undefined, pmid: undefined, pmcid: undefined })
    )
  })

  it('matches the legacy formatter for an identifier-only record, retrieval date included', () => {
    const webShape = {
      title: 'Protein Data Bank',
      authors: [{ name: 'RCSB' }],
      pmid: '12345678'
    }
    const item = citationItemFromReference(webShape)
    expect(formatCitation(item, 'gbt7714-2015', { retrievedAt: '2026-09-08' }).text).toBe(
      formatGbt7714(
        {
          title: 'Protein Data Bank',
          authors: [{ name: 'RCSB' }],
          venue: undefined,
          year: undefined,
          doi: undefined,
          arxivId: undefined,
          pmid: '12345678',
          pmcid: undefined
        },
        { retrievedAt: '2026-09-08' }
      )
    )
  })
})

// The electronic-resource block is the shape a Chinese evidence item takes: an issuing body, a year,
// a retrieval date and the path it was read from. GB/T 7714-2015 prints 出版者 before 出版年, and the
// dated block closes before the path ("2021[2026-10-09]. https://…"), the same way the legacy
// formatter does. This branch had no coverage before; these three cases pin it.
describe('the GB/T [EB/OL] block carries the issuing body', () => {
  const guideline = {
    title: '中国2型糖尿病防治指南（2020年版）',
    authors: [{ name: '中华医学会糖尿病学分会' }],
    publisher: '中华医学会',
    url: 'https://www.cma.org.cn/guideline',
    year: 2021
  }

  it('prints 出版者 ahead of the year', () => {
    const text = formatCitation(citationItemFromReference(guideline), 'gbt7714-2015', {
      retrievedAt: '2026-10-09'
    }).text
    expect(text).toBe(
      '中华医学会糖尿病学分会. 中国2型糖尿病防治指南（2020年版）[EB/OL]. 中华医学会, 2021[2026-10-09]. https://www.cma.org.cn/guideline'
    )
  })

  it('omits the slot for a record that carries no publisher, keeping the dated block', () => {
    const { publisher: _dropped, ...withoutPublisher } = guideline
    const text = formatCitation(
      citationItemFromReference({ ...withoutPublisher, pages: '1-46' }),
      'gbt7714-2015',
      { retrievedAt: '2026-10-09' }
    ).text
    expect(text).toBe(
      '中华医学会糖尿病学分会. 中国2型糖尿病防治指南（2020年版）[EB/OL]. 2021[2026-10-09]. https://www.cma.org.cn/guideline'
    )
    expect(text).not.toContain('中华医学会,')
  })

  it('closes the dated block before the path, and reads as a bare path with no date', () => {
    const noYear = formatCitation(
      citationItemFromReference({ ...guideline, year: undefined }),
      'gbt7714-2015',
      { retrievedAt: '2026-10-09' }
    ).text
    expect(noYear).toBe(
      '中华医学会糖尿病学分会. 中国2型糖尿病防治指南（2020年版）[EB/OL]. 中华医学会[2026-10-09]. https://www.cma.org.cn/guideline'
    )

    const bare = formatCitation(
      citationItemFromReference({ ...guideline, year: undefined, url: undefined, doi: '10.3760/x' }),
      'gbt7714-2015'
    )
    expect(bare.text).toBe(
      '中华医学会糖尿病学分会. 中国2型糖尿病防治指南（2020年版）[EB/OL]. 中华医学会. https://doi.org/10.3760/x'
    )
    expect(bare.warnings).not.toContain('style:no-locator')
  })
})

describe('comparison and list rendering', () => {
  it('renders one entry per requested style, in the requested order', () => {
    const compared = compareCitationStyles(journalItem(), ['mla-9', 'apa-7', 'gbt7714-2015'])
    expect(compared.map((entry) => entry.styleId)).toEqual(['mla-9', 'apa-7', 'gbt7714-2015'])
    expect(compared.every((entry) => entry.text.length > 0)).toBe(true)
  })

  it('numbers only the numeric conventions', () => {
    const items = [journalItem(), { ...journalItem(), title: 'Second record' }]
    const numeric = formatCitationList(items, 'vancouver-nlm').split('\n')
    expect(numeric[0].startsWith('[1] ')).toBe(true)
    expect(numeric[1].startsWith('[2] ')).toBe(true)

    const authorDate = formatCitationList(items, 'apa-7').split('\n')
    expect(authorDate[0].startsWith('[1]')).toBe(false)
    expect(authorDate).toHaveLength(2)
  })
})
