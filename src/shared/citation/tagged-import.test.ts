import { describe, expect, it } from 'vitest'

import {
  looksLikeCnki,
  looksLikeEndNote,
  looksLikeMedline,
  parseCnkiTagged,
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

// The two blocks below are verbatim records from two real CNKI exports found in public repositories
// (sha256 of the complete files in the evidence note for this unit): the first generation writes
// `Source-文献来源` / `PubTime-发表时间` / `PageCount-页码`, the second one `Source-刊名` / `PubTime-出版时间` /
// `Roll-卷` / `Page-页码` **and** `PageCount-页数`, which is a page COUNT and not a page range. Both are kept
// because the difference between them is exactly what a loose tag match would get wrong.
const CNKI_2022 = `SrcDatabase-来源库:  期刊
Title-题名:  新时代桥梁智能建造及智慧服务体系研究
Author-作者:  文武松;毛伟琦;陶世峰;
Organ-单位:  中铁大桥局集团有限公司;桥梁结构健康与安全国家重点实验室;
Source-文献来源:  世界桥梁
Keyword-关键词:  桥梁工程;;战略需求;;智慧服务;;智能建造;;智慧运维;;综合管理平台;;数字化转型
Summary-摘要:  面向数字中国建设重大战略需求，针对桥梁智慧服务、建养并重的发展态势，以物联网、标识解析、大数据、云计算等现代科学技术的深化应用为基础，总结参建的多项重点桥梁智能建造与智慧运维工程及重点科研项目的构建要素、内涵与特征，逐步构建桥梁建造的智慧服务体系。
PubTime-发表时间:  2022-11-25
Year-年:  2022

SrcDatabase-来源库:  期刊
Title-题名:  双碳目标驱动的新型低压配电系统技术展望
Author-作者:  张勇军;羿应棋;李立浧;钟康骅;李钦豪;刘斯亮;肖晃庆;
Organ-单位:  智慧能源工程技术研究中心华南理工大学电力学院;
Source-文献来源:  电力系统自动化
Keyword-关键词:  新型电力系统;;碳达峰;;碳中和;;新能源;;配电网;;数字孪生;;云边协同
Summary-摘要:  新能源分布式应用是支撑中国实现“碳达峰·碳中和”战略目标的重要方式。
PubTime-发表时间:  2022-11-24
Year-年:  2022
DOI-DOI:  10.7500/AEPS20220325005
`

// The 2021 generation: no blank line between records — the next record starts at `DataType: 1`. The second
// record has no author at all, so an empty author list is the only honest result.
const CNKI_2021 = `DataType: 1
Title-题名: 1例卡培他滨与苯妥英钠相互作用致乳腺癌合并癫痫患者小脑功能障碍的病例分析
Author-作者: 柯洪琴;陈璿英;王启斌;
Source-刊名: 中南药学
Year-年: 2021
PubTime-出版时间: 2021-01-18
Keyword-关键词: 苯妥英钠;卡培他滨;相互作用;小脑功能障碍;不良反应
Summary-摘要: <正>苯妥英钠作为一种传统抗癫痫药物(AEDs),因价格低、疗效佳、易获取,目前仍在基层医院广泛用于癫痫治疗。
Period-期: 01
Roll-卷: 19
PageCount-页数: 3
Page-页码: 168-170
SrcDatabase-来源库: 期刊
Organ-机构: 十堰市太和医院药学部(湖北医药学院附属医院);南昌大学第一附属医院药剂科;
Link-链接: https://kns.cnki.net/kcms/detail/detail.aspx?FileName=ZNYX202101034&DbName=CJFQTEMP
DataType: 1
Title-题名: 中国女性乳腺癌筛查标准(T/CPMA 014-2020)
Source-刊名: 中华疾病控制杂志
PubTime-出版时间: 2021-01-15 16:54
Keyword-关键词: 乳腺癌;筛查;标准
PageCount-页数: 7
Page-页码: 1-7
SrcDatabase-来源库: 期刊
Organ-机构: 中华预防医学会;
Link-链接: https://kns.cnki.net/kcms/detail/detail.aspx?FileName=JBKZ20210115000&DbName=DKFX2021
`

describe('parseCnkiTagged', () => {
  it('reads the 2022 generation: one author per name, keywords split, pages from PageCount-页码', () => {
    const result = parseCnkiTagged(CNKI_2022)

    expect(result.skipped).toEqual([])
    expect(result.records).toHaveLength(2)
    const first = result.records[0]
    expect(first?.item.title).toBe('新时代桥梁智能建造及智慧服务体系研究')
    expect(first?.item.authors.map((author) => author.name)).toEqual(['文武松', '毛伟琦', '陶世峰'])
    expect(first?.item.containerTitle).toBe('世界桥梁')
    expect(first?.item.year).toBe(2022)
    expect(first?.item.itemType).toBe('journal-article')
    expect(first?.keywords).toEqual([
      '桥梁工程',
      '战略需求',
      '智慧服务',
      '智能建造',
      '智慧运维',
      '综合管理平台',
      '数字化转型'
    ])
    // `Organ-单位` is the authors' affiliation; there is no publisher in this export and none is invented.
    expect(first?.item.publisher).toBeUndefined()
    expect(first?.item.doi).toBeUndefined()
    expect(result.records[1]?.item.doi).toBe('10.7500/AEPS20220325005')
  })

  it('reads the 2021 generation: records split on DataType, pages never taken from PageCount-页数', () => {
    const result = parseCnkiTagged(CNKI_2021)

    expect(result.skipped).toEqual([])
    expect(result.records).toHaveLength(2)
    const first = result.records[0]
    expect(first?.item.title).toBe(
      '1例卡培他滨与苯妥英钠相互作用致乳腺癌合并癫痫患者小脑功能障碍的病例分析'
    )
    expect(first?.item.volume).toBe('19')
    expect(first?.item.issue).toBe('01')
    // `PageCount-页数: 3` is how many pages the article spans; the pages are `Page-页码: 168-170`.
    expect(first?.item.pages).toBe('168-170')
    expect(first?.item.url).toBe(
      'https://kns.cnki.net/kcms/detail/detail.aspx?FileName=ZNYX202101034&DbName=CJFQTEMP'
    )
    expect(first?.item.year).toBe(2021)
    // The second record carries no Author-作者 line at all: an empty list, not a made-up one.
    expect(result.records[1]?.item.authors).toEqual([])
    expect(result.records[1]?.item.itemType).toBe('journal-article')
  })

  it('refuses a bracketed placeholder instead of storing it as a URL or a DOI', () => {
    const elided = [
      'SrcDatabase-来源库: 期刊',
      'Title-题名: 一篇链接被抹掉的记录',
      'Author-作者: 张三;',
      'Source-刊名: 某某学报',
      'PubTime-出版时间: 2020',
      'PageCount-页码: 12-18',
      'URL-网址: [Link]',
      'DOI-DOI: 10.20242/[Link].2097-5384.2025.11.005',
      ''
    ].join('\n')

    const record = parseCnkiTagged(elided).records[0]
    expect(record?.item.url).toBeUndefined()
    expect(record?.item.doi).toBeUndefined()
    expect(record?.item.pages).toBe('12-18')
  })

  it('reports a record with no title as skipped, by line, instead of dropping it silently', () => {
    const headerOnly = 'DataType: 1\nAuthor-作者: 张三;\n'
    const result = parseCnkiTagged(headerOnly)
    expect(result.records).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.reason).toBe('no-title')
  })
})

describe('CNKI detection', () => {
  it('recognises both generations and nothing else', () => {
    expect(looksLikeCnki(CNKI_2022)).toBe(true)
    // The 2021 file opens with `DataType: 1`, so detection cannot look at the first line only.
    expect(looksLikeCnki(CNKI_2021)).toBe(true)
    expect(looksLikeCnki(ENDNOTE)).toBe(false)
    expect(looksLikeCnki(MEDLINE)).toBe(false)
    expect(looksLikeCnki('TY  - JOUR\nTI  - An RIS record\nER  - \n')).toBe(false)
  })
})
