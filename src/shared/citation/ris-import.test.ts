import { describe, expect, it } from 'vitest'

import { parseRis } from './ris-import'

// The fixtures below reproduce the dialects that actually matter to a Chinese reader: CNKI's and 万方's
// exports write TI/AU with GB-style author lists, NoteExpress writes an extra DB/AN pair, EndNote writes
// T1/A1 and often indents a wrapped abstract. A parser that only knows one dialect silently loses fields
// from the other two, so each case pins the field it would have lost.

const cnkiStyle = [
  'TY  - JOUR',
  'TI  - 深度学习在医学影像诊断中的应用',
  'AU  - 张三',
  'AU  - 李四',
  'AU  - 王五',
  'JO  - 中华放射学杂志',
  'PY  - 2023',
  'VL  - 57',
  'IS  - 4',
  'SP  - 312-318',
  'DO  - 10.3760/cma.j.cn112149-20230101-00001',
  'AB  - 目的：评估深度学习模型在肺结节检出中的价值。',
  'KW  - 深度学习',
  'KW  - 医学影像',
  'DB  - CNKI',
  'AN  - 10.3760/cma.j.cn112149-20230101-00001',
  'ER  - '
].join('\r\n')

const endNoteStyle = [
  'TY  - JOUR',
  'T1  - Single-cell RNA sequencing of the tumour microenvironment',
  'A1  - Smith, John A.',
  'A1  - Chen, Wei',
  'JF  - Nature Methods',
  'Y1  - 2022/05/01',
  'VL  - 19',
  'IS  - 5',
  'SP  - 501-510',
  'UR  - https://example.org/article',
  'N2  - We profiled 120,000 cells and',
  '  identified nine clusters.',
  'ER  - '
].join('\n')

describe('parseRis — Chinese database exports', () => {
  it('reads a CNKI-style record with CRLF line endings', () => {
    const result = parseRis(cnkiStyle)

    expect(result.skipped).toEqual([])
    expect(result.records).toHaveLength(1)

    const [record] = result.records
    expect(record?.item.title).toBe('深度学习在医学影像诊断中的应用')
    expect(record?.item.authors.map((author) => author.name)).toEqual(['张三', '李四', '王五'])
    expect(record?.item.containerTitle).toBe('中华放射学杂志')
    expect(record?.item.year).toBe(2023)
    expect(record?.item.volume).toBe('57')
    expect(record?.item.issue).toBe('4')
    expect(record?.item.pages).toBe('312-318')
    expect(record?.item.doi).toBe('10.3760/cma.j.cn112149-20230101-00001')
    expect(record?.item.itemType).toBe('journal-article')
    expect(record?.keywords).toEqual(['深度学习', '医学影像'])
    expect(record?.abstract).toContain('肺结节')
    expect(record?.rawType).toBe('JOUR')
  })

  it('reads an EndNote-style record: T1/A1 spellings, a date instead of a year, a wrapped abstract', () => {
    const result = parseRis(endNoteStyle)

    expect(result.records).toHaveLength(1)
    const [record] = result.records
    expect(record?.item.title).toBe('Single-cell RNA sequencing of the tumour microenvironment')
    expect(record?.item.authors.map((author) => author.name)).toEqual([
      'Smith, John A.',
      'Chen, Wei'
    ])
    expect(record?.item.containerTitle).toBe('Nature Methods')
    expect(record?.item.year).toBe(2022)
    expect(record?.item.url).toBe('https://example.org/article')
    // The continuation line is joined, not dropped: a wrapped abstract is the norm in EndNote exports.
    expect(record?.abstract).toBe('We profiled 120,000 cells and identified nine clusters.')
    // EndNote records carry no DOI here, and none is invented.
    expect(record?.item.doi).toBeUndefined()
  })

  it('keeps several records apart and in file order', () => {
    const result = parseRis(`${cnkiStyle}\n\n${endNoteStyle}`)

    expect(result.records.map((record) => record.item.title)).toEqual([
      '深度学习在医学影像诊断中的应用',
      'Single-cell RNA sequencing of the tumour microenvironment'
    ])
  })

  it('is not confused by a UTF-8 BOM', () => {
    const result = parseRis(`\uFEFF${cnkiStyle}`)

    expect(result.records).toHaveLength(1)
    expect(result.skipped).toEqual([])
  })

  it('reads the edition statement `ET` as text, and does not count it as an unmapped tag', () => {
    const result = parseRis(
      [
        'TY  - BOOK',
        'TI  - 机器学习方法',
        'AU  - 李航',
        'PB  - 清华大学出版社',
        'ET  - 2',
        'PY  - 2012',
        'ER  - '
      ].join('\n')
    )

    expect(result.records[0]?.item.edition).toBe('2')
    expect(result.records[0]?.item.itemType).toBe('book')
    // `ET` is a field the importer now keeps, so it must not be reported as a dialect we do not read.
    expect(result.unmappedTags).toEqual({})
  })

  it('leaves the edition absent when the export states none', () => {
    const result = parseRis(cnkiStyle)

    expect(result.records[0]?.item.edition).toBeUndefined()
  })
})

describe('parseRis — what it refuses, and says so', () => {
  it('skips a record with no title and names the line', () => {
    const result = parseRis(['TY  - JOUR', 'AU  - 张三', 'ER  - '].join('\n'))

    expect(result.records).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.reason).toBe('no-title')
    // The line reported is where the record starts (its TY), not where the missing title would have been.
    expect(result.skipped[0]?.line).toBe(1)
  })

  it('reports a line that fits no RIS tag instead of dropping it silently', () => {
    const result = parseRis(
      ['TY  - JOUR', 'TI  - 一篇论文', '这是一行不是 RIS 的字', 'ER  - '].join('\n')
    )

    expect(result.records).toHaveLength(1)
    expect(result.skipped).toEqual([
      { line: 3, reason: 'unparsable-line', detail: '这是一行不是 RIS 的字' }
    ])
  })

  it('reports a tag with no open record', () => {
    const result = parseRis('TI  - 孤立的一行')

    expect(result.records).toEqual([])
    // The detail is whitespace-normalised, which is why it reads with a single space around the hyphen.
    expect(result.skipped).toEqual([{ line: 1, reason: 'not-a-record', detail: 'TI - 孤立的一行' }])
  })

  it('keeps an unmapped type as it was written rather than guessing one', () => {
    const result = parseRis(['TY  - STANDARD', 'TI  - 一项标准', 'ER  - '].join('\n'))

    expect(result.records[0]?.item.itemType).toBe('unknown')
    expect(result.records[0]?.rawType).toBe('STANDARD')
    expect(result.unmappedTypes).toEqual({ STANDARD: 1 })
  })

  it('counts tags it does not map, so a new dialect shows up as data', () => {
    const result = parseRis(['TY  - JOUR', 'TI  - 一篇论文', 'ZZ  - 未知字段', 'ER  - '].join('\n'))

    expect(result.unmappedTags).toEqual({ ZZ: 1 })
    expect(result.records).toHaveLength(1)
  })
})
