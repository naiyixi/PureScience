import { describe, expect, it } from 'vitest'

import { bareDoiKey, dedupeLiteratureRecords, recordYear, titleKey } from './literature-dedupe'

const arxivRecord = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: 'arxiv',
  arxiv_id: '2103.14030',
  title: 'Base editing of the genome',
  doi: '',
  published: '2021-03-25T17:58:29Z',
  ...over
})

const openalexRecord = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: 'openalex',
  openalex_id: 'W2741809807',
  title: 'Base editing of the genome',
  doi: '10.1038/s41586-021-03429-y',
  publication_year: 2021,
  ...over
})

describe('dedupe key derivation', () => {
  it('strips the DOI resolver, the doi: prefix and casing', () => {
    expect(bareDoiKey('https://doi.org/10.1038/S41586-021-03429-Y')).toBe(
      '10.1038/s41586-021-03429-y'
    )
    expect(bareDoiKey('http://dx.doi.org/10.1/ABC')).toBe('10.1/abc')
    expect(bareDoiKey('doi: 10.1/Abc')).toBe('10.1/abc')
    expect(bareDoiKey('   ')).toBeNull()
    expect(bareDoiKey(undefined)).toBeNull()
  })

  it('normalises punctuation, case and diacritics in titles, and refuses short ones', () => {
    expect(titleKey('Base Editing of the Genome: A Review')).toBe(
      'base editing of the genome a review'
    )
    expect(titleKey('Café society in 1900s Paris')).toBe('cafe society in 1900s paris')
    expect(titleKey('Correction')).toBeNull()
    expect(titleKey('Editorial')).toBeNull()
  })

  it('reads the year from publication_year or from an ISO published date', () => {
    expect(recordYear({ publication_year: 2021 })).toBe(2021)
    expect(recordYear({ published: '2019-07-01T00:00:00Z' })).toBe(2019)
    expect(recordYear({})).toBeNull()
  })
})

describe('dedupeLiteratureRecords', () => {
  it('folds the same DOI from two sources and names the folded one on the kept record', () => {
    const outcome = dedupeLiteratureRecords([
      arxivRecord({ doi: '10.1038/s41586-021-03429-y' }),
      openalexRecord()
    ])
    expect(outcome.before).toBe(2)
    expect(outcome.after).toBe(1)
    expect(outcome.removed).toBe(1)
    expect(outcome.byDoi).toBe(1)
    expect(outcome.byTitle).toBe(0)
    expect(outcome.records[0]?.source).toBe('arxiv')
    expect(outcome.records[0]?.also_in).toEqual([{ source: 'openalex', id: 'W2741809807' }])
  })

  it('treats DOI spellings that differ only by resolver, prefix or case as the same work', () => {
    const outcome = dedupeLiteratureRecords([
      arxivRecord({ doi: 'https://doi.org/10.1038/S41586-021-03429-Y' }),
      openalexRecord({ doi: 'doi:10.1038/s41586-021-03429-y' })
    ])
    expect(outcome.after).toBe(1)
    expect(outcome.byDoi).toBe(1)
  })

  it('folds identical titles in the same year when neither side carries a DOI', () => {
    const outcome = dedupeLiteratureRecords([
      arxivRecord({ doi: '' }),
      openalexRecord({ doi: null })
    ])
    expect(outcome.after).toBe(1)
    expect(outcome.byTitle).toBe(1)
    expect(outcome.records[0]?.also_in).toEqual([{ source: 'openalex', id: 'W2741809807' }])
  })

  it('keeps identical titles from different years apart', () => {
    const outcome = dedupeLiteratureRecords([
      arxivRecord({ doi: '' }),
      openalexRecord({ doi: null, publication_year: 2022 })
    ])
    expect(outcome.after).toBe(2)
    expect(outcome.removed).toBe(0)
  })

  it('does not fold a short or generic title', () => {
    const outcome = dedupeLiteratureRecords([
      arxivRecord({ doi: '', title: 'Correction' }),
      openalexRecord({ doi: null, title: 'Correction' })
    ])
    expect(outcome.after).toBe(2)
  })

  it('folds by title across a missing DOI and carries the DOI onto the kept record', () => {
    const outcome = dedupeLiteratureRecords([arxivRecord({ doi: '' }), openalexRecord()])
    expect(outcome.after).toBe(1)
    expect(outcome.byTitle).toBe(1)
    expect(outcome.records[0]?.source).toBe('arxiv')
    expect(outcome.records[0]?.doi).toBe('10.1038/s41586-021-03429-y')
    expect(outcome.records[0]?.also_in).toEqual([{ source: 'openalex', id: 'W2741809807' }])
  })

  it('folds by title in the other direction too, keeping the DOI-less record first in order', () => {
    const outcome = dedupeLiteratureRecords([openalexRecord(), arxivRecord({ doi: '' })])
    expect(outcome.after).toBe(1)
    expect(outcome.records[0]?.source).toBe('openalex')
    expect(outcome.records[0]?.doi).toBe('10.1038/s41586-021-03429-y')
    expect(outcome.records[0]?.also_in).toEqual([{ source: 'arxiv', id: '2103.14030' }])
  })

  it('never folds two rows that carry DIFFERENT DOIs, even with the same title and year', () => {
    const outcome = dedupeLiteratureRecords([
      openalexRecord({ openalex_id: 'W1', doi: '10.3410/f.740477161.793587538' }),
      openalexRecord({ openalex_id: 'W2', doi: '10.3410/f.740477161.793590095' })
    ])
    expect(outcome.after).toBe(2)
    expect(outcome.removed).toBe(0)
  })

  it('keys Chinese titles correctly — identical ones fold, different ones do not', () => {
    const same = dedupeLiteratureRecords([
      arxivRecord({ doi: '', title: '基于碱基编辑的基因治疗' }),
      openalexRecord({ doi: null, title: '基于碱基编辑的基因治疗' })
    ])
    expect(same.after).toBe(1)
    const different = dedupeLiteratureRecords([
      arxivRecord({ doi: '', title: '基于碱基编辑的基因治疗' }),
      openalexRecord({ doi: null, title: '基于碱基编辑的基因筛查' })
    ])
    expect(different.after).toBe(2)
  })

  it('keeps the arithmetic honest: before - after === removed === byDoi + byTitle', () => {
    const outcome = dedupeLiteratureRecords([
      arxivRecord({ doi: '10.1/x' }),
      openalexRecord({ doi: '10.1/X' }),
      arxivRecord({ arxiv_id: '2', doi: '', title: 'Another long enough title' }),
      openalexRecord({ openalex_id: 'W2', doi: null, title: 'Another long enough title' }),
      openalexRecord({ openalex_id: 'W3', doi: '10.1/y', title: 'Unrelated work entirely' })
    ])
    expect(outcome.before).toBe(5)
    expect(outcome.after).toBe(3)
    expect(outcome.before - outcome.after).toBe(outcome.removed)
    expect(outcome.removed).toBe(outcome.byDoi + outcome.byTitle)
    expect(outcome.byDoi).toBe(1)
    expect(outcome.byTitle).toBe(1)
  })

  it('leaves a list with no duplicates untouched, in order', () => {
    const records = [
      arxivRecord({ doi: '10.1/a' }),
      openalexRecord({ openalex_id: 'W2', doi: '10.1/b', title: 'A second different work' })
    ]
    const outcome = dedupeLiteratureRecords(records)
    expect(outcome.records).toEqual(records)
    expect(outcome.removed).toBe(0)
  })
})
