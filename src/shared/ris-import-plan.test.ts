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
})
