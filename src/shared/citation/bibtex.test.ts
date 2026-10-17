import { describe, expect, it } from 'vitest'
import { bibtexAuthorName, formatBibTeXEntry, formatBibTeXList } from './bibtex'
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
  itemType: 'journal-article'
}

describe('BibTeX export', () => {
  it('writes a complete article entry with a name-derived key', () => {
    const formatted = formatBibTeXEntry(article)
    expect(formatted.styleId).toBe('bibtex')
    expect(formatted.text).toBe(
      [
        '@article{Smith2023aspirin,',
        '  author = {Smith, John A and 张三},',
        '  title = {Aspirin in secondary prevention},',
        '  journal = {Lancet},',
        '  year = {2023},',
        '  volume = {401},',
        '  number = {10375},',
        '  pages = {123--130},',
        '  doi = {10.1000/xyz123}',
        '}'
      ].join('\n')
    )
    expect(formatted.warnings).toEqual([])
  })

  it('omits a field it does not have and names the omission', () => {
    const formatted = formatBibTeXEntry({
      title: 'Untitled work',
      authors: [],
      itemType: 'journal-article'
    })
    expect(formatted.text).toBe('@article{anonnduntitled,\n  title = {Untitled work}\n}')
    expect(formatted.warnings).toEqual(['field:authors', 'field:containerTitle', 'field:year'])
    // A placeholder must never appear where a value is missing.
    expect(formatted.text).not.toContain('year = {}')
    expect(formatted.text).not.toContain('journal = {}')
  })

  it('escapes TeX markup inside values', () => {
    const formatted = formatBibTeXEntry({
      title: 'Gene & protein: 100% _in vivo_ {sic} \\ path ~ ^',
      authors: [{ name: 'Smith, John' }],
      itemType: 'report'
    })
    expect(formatted.text).toContain(
      'title = {Gene \\& protein: 100\\% \\_in vivo\\_ \\{sic\\} \\textbackslash{} path \\textasciitilde{} \\textasciicircum{}}'
    )
  })

  it('normalises both author spellings and keeps a CJK name as written', () => {
    expect(bibtexAuthorName('John A Smith')).toBe('Smith, John A')
    expect(bibtexAuthorName('Smith, John A')).toBe('Smith, John A')
    expect(bibtexAuthorName('张三')).toBe('张三')
    expect(bibtexAuthorName('Plato')).toBe('Plato')
  })

  it('maps a type it cannot render faithfully to misc and says so', () => {
    const formatted = formatBibTeXEntry({
      title: 'A dissertation',
      authors: [{ name: 'Alice Brown' }],
      year: 2020,
      itemType: 'thesis'
    })
    expect(formatted.text.startsWith('@misc{Brown2020a,')).toBe(true)
    expect(formatted.warnings).toContain('type:thesis-as-misc')
  })

  it('keeps a preprint arXiv id, because the record carries it', () => {
    const formatted = formatBibTeXEntry({
      title: 'A preprint',
      authors: [{ name: 'Wang Fang' }],
      year: 2024,
      arxivId: '2401.00001',
      itemType: 'preprint'
    })
    expect(formatted.text).toContain('eprint = {2401.00001}')
    expect(formatted.text).toContain('archivePrefix = {arXiv}')
  })

  it('gives colliding records deterministic, distinct keys', () => {
    const twin: CitationItem = { ...article }
    const text = formatBibTeXList([article, twin])
    expect(text).toContain('@article{Smith2023aspirin,')
    expect(text).toContain('@article{Smith2023aspirina,')
    // Same input twice, same bytes: no clock, no map iteration order, no counter state outside the call.
    expect(formatBibTeXList([article, twin])).toBe(text)
  })

  it('separates records with exactly one blank line', () => {
    const second: CitationItem = { ...article, title: 'A second study' }
    const entries = formatBibTeXList([article, second]).split('\n\n')
    expect(entries).toHaveLength(2)
    expect(entries[0].endsWith('}')).toBe(true)
    expect(entries[1].startsWith('@article{')).toBe(true)
  })
})
