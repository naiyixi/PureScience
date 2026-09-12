import { describe, expect, it } from 'vitest'

import { SCI_BENCH_CASES, evaluateSciBenchTrace, type SciBenchCase } from './sci-bench'
import { formatSciBenchScorecard, toSciBenchTrace } from './sci-bench-report'

const benchCase = (id: string): SciBenchCase => {
  const found = SCI_BENCH_CASES.find((entry) => entry.id === id)
  if (!found) throw new Error(`missing case ${id}`)
  return found
}

describe('sci-bench session bridge', () => {
  it('keeps speaker and order in the transcript, and carries artifacts and tool calls', () => {
    const trace = toSciBenchTrace({
      messages: [
        { role: 'user', text: '继续上周的 SHANK2 分析' },
        { role: 'assistant', text: '先加载检查点。' }
      ],
      artifacts: ['figures/egfr.png', 'scripts/egfr.py'],
      toolCalls: [{ name: 'checkpoint_load' }, { name: 'run_python' }]
    })

    expect(trace.transcript).toContain('用户：继续上周的 SHANK2 分析')
    expect(trace.transcript).toContain('助手：先加载检查点。')
    expect(trace.transcript.indexOf('用户：')).toBeLessThan(trace.transcript.indexOf('助手：'))
    expect(trace.artifacts).toEqual(['figures/egfr.png', 'scripts/egfr.py'])
    expect(trace.toolCalls?.map((call) => call.name)).toEqual(['checkpoint_load', 'run_python'])
  })

  it('does not invent evidence a recording lacks (tool-based rules stay failed)', () => {
    const trace = toSciBenchTrace({ messages: [{ role: 'assistant', text: '图已出好。' }] })
    expect(trace.toolCalls).toEqual([])

    const result = evaluateSciBenchTrace(benchCase('egfr-figure-discipline'), trace)
    expect(result.passed).toBe(false)
    expect(result.findings.find((entry) => entry.rule === 'figure-review-invoked')?.passed).toBe(
      false
    )
  })

  it('passes a recorded-compliant session end to end', () => {
    const trace = toSciBenchTrace({
      messages: [
        {
          role: 'assistant',
          text: 'Ran figure_review. Log axis tick labels declared: 0.05, 0.5, 5.'
        }
      ],
      artifacts: ['figures/egfr.png', 'scripts/egfr.py'],
      toolCalls: [{ name: 'figure_review' }, { name: 'run_python' }]
    })
    expect(evaluateSciBenchTrace(benchCase('egfr-figure-discipline'), trace).passed).toBe(true)
  })
})

describe('sci-bench scorecard', () => {
  const compliant = toSciBenchTrace({
    messages: [
      {
        role: 'assistant',
        text: '降采样预览：基于 2000/20000 降采样（头部截取）。全量提案：需人工批准，结果标注 引擎与版本、关键参数、数据范围：全量（20000）。'
      }
    ]
  })

  it('summarises totals, per-case rows and the failing reasons', () => {
    const good = evaluateSciBenchTrace(benchCase('omics-large-file-preview'), compliant)
    const bad = evaluateSciBenchTrace(benchCase('gbt7714-export'), {
      transcript: 'Li S, Zhang Z. A study. 2024.'
    })
    const card = formatSciBenchScorecard([good, bad], {
      sessionId: 'session-1',
      source: 'sessions/project-a/session-1.json',
      generatedAt: '2026-09-12T00:00:00.000Z'
    })

    expect(card).toContain('# SciBench-Local 记分卡')
    expect(card).toContain('合计：1/2 通过')
    expect(card).toContain('| omics-large-file-preview | ✅ 通过 | — |')
    expect(card).toContain('| gbt7714-export | ❌ 未通过 | gbt7714-citation-shape |')
    expect(card).toContain('## 未通过原因')
    expect(card).toContain('`gbt7714-citation-shape`')
    expect(card).toContain('会话：session-1')
    expect(card).toContain('不会因证据缺失而偏高')
  })

  it('omits the failure section when everything passes', () => {
    const card = formatSciBenchScorecard([
      evaluateSciBenchTrace(benchCase('omics-large-file-preview'), compliant)
    ])
    expect(card).toContain('合计：1/1 通过')
    expect(card).not.toContain('## 未通过原因')
  })
})
