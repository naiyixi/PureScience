import { describe, expect, it } from 'vitest'

import {
  chineseDoiPrefix,
  chineseSignalsFor,
  citationReasonCodes,
  countChinese,
  doiPrefix,
  hanRatio,
  isCitationDirection,
  isChineseSource,
  type CitationCandidate
} from './references-citation-discovery'

const candidate = (overrides: Partial<CitationCandidate> = {}): CitationCandidate => ({
  openAlexId: 'W1',
  title: 'Deep learning',
  chineseSignals: [],
  sourceUrl: 'https://openalex.org/W1',
  ...overrides
})

describe('hanRatio', () => {
  it('separates Han titles from mislabelled foreign ones (measured 0.74+ versus 0.00)', () => {
    expect(hanRatio('《中华医学杂志》九十华诞感怀')).toBeGreaterThan(0.7)
    // A work OpenAlex labels `language: zh` whose title is English — the noise the signal set exists for.
    expect(hanRatio('A Definition of Irreversible Coma')).toBe(0)
    // No title is no evidence, not "no Han".
    expect(hanRatio('')).toBe(0)
  })
})

describe('doiPrefix / chineseDoiPrefix', () => {
  it('reads the registrant prefix and only claims the ones observed behind a Chinese publisher', () => {
    expect(doiPrefix('10.3760/j:issn:0376-2491.2005.36.002')).toBe('10.3760')
    expect(chineseDoiPrefix('10.3760/cma.j.issn.0376-2491.2013.16.001')).toBe('10.3760')
    expect(chineseDoiPrefix('10.1038/nature14539')).toBe('')
    // Observed in a live walk of what cites a Chinese-language paper: 49 of 50 rows were Hans Publishers.
    expect(chineseDoiPrefix('10.12677/ae.2022.124146')).toBe('10.12677')
    // A Japanese publisher's prefix is not a Chinese one, and the list must not grow by resemblance.
    expect(chineseDoiPrefix('10.3937/kampomed.73.117')).toBe('')
    expect(chineseDoiPrefix(undefined)).toBe('')
    expect(doiPrefix('not-a-doi')).toBe('')
  })
})

describe('chineseSignalsFor', () => {
  it('names each criterion that fired, in a fixed order, and never invents one', () => {
    expect(
      chineseSignalsFor({ title: '中华医学杂志', doi: '10.3760/x', journalLanguage: 'zh' })
    ).toEqual(['title-han', 'doi-prefix', 'journal-language'])
    // The English-titled Chinese Medical Association article: the title does not fire, the DOI does.
    expect(
      chineseSignalsFor({
        title: 'The epidemiological characteristics of an outbreak',
        doi: '10.3760/cma.j.issn.0254-6450.2020.02.003',
        journalLanguage: null
      })
    ).toEqual(['doi-prefix'])
    expect(
      chineseSignalsFor({
        title: 'Deep learning',
        doi: '10.1038/nature14539',
        journalLanguage: 'en'
      })
    ).toEqual([])
  })
})

describe('countChinese / citationReasonCodes', () => {
  it('counts what is on screen and gives every row a direction clause first', () => {
    const rows = [
      candidate({ chineseSignals: ['doi-prefix'] }),
      candidate({ chineseSignals: [] }),
      candidate({ chineseSignals: ['title-han', 'journal-language'] })
    ]
    expect(countChinese(rows)).toBe(2)
    expect(isChineseSource(rows[1])).toBe(false)
    expect(citationReasonCodes({ direction: 'citations', candidate: rows[2] })).toEqual([
      'cited-by-others',
      'chinese-title',
      'chinese-journal'
    ])
    expect(citationReasonCodes({ direction: 'references', candidate: rows[1] })).toEqual([
      'from-references',
      'no-chinese-signal'
    ])
  })
})

describe('isCitationDirection', () => {
  it('accepts the two directions and nothing else', () => {
    expect(isCitationDirection('references')).toBe(true)
    expect(isCitationDirection('citations')).toBe(true)
    expect(isCitationDirection('cited-by')).toBe(false)
    expect(isCitationDirection(undefined)).toBe(false)
  })
})
