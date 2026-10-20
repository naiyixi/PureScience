// SciBench v1 · the four-arm comparison (v2.17 S3 groundwork).
//
// The point of the arms is one question: when a case gets better, was it the contract layer or just
// more text? That only holds if the arms are actually comparable — same model, same runtime, same
// seed, same case. This module refuses to compare when they are not, and it refuses to print a
// dollar figure when the session never recorded one: an estimated price is not a measurement.

import type { CaseResult } from './sci-bench-v1'

export const ARM_IDS = ['baseline', 'doc-only', 'named-no-contract', 'full-contract'] as const

export type ArmId = (typeof ARM_IDS)[number]

export const ARM_LABELS: Record<ArmId, string> = {
  baseline: 'A1 baseline — skill catalog + free-form code',
  'doc-only': 'A2 doc-only — full skill body injected',
  'named-no-contract': 'A3 named, no contract — tool names visible',
  'full-contract': 'A4 full contract — requires/produces/preflight on'
}

export type ArmRun = {
  arm: ArmId
  caseId: string
  /** Everything that has to match across arms for the comparison to mean anything. */
  model: string
  runtime: string
  seed: number
  result: CaseResult
  /** Recorded usage. Absent means "not measured", never "zero". */
  inputTokens?: number
  outputTokens?: number
  wallClockMs?: number
  /** Only when the provider actually billed it. Absent blocks a dollar column. */
  costUsd?: number
}

export type ArmSummary = {
  arm: ArmId
  cases: number
  passed: number
  passAt1: number
  atomicPassRate: number
  /** Null when nothing was recorded — a summary must not invent a zero. */
  meanInputTokens: number | null
  meanOutputTokens: number | null
  meanWallClockMs: number | null
  totalCostUsd: number | null
  /** True only when every run of this arm carried a recorded cost. */
  costComplete: boolean
}

const mean = (values: number[]): number | null =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null

/** Groups runs by case → arm, so comparability is judged per case, not globally. */
const groupByCase = (runs: readonly ArmRun[]): Map<string, Map<ArmId, ArmRun[]>> => {
  const byCase = new Map<string, Map<ArmId, ArmRun[]>>()
  for (const run of runs) {
    const arms = byCase.get(run.caseId) ?? new Map<ArmId, ArmRun[]>()
    const list = arms.get(run.arm) ?? []
    list.push(run)
    arms.set(run.arm, list)
    byCase.set(run.caseId, arms)
  }
  return byCase
}

/**
 * @returns the reasons a comparison would be meaningless, named per case and arm.
 *   An empty array means every case's arms used one model, one runtime and one seed.
 */
export const comparabilityProblems = (runs: readonly ArmRun[]): string[] => {
  const problems: string[] = []
  for (const [caseId, arms] of groupByCase(runs)) {
    const models = new Set<string>()
    const runtimes = new Set<string>()
    const seeds = new Set<number>()
    for (const list of arms.values()) {
      for (const run of list) {
        models.add(run.model)
        runtimes.add(run.runtime)
        seeds.add(run.seed)
      }
    }
    if (models.size > 1) problems.push(`${caseId}: models differ (${[...models].join(', ')})`)
    if (runtimes.size > 1) problems.push(`${caseId}: runtimes differ (${[...runtimes].join(', ')})`)
    if (seeds.size > 1) problems.push(`${caseId}: seeds differ (${[...seeds].join(', ')})`)
  }
  return problems
}

export const summariseArms = (runs: readonly ArmRun[]): ArmSummary[] =>
  ARM_IDS.map((arm) => {
    const selected = runs.filter((run) => run.arm === arm)
    const cases = selected.length
    const passed = selected.filter((run) => run.result.passed).length
    const atomic = selected.flatMap((run) => run.result.findings)
    const inputTokens = selected
      .map((run) => run.inputTokens)
      .filter((value): value is number => typeof value === 'number')
    const outputTokens = selected
      .map((run) => run.outputTokens)
      .filter((value): value is number => typeof value === 'number')
    const wall = selected
      .map((run) => run.wallClockMs)
      .filter((value): value is number => typeof value === 'number')
    const costs = selected
      .map((run) => run.costUsd)
      .filter((value): value is number => typeof value === 'number')

    return {
      arm,
      cases,
      passed,
      passAt1: cases ? passed / cases : 0,
      atomicPassRate: atomic.length
        ? atomic.filter((finding) => finding.passed).length / atomic.length
        : 0,
      meanInputTokens: mean(inputTokens),
      meanOutputTokens: mean(outputTokens),
      meanWallClockMs: mean(wall),
      totalCostUsd: cases && costs.length === cases ? costs.reduce((sum, v) => sum + v, 0) : null,
      costComplete: cases > 0 && costs.length === cases
    }
  })

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`

/**
 * Markdown table. The dollar column appears only when every arm recorded a cost — otherwise the
 * table says costs were not recorded, rather than showing a number nobody measured.
 */
export const renderArmTable = (summaries: readonly ArmSummary[]): string => {
  const withCost = summaries.length > 0 && summaries.every((summary) => summary.costComplete)
  const header = withCost
    ? '| arm | cases | Pass@1 | atomic | in-tok | out-tok | wall | cost |'
    : '| arm | cases | Pass@1 | atomic | in-tok | out-tok | wall |'
  const divider = withCost ? '|---|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|---|'
  const rows = summaries.map((summary) => {
    const tokens = [
      summary.meanInputTokens === null ? 'n/a' : Math.round(summary.meanInputTokens).toString(),
      summary.meanOutputTokens === null ? 'n/a' : Math.round(summary.meanOutputTokens).toString(),
      summary.meanWallClockMs === null ? 'n/a' : `${(summary.meanWallClockMs / 1000).toFixed(1)}s`
    ]
    const cells = [
      summary.arm,
      `${summary.cases}`,
      summary.cases ? pct(summary.passAt1) : 'n/a',
      summary.cases ? pct(summary.atomicPassRate) : 'n/a',
      ...tokens
    ]
    if (withCost)
      cells.push(summary.totalCostUsd === null ? 'n/a' : `$${summary.totalCostUsd.toFixed(2)}`)
    return `| ${cells.join(' | ')} |`
  })
  return [header, divider, ...rows].join('\n')
}
