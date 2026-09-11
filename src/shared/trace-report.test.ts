import { describe, expect, it } from 'vitest'

import {
  buildTraceReportHtml,
  buildTraceReportMarkdown,
  escapeTraceHtml,
  type TraceReportInput
} from './trace-report'

const input = (overrides: Partial<TraceReportInput> = {}): TraceReportInput => ({
  title: 'SHANK2 多步分析',
  project: 'proj-shank2',
  generatedAt: '2026-09-11T00:00:00.000Z',
  goal: '从序列到候选方案的量化结论',
  steps: [
    { label: '解析 UniProt', status: 'done', evidence: 'uniprot:Q9UPX8' },
    { label: '结构预测', status: 'done', detail: 'AlphaFold DB（预测，非实验）' },
    { label: 'ΔΔG 计算', status: 'skipped', detail: '无可用算力' },
    { label: '单细胞 DEG', status: 'failed', detail: '内存不足' }
  ],
  artifacts: [{ path: 'out/deg.csv', kind: 'csv', note: '降采样后' }],
  checkpoint: {
    freshness: 'fresh',
    facts: [{ key: 'uniprot:SHANK2', value: 'Q9UPX8', source: 'uniprot.org' }],
    packages: [{ name: 'scanpy', version: '1.10.0' }],
    outputs: [{ label: 'DEG list', path: 'out/deg.csv' }]
  },
  scopes: ['基于 2000/20000 降采样（头部截取）'],
  caveats: ['ΔΔG 未计算：需要 GPU 主机或引擎', 'DEG 结论基于降采样，全量前不得定稿'],
  ...overrides
})

describe('trace report document', () => {
  it('keeps step order and states each status explicitly', () => {
    const markdown = buildTraceReportMarkdown(input())
    const order = ['解析 UniProt', '结构预测', 'ΔΔG 计算', '单细胞 DEG'].map((label) =>
      markdown.indexOf(label)
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(markdown).toContain('[完成]')
    expect(markdown).toContain('[跳过]')
    expect(markdown).toContain('[失败]')
    expect(markdown).toContain('可核验：uniprot:Q9UPX8')
  })

  it('carries the scope labels and the honesty caveats', () => {
    const markdown = buildTraceReportMarkdown(input())
    expect(markdown).toContain('## 结果范围')
    expect(markdown).toContain('基于 2000/20000 降采样')
    expect(markdown).toContain('## 诚实性说明')
    expect(markdown).toContain('未计算')
  })

  it('records checkpoint provenance that was reused', () => {
    const markdown = buildTraceReportMarkdown(input())
    expect(markdown).toContain('## 检查点复用')
    expect(markdown).toContain('uniprot:SHANK2 = Q9UPX8（来源：uniprot.org）')
    expect(markdown).toContain('scanpy@1.10.0')
    expect(markdown).toContain('新鲜度：fresh')
  })

  it('omits empty sections instead of printing placeholders', () => {
    const markdown = buildTraceReportMarkdown(
      input({ artifacts: [], scopes: [], caveats: [], checkpoint: undefined })
    )
    expect(markdown).not.toContain('## 产物')
    expect(markdown).not.toContain('## 结果范围')
    expect(markdown).not.toContain('## 诚实性说明')
    expect(markdown).toContain('## 执行步骤')
  })

  it('handles a session with no recorded steps honestly', () => {
    const markdown = buildTraceReportMarkdown(input({ steps: [] }))
    expect(markdown).toContain('（无记录步骤）')
  })

  it('escapes session content in the HTML rendering', () => {
    const html = buildTraceReportHtml(
      input({
        title: '<script>alert(1)</script>',
        steps: [{ label: '<img src=x onerror=alert(1)>', status: 'done' }]
      })
    )
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img')
    expect(html.startsWith('<!doctype html>')).toBe(true)
  })

  it('escapes the five HTML-significant characters', () => {
    expect(escapeTraceHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })
})
