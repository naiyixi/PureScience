import { describe, expect, it } from 'vitest'

import { extractDois, isPlausibleDoi, isSameDoi, normalizeDoi } from './doi-extraction'

describe('DOI extraction', () => {
  it('finds a DOI in the forms a PDF actually prints it', () => {
    expect(extractDois('https://doi.org/10.1016/j.cell.2023.01.001')).toEqual([
      '10.1016/j.cell.2023.01.001'
    ])
    expect(extractDois('doi:10.1038/s41586-020-2649-2')).toEqual(['10.1038/s41586-020-2649-2'])
    expect(extractDois('DOI: 10.1126/science.abc1234.')).toEqual(['10.1126/science.abc1234'])
    expect(extractDois('See 10.1101/2020.03.24.20042937 for details.')).toEqual([
      '10.1101/2020.03.24.20042937'
    ])
  })

  // Real PDFs wrap DOIs in prose punctuation; including that punctuation resolves nothing.
  it('trims the punctuation that belongs to the sentence, not the identifier', () => {
    expect(extractDois('(see ref 12: 10.1002/anie.201915432).')).toEqual(['10.1002/anie.201915432'])
    expect(extractDois('"[10.1038/nature12373]"')).toEqual(['10.1038/nature12373'])
    expect(extractDois('10.1016/j.cell.2021.05.013; 10.1016/j.cell.2021.05.014,')).toEqual([
      '10.1016/j.cell.2021.05.013',
      '10.1016/j.cell.2021.05.014'
    ])
  })

  // A closer that has no opener in the DOI is prose; one that matches an opener is part of the suffix.
  it('keeps balanced brackets inside the suffix and drops an unbalanced closer', () => {
    expect(extractDois('10.1016/S0092-8674(00)81600-8.')).toEqual(['10.1016/S0092-8674(00)81600-8'])
    expect(extractDois('10.1038/nature12373)')).toEqual(['10.1038/nature12373'])
  })

  // Documented boundary: angle brackets delimit, so a legacy SICI identifier is captured only up to its
  // first bracket. That truncated form fails to resolve and is reported by name — the alternative (a
  // permissive pattern) would swallow markup into the identifier and fabricate a resolvable-looking DOI.
  it('stops at an angle bracket rather than swallowing markup into the identifier', () => {
    expect(extractDois('10.1002/(sici)1099-0844(199912)17:4<253::aid-cbf836>3.0.co;2-3')).toEqual([
      '10.1002/(sici)1099-0844(199912)17:4'
    ])
    expect(extractDois('see 10.1038/nature12373<a href="x">next</a>')).toEqual([
      '10.1038/nature12373'
    ])
  })

  it('collapses the same paper cited twice, keeping the first spelling', () => {
    const text =
      'First: 10.1016/J.Cell.2023.01.001. Again: https://doi.org/10.1016/j.cell.2023.01.001.'

    expect(extractDois(text)).toEqual(['10.1016/J.Cell.2023.01.001'])
    expect(isSameDoi('10.1016/J.Cell.2023.01.001', '10.1016/j.cell.2023.01.001')).toBe(true)
  })

  // A truncated match must not be reported: resolving `10.1016/` looks up a paper that cannot exist.
  it('rejects a prefix with nothing identifiable after it', () => {
    expect(isPlausibleDoi('10.1016/')).toBe(false)
    expect(isPlausibleDoi('10.1016/---')).toBe(false)
    expect(extractDois('truncated at the page edge: 10.1016/')).toEqual([])
    expect(extractDois('')).toEqual([])
    expect(extractDois(undefined)).toEqual([])
  })

  it('normalises resolver prefixes and case for comparison', () => {
    expect(normalizeDoi('  https://dx.doi.org/10.1038/ABC  ')).toBe('10.1038/ABC')
    expect(normalizeDoi('doi:10.1038/abc.')).toBe('10.1038/abc')
  })

  // Real PDF text layers drop line breaks, and these two shapes are what that produces — both were
  // caught by running the import against a real document, not by a hand-written fixture.
  it('cuts the next sentence’s first word off the identifier when the line break is lost', () => {
    expect(extractDois('doi:10.1038/nature12373.Jones 2021. Another work.')).toEqual([
      '10.1038/nature12373'
    ])
  })

  it('drops a fused word-initial capital that follows a digit', () => {
    expect(extractDois('https://doi.org/10.1126/science.abc1234A work on the topic')).toEqual([
      '10.1126/science.abc1234'
    ])
  })

  it('keeps a suffix that legitimately ends in capitals or digits', () => {
    expect(extractDois('10.1038/ABC123 and 10.1016/j.cell.2023.01.001')).toEqual([
      '10.1038/ABC123',
      '10.1016/j.cell.2023.01.001'
    ])
  })

  it('leaves text without a DOI alone', () => {
    expect(extractDois('Figure 2 shows 10 samples per group at pH 10.5.')).toEqual([])
    expect(extractDois('Version 10.1000 was released.')).toEqual([])
  })
})
