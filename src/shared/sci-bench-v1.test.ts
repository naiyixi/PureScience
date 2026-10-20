import { describe, expect, it } from 'vitest'

import { SCI_BENCH_V1_CASES } from './sci-bench-v1-cases'
import {
  DIMENSIONS,
  coverageMatrix,
  evaluateBenchCase,
  summariseBench,
  type BenchEvidence
} from './sci-bench-v1'

// Evidence that satisfies the checkpoint case on purpose: "restored the last checkpoint" is stated,
// the load happens before the save, and neither forbidden pattern appears.
const resumeEvidence: BenchEvidence = {
  transcript: '恢复了上次的检查点结果，接着做富集分析。',
  turns: ['这里缺结构文件，我先说明：需要 PDB 或序列才能计算。'],
  toolCalls: [{ name: 'checkpoint_load' }, { name: 'checkpoint_save' }]
}

const checkpointCase = SCI_BENCH_V1_CASES.find((item) => item.id === 'checkpoint-resume-order')!

describe('SciBench v1 corpus', () => {
  it('ships at least two cases per dimension, each with a real origin', () => {
    expect(SCI_BENCH_V1_CASES.length).toBeGreaterThanOrEqual(12)
    const coverage = coverageMatrix(SCI_BENCH_V1_CASES)
    for (const dimension of DIMENSIONS) {
      expect(coverage[dimension].cases).toBeGreaterThanOrEqual(2)
    }
    for (const item of SCI_BENCH_V1_CASES) {
      expect(item.origin.trim().length).toBeGreaterThan(3)
      expect(item.prompt.trim().length).toBeGreaterThan(5)
      expect(item.checks.length).toBeGreaterThanOrEqual(2)
      expect(['easy', 'medium', 'hard']).toContain(item.difficulty)
    }
  })

  it('labels every case difficulty, and covers all three levels', () => {
    const levels = new Set(SCI_BENCH_V1_CASES.map((item) => item.difficulty))
    expect([...levels].sort()).toEqual(['easy', 'hard', 'medium'])
  })

  it('keeps a coverage matrix whose counts match the corpus', () => {
    const coverage = coverageMatrix(SCI_BENCH_V1_CASES)
    const total = Object.values(coverage).reduce((sum, entry) => sum + entry.cases, 0)
    expect(total).toBe(SCI_BENCH_V1_CASES.length)
    expect(coverage.tool_grounding.ids).toContain('citation-chain-grounded')
    expect(coverage.tool_grounding.ids).toContain('structure-source-grounded')
    expect(coverage.tool_grounding.cases).toBe(coverage.tool_grounding.ids.length)
  })

  it('compiles every pattern in the corpus', () => {
    // A regex that throws at grading time would look like a failed case, not a broken benchmark.
    for (const item of SCI_BENCH_V1_CASES) {
      for (const check of item.checks) {
        if ('pattern' in check) expect(() => new RegExp(check.pattern, 'i')).not.toThrow()
      }
    }
  })

  it('keeps every check id unique across the corpus', () => {
    const ids = SCI_BENCH_V1_CASES.flatMap((item) => item.checks.map((check) => check.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never names a library in a prompt or a check pattern', () => {
    // Package-agnostic is the whole point: a check that names a library turns the benchmark into a
    // test of the author's favourite stack.
    const libraries = [
      'scanpy',
      'seurat',
      'anndata',
      'scvi',
      'bioconductor',
      'pydeseq2',
      'matplotlib'
    ]
    const haystack = SCI_BENCH_V1_CASES.flatMap((item) => [
      item.prompt,
      ...item.checks.map((check) => ('pattern' in check ? check.pattern : ''))
    ])
    for (const text of haystack) {
      for (const library of libraries) expect(text.toLowerCase()).not.toContain(library)
    }
  })
})

describe('evaluateBenchCase', () => {
  it('passes a case only when every atomic check passes', () => {
    const result = evaluateBenchCase(checkpointCase, resumeEvidence)
    expect(result.findings.map((finding) => finding.passed)).toEqual([true, true, true])
    expect(result.passed).toBe(true)
    expect(result.atomicPassRate).toBe(1)
  })

  it('reports the atomic pass-rate separately from the case verdict', () => {
    const partial = evaluateBenchCase(checkpointCase, {
      ...resumeEvidence,
      toolCalls: [{ name: 'checkpoint_save' }, { name: 'checkpoint_load' }]
    })
    expect(partial.passed).toBe(false)
    expect(partial.atomicPassRate).toBeCloseTo(2 / 3)
  })

  it('fails a number that carries no provenance', () => {
    const benchCase = SCI_BENCH_V1_CASES.find((item) => item.id === 'structure-source-grounded')!
    const result = evaluateBenchCase(benchCase, {
      transcript: '预测结构（predicted，非实验结构）',
      toolCalls: [{ name: 'alphafold_get_prediction' }],
      numbers: [{ label: 'pLDDT', value: 88.4 }]
    })
    const numberCheck = result.findings.find((finding) => finding.checkId === 'plddt-provenanced')
    expect(numberCheck?.passed).toBe(false)
    expect(result.passed).toBe(false)
  })

  it('fails a figure that arrived without its producing script', () => {
    const benchCase = SCI_BENCH_V1_CASES.find((item) => item.id === 'analysis-artifact-pairing')!
    const result = evaluateBenchCase(benchCase, {
      transcript: '数据源来自 assay_summary.csv',
      artifacts: ['out/assay_dotplot.png'],
      numbers: [
        { label: 'mean IC50', value: 12.5, provenance: 'pandas 2.2 over assay_summary.csv' }
      ]
    })
    const pairing = result.findings.find((finding) => finding.checkId === 'figure-with-script')
    expect(pairing?.passed).toBe(false)
    expect(pairing?.detail).toBe('artifact present but no producing script recorded')
  })

  it('is deterministic across repeated grading', () => {
    expect(evaluateBenchCase(checkpointCase, resumeEvidence)).toEqual(
      evaluateBenchCase(checkpointCase, resumeEvidence)
    )
  })

  it('treats an empty evidence set as failing, not as vacuously passing', () => {
    for (const benchCase of SCI_BENCH_V1_CASES) {
      expect(evaluateBenchCase(benchCase, { transcript: '' }).passed).toBe(false)
    }
  })
})

describe('summariseBench', () => {
  it('reports Pass@1 and the atomic pass-rate together', () => {
    const summary = summariseBench([
      evaluateBenchCase(checkpointCase, resumeEvidence),
      evaluateBenchCase(checkpointCase, { transcript: '检查点' })
    ])
    expect(summary.cases).toBe(2)
    expect(summary.passed).toBe(1)
    expect(summary.passAt1).toBe(0.5)
    expect(summary.atomicPassRate).toBeGreaterThan(0.5)
    expect(summary.atomicPassRate).toBeLessThan(1)
  })

  it('is zero-safe with no cases', () => {
    expect(summariseBench([])).toEqual({ cases: 0, passed: 0, passAt1: 0, atomicPassRate: 0 })
  })
})
