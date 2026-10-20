import { describe, expect, it } from 'vitest'

import type { CaseResult } from './sci-bench-v1'
import {
  comparabilityProblems,
  renderArmTable,
  summariseArms,
  type ArmRun
} from './sci-bench-v1-arms'

const result = (passed: boolean, checks: boolean[]): CaseResult => ({
  caseId: 'case-a',
  passed,
  atomicPassRate: checks.filter(Boolean).length / checks.length,
  findings: checks.map((ok, index) => ({
    checkId: `c${index}`,
    dimension: 'data_integrity',
    passed: ok,
    detail: ok ? 'ok' : 'no'
  }))
})

const run = (overrides: Partial<ArmRun> & Pick<ArmRun, 'arm'>): ArmRun => ({
  caseId: 'case-a',
  model: 'model-x',
  runtime: 'claude-code',
  seed: 7,
  result: result(true, [true, true]),
  ...overrides
})

describe('comparabilityProblems', () => {
  it('accepts four arms of one case at one model, runtime and seed', () => {
    const runs = [
      run({ arm: 'baseline' }),
      run({ arm: 'doc-only' }),
      run({ arm: 'named-no-contract' }),
      run({ arm: 'full-contract' })
    ]
    expect(comparabilityProblems(runs)).toEqual([])
  })

  it('names each mismatch per case', () => {
    const runs = [
      run({ arm: 'baseline' }),
      run({ arm: 'doc-only', model: 'model-y' }),
      run({ arm: 'named-no-contract', seed: 9 }),
      run({ arm: 'full-contract', runtime: 'codex' })
    ]
    const problems = comparabilityProblems(runs)
    expect(problems).toContain('case-a: models differ (model-x, model-y)')
    expect(problems).toContain('case-a: seeds differ (7, 9)')
    expect(problems).toContain('case-a: runtimes differ (claude-code, codex)')
  })

  it('judges comparability per case, not globally', () => {
    const runs = [
      run({ arm: 'baseline' }),
      run({ arm: 'doc-only' }),
      run({ arm: 'baseline', caseId: 'case-b', model: 'model-z' }),
      run({ arm: 'doc-only', caseId: 'case-b', model: 'model-z' })
    ]
    expect(comparabilityProblems(runs)).toEqual([])
  })
})

describe('summariseArms', () => {
  it('reports Pass@1 and the atomic rate per arm, and nulls for unrecorded usage', () => {
    const summaries = summariseArms([
      run({ arm: 'baseline', result: result(false, [true, false]) }),
      run({ arm: 'full-contract', result: result(true, [true, true]), inputTokens: 100 })
    ])
    const baseline = summaries.find((summary) => summary.arm === 'baseline')!
    expect(baseline).toMatchObject({ cases: 1, passed: 0, passAt1: 0, atomicPassRate: 0.5 })
    expect(baseline.meanInputTokens).toBeNull()
    expect(baseline.costComplete).toBe(false)

    const full = summaries.find((summary) => summary.arm === 'full-contract')!
    expect(full).toMatchObject({ cases: 1, passed: 1, passAt1: 1, atomicPassRate: 1 })
    expect(full.meanInputTokens).toBe(100)
    expect(full.totalCostUsd).toBeNull()
  })

  it('reports a total cost only when every run of the arm recorded one', () => {
    const complete = summariseArms([
      run({ arm: 'baseline', costUsd: 0.02 }),
      run({ arm: 'baseline', caseId: 'case-b', costUsd: 0.03 })
    ]).find((summary) => summary.arm === 'baseline')!
    expect(complete.costComplete).toBe(true)
    expect(complete.totalCostUsd).toBeCloseTo(0.05)

    const partial = summariseArms([
      run({ arm: 'baseline', costUsd: 0.02 }),
      run({ arm: 'baseline', caseId: 'case-b' })
    ]).find((summary) => summary.arm === 'baseline')!
    expect(partial.costComplete).toBe(false)
    expect(partial.totalCostUsd).toBeNull()
  })

  it('returns every arm even with no runs, with zeros rather than NaN', () => {
    const summaries = summariseArms([])
    expect(summaries.map((summary) => summary.arm)).toEqual([
      'baseline',
      'doc-only',
      'named-no-contract',
      'full-contract'
    ])
    for (const summary of summaries) expect(summary.passAt1).toBe(0)
  })
})

describe('renderArmTable', () => {
  it('omits the dollar column when costs are not fully recorded', () => {
    const table = renderArmTable(
      summariseArms([run({ arm: 'baseline' }), run({ arm: 'full-contract' })])
    )
    expect(table).not.toContain('cost')
    expect(table).toContain('| arm | cases | Pass@1 | atomic | in-tok | out-tok | wall |')
    expect(table).toContain('| baseline | 1 | 100.0% | 100.0% | n/a | n/a | n/a |')
  })

  it('shows the dollar column only when every arm recorded a cost', () => {
    const runs = [
      run({
        arm: 'baseline',
        costUsd: 0.02,
        inputTokens: 1000,
        outputTokens: 200,
        wallClockMs: 3000
      }),
      run({
        arm: 'doc-only',
        costUsd: 0.03,
        inputTokens: 1200,
        outputTokens: 210,
        wallClockMs: 3200
      }),
      run({ arm: 'named-no-contract', costUsd: 0.03 }),
      run({ arm: 'full-contract', costUsd: 0.04 })
    ]
    const table = renderArmTable(summariseArms(runs))
    expect(table).toContain('| arm | cases | Pass@1 | atomic | in-tok | out-tok | wall | cost |')
    expect(table).toContain('$0.02')
  })
})
