import { describe, expect, it } from 'vitest'

import { SCI_BENCH_CASES, evaluateSciBenchTrace, type SciBenchResult } from './sci-bench'
import { formatSciBenchScorecard, toSciBenchTrace } from './sci-bench-report'

// Golden replay baseline (v1.57 unit 6, SciBench v1). These are synthetic fixtures, not recordings
// of a real session — they exist to pin the *negative* guarantees, which are the ones that erode
// silently: no case may pass without evidence, evaluation must be deterministic, and the scorecard
// must show failing reasons rather than a bare pass count. Real recorded slices can be added here
// later without changing the assertions.

const evaluateAll = (
  text: string,
  extras: Partial<Parameters<typeof toSciBenchTrace>[0]> = {}
): SciBenchResult[] =>
  SCI_BENCH_CASES.map((benchCase) =>
    evaluateSciBenchTrace(
      benchCase,
      toSciBenchTrace({ messages: [{ role: 'assistant', text }], ...extras })
    )
  )

describe('sci-bench golden replay baseline', () => {
  it('gives no case a free pass: an evidence-free session fails every case', () => {
    const results = evaluateAll('')
    expect(results).toHaveLength(SCI_BENCH_CASES.length)
    for (const result of results) {
      expect(result.passed, `${result.caseId} passed without evidence`).toBe(false)
      expect(result.findings.length).toBeGreaterThan(0)
      expect(result.findings.some((finding) => !finding.passed)).toBe(true)
    }
  })

  it('stays failed when a session only *talks* about compliance without producing artifacts', () => {
    const results = evaluateAll(
      '我已调用 figure_review，并声明 log 轴刻度 0.05/0.5/5；也已保存 checkpoint，ΔΔG 已按引擎计算。'
    )
    // Wording alone must not satisfy artifact- or tool-backed rules.
    for (const result of results) {
      expect(result.passed, `${result.caseId} passed on wording alone`).toBe(false)
    }
  })

  it('is deterministic: the same trace yields identical findings twice', () => {
    const first = evaluateAll('Ran figure_review. Log axis tick labels declared: 0.05, 0.5, 5.', {
      artifacts: ['figures/egfr.png', 'scripts/egfr.py'],
      toolCalls: [{ name: 'figure_review' }, { name: 'run_python' }]
    })
    const second = evaluateAll('Ran figure_review. Log axis tick labels declared: 0.05, 0.5, 5.', {
      artifacts: ['figures/egfr.png', 'scripts/egfr.py'],
      toolCalls: [{ name: 'figure_review' }, { name: 'run_python' }]
    })
    expect(second).toEqual(first)
    expect(first.some((result) => result.passed)).toBe(true)
  })

  it('renders a scorecard that names the session, counts the cases and lists failing reasons', () => {
    const results = evaluateAll('')
    const scorecard = formatSciBenchScorecard(results, {
      sessionId: 'golden-replay',
      generatedAt: '2026-09-12T00:00:00.000Z',
      source: 'synthetic fixture'
    })
    expect(scorecard).toContain('会话：golden-replay')
    expect(scorecard).toContain('来源：synthetic fixture')
    expect(scorecard).toContain(`合计：0/${SCI_BENCH_CASES.length} 通过`)
    expect(scorecard).toContain('## 未通过原因')
    expect(scorecard).toContain('❌ 未通过')
    // Every failing case must name the rules that failed, not just a count.
    for (const result of results) {
      expect(scorecard).toContain(`### ${result.caseId}`)
    }
  })
})
