import { describe, expect, it } from 'vitest'

import {
  looksLikeEndNote,
  looksLikeMedline,
  parseEndNoteTagged,
  parseMedline
} from './tagged-import'

// Fixtures are written the way EndNote and PubMed write them, including the wrap lines both formats emit:
// a title split over two lines is still one title, and losing the second half is exactly the kind of silent
// damage these parsers exist to prevent.
const ENDNOTE = `%0 Journal Article
%A 张三
%A 李四
%T 深度学习在医学影像中的应用与挑战：一项系统综述与
 Meta 分析
%J 中华放射学杂志
%D 2024
%V 58
%N 3
%P 245-253
%R 10.3760/cma.j.cn112149-20240101-00001
%K 人工智能
%K 医学影像
%X 目的 系统评价深度学习在医学影像中的应用。方法 检索数据库。
%U https://example.org/article/1
%I 中华医学会

%0 Book Section
%A Wang, Wei
%T Radiomics for lung nodules
%B Handbook of Thoracic Imaging
%D 2023
%P 101-118
%I Springer
%M 12345678

%0 Preprint
%T A preprint without a year or a journal
`

const MEDLINE = `PMID- 38123456
TI  - Deep learning in medical imaging: a systematic review
      and meta-analysis.
AB  - PURPOSE: To evaluate deep learning applications in medical imaging.
      METHODS: We searched PubMed and CNKI.
AU  - Zhang, San
AU  - Li, Si
JT  - Zhonghua Fang She Xue Za Zhi
TA  - Zhonghua Fang She Xue Za Zhi
VI  - 58
IP  - 3
PG  - 245-53
DP  - 2024 Mar
LID - 10.3760/cma.j.cn112149-20240101-00001 [doi]
PT  - Journal Article
OT  - 人工智能
OT  - 医学影像

PMID- 38999999
TI  - 一篇只有标题与年份的中文文献
AU  - 王五
DP  - 2022
PT  - Review
`

describe('parseEndNoteTagged', () => {
  it('reads every field the export carries, including a wrapped title', () => {
    const result = parseEndNoteTagged(ENDNOTE)
    expect(result.records).toHaveLength(3)

    const first = result.records[0]
    expect(first?.item.title).toBe('深度学习在医学影像中的应用与挑战：一项系统综述与 Meta 分析')
    expect(first?.item.authors.map((author) => author.name)).toEqual(['张三', '李四'])
    expect(first?.item.containerTitle).toBe('中华放射学杂志')
    expect(first?.item.year).toBe(2024)
    expect(first?.item.volume).toBe('58')
    expect(first?.item.issue).toBe('3')
    expect(first?.item.pages).toBe('245-253')
    expect(first?.item.doi).toBe('10.3760/cma.j.cn112149-20240101-00001')
    expect(first?.item.itemType).toBe('journal-article')
    expect(first?.abstract).toContain('系统评价深度学习')
    expect(first?.keywords).toEqual(['人工智能', '医学影像'])
    expect(first?.rawType).toBe('Journal Article')
  })

  it('maps a book section to a chapter and keeps its book title as the container', () => {
    const chapter = parseEndNoteTagged(ENDNOTE).records[1]
    expect(chapter?.item.itemType).toBe('chapter')
    expect(chapter?.item.containerTitle).toBe('Handbook of Thoracic Imaging')
    expect(chapter?.item.publisher).toBe('Springer')
    // %M is EndNote's "accession number", carried as the pmid slot rather than dropped.
    expect(chapter?.item.pmid).toBe('12345678')
  })

  it('leaves absent fields absent instead of inventing them', () => {
    const preprint = parseEndNoteTagged(ENDNOTE).records[2]
    expect(preprint?.item.title).toBe('A preprint without a year or a journal')
    expect(preprint?.item.year).toBeUndefined()
    expect(preprint?.item.doi).toBeUndefined()
    expect(preprint?.item.containerTitle).toBeUndefined()
    expect(preprint?.item.volume).toBeUndefined()
    expect(preprint?.item.itemType).toBe('preprint')
  })

  it('refuses a record with no title by name and keeps the rest', () => {
    const result = parseEndNoteTagged('%0 Journal Article\n%A 无名\n%D 2020\n')
    expect(result.records).toHaveLength(0)
    expect(result.skipped[0]?.reason).toBe('no-title')
  })
})

describe('parseMedline', () => {
  it('reads the PubMed fields, folding indented continuation lines back into their tag', () => {
    const result = parseMedline(MEDLINE)
    expect(result.records).toHaveLength(2)

    const first = result.records[0]
    expect(first?.item.title).toBe(
      'Deep learning in medical imaging: a systematic review and meta-analysis.'
    )
    expect(first?.item.authors.map((author) => author.name)).toEqual(['Zhang, San', 'Li, Si'])
    expect(first?.item.year).toBe(2024)
    expect(first?.item.volume).toBe('58')
    expect(first?.item.issue).toBe('3')
    expect(first?.item.pages).toBe('245-53')
    expect(first?.item.pmid).toBe('38123456')
    expect(first?.item.itemType).toBe('journal-article')
    // `[doi]` is the tag's annotation, not part of the identifier.
    expect(first?.item.doi).toBe('10.3760/cma.j.cn112149-20240101-00001')
    expect(first?.abstract).toContain('We searched PubMed and CNKI.')
    expect(first?.keywords).toEqual(['人工智能', '医学影像'])
  })

  it('reads a Chinese record with only a title, a year and a type', () => {
    const second = parseMedline(MEDLINE).records[1]
    expect(second?.item.title).toBe('一篇只有标题与年份的中文文献')
    expect(second?.item.year).toBe(2022)
    expect(second?.item.doi).toBeUndefined()
    expect(second?.item.volume).toBeUndefined()
  })

  it('keeps two records apart even when the first ends without a blank line', () => {
    const joined = 'PMID- 1\nTI  - 第一\n\nPMID- 2\nTI  - 第二\n'
    expect(parseMedline(joined).records.map((record) => record.item.title)).toEqual([
      '第一',
      '第二'
    ])
  })
})

// MEDLINE puts publisher item ids in the same tags as DOIs. Storing `88/4/401M [pii]` as a DOI means every
// later "open the DOI" click 404s, so only a real `10.` prefix is kept.
describe('identifier hygiene', () => {
  it('does not mistake a publisher item id for a DOI', () => {
    const record = [
      'PMID- 28298516',
      'TI  - Precision Medicine in Breast Cancer.',
      'LID - 88/4/401M [pii]',
      'AID - 10.1016/j.jacc.2020.01.001 [doi]',
      'PT  - Journal Article',
      ''
    ].join('\n')

    expect(parseMedline(record).records[0]?.item.doi).toBe('10.1016/j.jacc.2020.01.001')
  })

  it('drops a pii-only record\'s "doi" instead of inventing one', () => {
    const record = [
      'PMID- 1',
      'TI  - Only a pii',
      'LID - 75943 [pii]',
      'PT  - Journal Article',
      ''
    ].join('\n')
    expect(parseMedline(record).records[0]?.item.doi).toBeUndefined()
  })
})

describe('format detection', () => {
  it('tells the dialects apart by content', () => {
    expect(looksLikeEndNote(ENDNOTE)).toBe(true)
    expect(looksLikeEndNote(MEDLINE)).toBe(false)
    expect(looksLikeMedline(MEDLINE)).toBe(true)
    expect(looksLikeMedline(ENDNOTE)).toBe(false)
  })
})
