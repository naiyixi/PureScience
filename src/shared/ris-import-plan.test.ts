import { describe, expect, it } from 'vitest'

import { planReferenceImport } from './ris-import-plan'

const ris = [
  'TY  - JOUR',
  'TI  - 深度学习在肺结节检出中的价值',
  'AU  - 张三',
  'AU  - 李四',
  'JO  - 中华放射学杂志',
  'PY  - 2023',
  'VL  - 57',
  'IS  - 4',
  'SP  - 312-318',
  'DO  - 10.3760/cma.j.2023.001',
  'AB  - 目的：评估模型在肺结节检出中的价值。',
  'ER  - ',
  'TY  - JOUR',
  'TI  - 另一篇没有 DOI 的中文论文',
  'AU  - 王五',
  'PY  - 2021',
  'ER  - '
].join('\n')

describe('planReferenceImport — reading both dialects behind one plan', () => {
  it('reads RIS and maps every field the library stores', () => {
    const plan = planReferenceImport(ris, [])
    if ('error' in plan) throw new Error('expected a plan')

    expect(plan.format).toBe('ris')
    expect(plan.records).toHaveLength(2)

    const [first] = plan.records
    expect(first?.input.title).toBe('深度学习在肺结节检出中的价值')
    expect(first?.input.authors).toEqual([{ name: '张三' }, { name: '李四' }])
    expect(first?.input.venue).toBe('中华放射学杂志')
    expect(first?.input.year).toBe(2023)
    expect(first?.input.volume).toBe('57')
    expect(first?.input.issue).toBe('4')
    expect(first?.input.pages).toBe('312-318')
    expect(first?.input.doi).toBe('10.3760/cma.j.2023.001')
    expect(first?.input.itemType).toBe('journal-article')
    expect(first?.input.abstractSnippet).toContain('肺结节')
  })

  it('refuses a duplicate by DOI and by title, and says which', () => {
    const plan = planReferenceImport(ris, [
      { title: '完全不同的标题', doi: '10.3760/cma.j.2023.001' },
      { title: '另一篇没有DOI的中文论文' }
    ])
    if ('error' in plan) throw new Error('expected a plan')

    expect(plan.records).toEqual([])
    expect(plan.skipped.map((entry) => entry.reason)).toEqual(['duplicate', 'duplicate'])
    expect(plan.skipped[0]?.label).toBe('深度学习在肺结节检出中的价值')
  })

  it('imports the rest when only one record is a duplicate', () => {
    const plan = planReferenceImport(ris, [{ title: '另一篇没有DOI的中文论文' }])
    if ('error' in plan) throw new Error('expected a plan')

    expect(plan.records.map((record) => record.title)).toEqual(['深度学习在肺结节检出中的价值'])
    expect(plan.skipped).toHaveLength(1)
  })

  it('reports the records it could not read, with the parser’s reason', () => {
    const plan = planReferenceImport(
      ['TY  - JOUR', 'AU  - 无题作者', 'ER  - ', 'TY  - JOUR', 'TI  - 正常记录', 'ER  - '].join(
        '\n'
      ),
      []
    )
    if ('error' in plan) throw new Error('expected a plan')

    expect(plan.records).toHaveLength(1)
    expect(plan.refused).toEqual([expect.objectContaining({ reason: 'no-title', line: 1 })])
  })

  it('detects the dialect by content, not by file name', () => {
    const zoteroJson = JSON.stringify([
      {
        itemType: 'journalArticle',
        title: 'Zotero 导出的一篇',
        creators: [{ lastName: '张', firstName: '三' }]
      }
    ])
    const plan = planReferenceImport(zoteroJson, [])
    if ('error' in plan) throw new Error('expected a plan')

    expect(plan.format).toBe('zotero-json')
    expect(plan.records[0]?.title).toBe('Zotero 导出的一篇')
  })

  it('refuses text that is neither dialect', () => {
    expect(planReferenceImport('这是一段随便的文字', [])).toEqual({ error: 'not-an-export' })
  })

  // A reader who picks "EndNote" or "PubMed / MEDLINE" in the export menu gets a different dialect than RIS.
  // Both land in the same plan, with the same duplicate rule and the same library item types.
  it('reads an EndNote tagged export and names the dialect', () => {
    const endnote = [
      '%0 Journal Article',
      '%A 张三',
      '%T 深度学习在医学影像中的应用',
      '%J 中华放射学杂志',
      '%D 2024',
      '%V 58',
      '%P 245-253',
      '%R 10.3760/cma.j.cn112149-20240101-00001',
      ''
    ].join('\n')
    const plan = planReferenceImport(endnote, [])
    if ('error' in plan) throw new Error('expected a plan')

    expect(plan.format).toBe('endnote')
    expect(plan.records).toHaveLength(1)
    expect(plan.records[0]?.input).toMatchObject({
      title: '深度学习在医学影像中的应用',
      venue: '中华放射学杂志',
      year: 2024,
      volume: '58',
      pages: '245-253',
      itemType: 'journal-article'
    })
    expect(plan.records[0]?.input.authors).toEqual([{ name: '张三' }])
  })

  it('reads a MEDLINE export, keeps the PMID, and refuses a duplicate by DOI', () => {
    const medline = [
      'PMID- 38123456',
      'TI  - Deep learning in medical imaging',
      'AU  - Zhang, San',
      'JT  - Zhonghua Fang She Xue Za Zhi',
      'DP  - 2024 Mar',
      'LID - 10.3760/cma.j.cn112149-20240101-00001 [doi]',
      'PT  - Journal Article',
      ''
    ].join('\n')

    const fresh = planReferenceImport(medline, [])
    if ('error' in fresh) throw new Error('expected a plan')
    expect(fresh.format).toBe('medline')
    expect(fresh.records[0]?.input.pmid).toBe('38123456')
    expect(fresh.records[0]?.input.doi).toBe('10.3760/cma.j.cn112149-20240101-00001')

    const duplicate = planReferenceImport(medline, [
      { title: 'Something else entirely', doi: '10.3760/cma.j.cn112149-20240101-00001' }
    ])
    if ('error' in duplicate) throw new Error('expected a plan')
    expect(duplicate.records).toHaveLength(0)
    expect(duplicate.skipped[0]?.reason).toBe('duplicate')
  })

  // The export menu on the Chinese databases offers its own text format next to RIS, and that is what a
  // reader who has never heard of RIS ends up with. It reaches the same plan, so the duplicate rule applies
  // to it unchanged — including the space-insensitive Chinese title key below.
  it('reads a CNKI-format export, names the dialect, and refuses a spaced duplicate of the same title', () => {
    const cnki = [
      'SrcDatabase-来源库:  期刊',
      'Title-题名:  新时代桥梁智能建造及智慧服务体系研究',
      'Author-作者:  文武松;毛伟琦;陶世峰;',
      'Organ-单位:  中铁大桥局集团有限公司;桥梁结构健康与安全国家重点实验室;',
      'Source-文献来源:  世界桥梁',
      'Keyword-关键词:  桥梁工程;;战略需求;;智慧服务',
      'Summary-摘要:  面向数字中国建设重大战略需求。',
      'PubTime-发表时间:  2022-11-25',
      'Year-年:  2022',
      ''
    ].join('\n')

    const fresh = planReferenceImport(cnki, [])
    if ('error' in fresh) throw new Error('expected a plan')
    expect(fresh.format).toBe('cnki')
    expect(fresh.records).toHaveLength(1)
    expect(fresh.records[0]?.input).toMatchObject({
      title: '新时代桥梁智能建造及智慧服务体系研究',
      venue: '世界桥梁',
      year: 2022,
      itemType: 'journal-article'
    })
    expect(fresh.records[0]?.input.authors).toEqual([
      { name: '文武松' },
      { name: '毛伟琦' },
      { name: '陶世峰' }
    ])

    const duplicate = planReferenceImport(cnki, [{ title: '新时代桥梁智能建造及智慧服务体系研究' }])
    if ('error' in duplicate) throw new Error('expected a plan')
    expect(duplicate.records).toHaveLength(0)
    expect(duplicate.skipped[0]?.reason).toBe('duplicate')
  })
})
