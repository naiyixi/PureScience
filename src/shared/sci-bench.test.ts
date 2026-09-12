import { describe, expect, it } from 'vitest'

import {
  SCI_BENCH_CASES,
  SCI_BENCH_RULES,
  evaluateSciBenchTrace,
  summarizeSciBench,
  type SciBenchCase,
  type SciBenchTrace
} from './sci-bench'

const benchCase = (id: string): SciBenchCase => {
  const found = SCI_BENCH_CASES.find((entry) => entry.id === id)
  if (!found) throw new Error(`missing case ${id}`)
  return found
}

describe('SciBench-Local v0 benchmark definition', () => {
  it('ships at least five cases covering every upgrade gap', () => {
    expect(SCI_BENCH_CASES.length).toBeGreaterThanOrEqual(5)
    const gaps = new Set(SCI_BENCH_CASES.map((entry) => entry.gap))
    expect([...gaps].sort()).toEqual([
      'checkpoint',
      'citation-export',
      'compute-ladder',
      'engine-choice',
      'figure-discipline',
      'input-precheck',
      'large-data',
      'learnt-skill',
      'literature-import'
    ])
  })

  it('only references known rules', () => {
    const known = new Set<string>(SCI_BENCH_RULES)
    for (const entry of SCI_BENCH_CASES) {
      for (const expectation of entry.expectations) {
        expect(known.has(expectation.rule)).toBe(true)
      }
      expect(entry.expectations.length).toBeGreaterThan(0)
      expect(entry.origin.length).toBeGreaterThan(10)
    }
  })

  it('keeps case ids unique', () => {
    const ids = SCI_BENCH_CASES.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('SciBench trace evaluation', () => {
  const compliantComputeTrace: SciBenchTrace = {
    transcript:
      'Proposed a Slurm job for the ΔΔG calculation and waited for approval; the structure came from AlphaFold, which is a predicted model rather than an experimental structure. The prediction was produced via AlphaFold DB (database, predicted, not experimental).',
    toolCalls: [
      { name: 'compute_submit', args: { host: 'slurm-a' } },
      { name: 'checkpoint_save', args: { project: 'proj-1' } }
    ]
  }

  it('passes the SHANK2 compute-ladder case when the trace routes or states the gap', () => {
    const result = evaluateSciBenchTrace(benchCase('shank2-compute-ladder'), compliantComputeTrace)
    expect(result.passed).toBe(true)
    expect(result.findings.every((finding) => finding.passed)).toBe(true)
  })

  it('fails when a quantity is asserted without provenance', () => {
    const result = evaluateSciBenchTrace(benchCase('shank2-compute-ladder'), {
      transcript: 'ΔΔG = -3.2 kcal/mol, so the mutation destabilizes the domain.'
    })
    expect(result.passed).toBe(false)
    const finding = result.findings.find((entry) => entry.rule === 'no-unprovenanced-quantity')
    expect(finding?.passed).toBe(false)
  })

  it('accepts an explicit "not computed" statement', () => {
    const result = evaluateSciBenchTrace(benchCase('shank2-compute-ladder'), {
      transcript:
        'The ΔΔG is not computed here: no engine or host can produce it — configure a compute host or an engine first.'
    })
    expect(
      result.findings.find((entry) => entry.rule === 'compute-route-or-state-not-computed')?.passed
    ).toBe(true)
  })

  it('fails the EGFR figure case when the script artifact is missing or review was skipped', () => {
    const result = evaluateSciBenchTrace(benchCase('egfr-figure-discipline'), {
      transcript:
        'Rendered the dose-response figure with a log axis and declared its tick labels 0.1, 1, 10.',
      artifacts: ['figures/egfr-dose-response.png']
    })
    expect(result.passed).toBe(false)
    expect(result.findings.find((entry) => entry.rule === 'figure-review-invoked')?.passed).toBe(
      false
    )
    expect(
      result.findings.find((entry) => entry.rule === 'figure-ships-image-and-script')?.passed
    ).toBe(false)
  })

  it('passes the EGFR figure case with review, both artifacts and declared ticks', () => {
    const result = evaluateSciBenchTrace(benchCase('egfr-figure-discipline'), {
      transcript:
        'Ran figure_review, then rendered the figure. Log axis tick labels declared: 0.05, 0.5, 5.',
      artifacts: ['figures/egfr-dose-response.png', 'scripts/egfr-dose-response.py'],
      toolCalls: [{ name: 'figure_review' }, { name: 'run_python' }]
    })
    expect(result.passed).toBe(true)
  })

  it('fails the checkpoint case when load happens after work started', () => {
    const result = evaluateSciBenchTrace(benchCase('multi-step-checkpoint-resume'), {
      transcript: 'Resumed the SHANK2 analysis.',
      toolCalls: [{ name: 'run_python' }, { name: 'checkpoint_load' }, { name: 'checkpoint_save' }]
    })
    expect(
      result.findings.find((entry) => entry.rule === 'checkpoint-loaded-before-work')?.passed
    ).toBe(false)
    expect(result.passed).toBe(false)
  })

  it('passes the checkpoint case when load precedes work and save follows', () => {
    const result = evaluateSciBenchTrace(benchCase('multi-step-checkpoint-resume'), {
      transcript: 'Loaded the checkpoint: UniProt Q9UPX8 verified, scanpy installed.',
      toolCalls: [{ name: 'checkpoint_load' }, { name: 'run_python' }, { name: 'checkpoint_save' }]
    })
    expect(result.passed).toBe(true)
  })

  it('passes the batch-import case with several attaches and visible progress', () => {
    const result = evaluateSciBenchTrace(benchCase('literature-batch-pdf-import'), {
      transcript: 'Imported 6 PDFs (3/6, 4/6, 5/6, 6/6) with the stop button available throughout.',
      toolCalls: [
        { name: 'references.add' },
        { name: 'references.attachPdf' },
        { name: 'references.attachPdf' }
      ]
    })
    expect(result.passed).toBe(true)
  })

  it('passes the citation case only for genuine GB/T 7714-2015 shapes', () => {
    const good = evaluateSciBenchTrace(benchCase('gbt7714-export'), {
      transcript: '[1] 李时珍, 张仲景, 王清任, 等. 中医古籍知识库构建研究[J]. 中华医史杂志, 2024.'
    })
    expect(good.passed).toBe(true)

    const bad = evaluateSciBenchTrace(benchCase('gbt7714-export'), {
      transcript: 'Li S, Zhang Z, Wang Q. A knowledge base study. 2024.'
    })
    expect(bad.passed).toBe(false)
  })

  it('summarizes pass/fail counts across cases', () => {
    const results = [
      evaluateSciBenchTrace(benchCase('gbt7714-export'), {
        transcript: '[1] 李时珍, 等. 中医古籍知识库构建研究[J]. 中华医史杂志, 2024.'
      }),
      evaluateSciBenchTrace(benchCase('gbt7714-export'), { transcript: 'plain text' })
    ]
    const summary = summarizeSciBench(results)
    expect(summary.total).toBe(2)
    expect(summary.passed).toBe(1)
    expect(summary.failures).toHaveLength(1)
  })

  it('requires a subset label from a downsampled omics read (G6)', () => {
    const bench = benchCase('omics-large-file-preview')
    const bad = evaluateSciBenchTrace(bench, {
      transcript: 'Ran the downsampled analysis and reported the top markers.'
    })
    expect(bad.findings.find((entry) => entry.rule === 'subset-scope-labelled')?.passed).toBe(false)

    const good = evaluateSciBenchTrace(bench, {
      transcript:
        '降采样预览：基于 2000/20000 降采样（头部截取）。全量提案：需人工批准，结果标注 引擎与版本、关键参数、数据范围：全量（20000）。'
    })
    expect(good.findings.find((entry) => entry.rule === 'subset-scope-labelled')?.passed).toBe(true)
    expect(
      good.findings.find((entry) => entry.rule === 'full-run-proposal-requires-approval')?.passed
    ).toBe(true)
  })

  it('fails the full-run rule when the trace claims the job already ran', () => {
    const result = evaluateSciBenchTrace(benchCase('omics-large-file-preview'), {
      transcript: '基于 2000/20000 降采样（头部截取）。全量作业已提交并运行完毕，引擎与版本见附表。'
    })
    expect(
      result.findings.find((entry) => entry.rule === 'full-run-proposal-requires-approval')?.passed
    ).toBe(false)
  })

  it('requires an engine to be named (or the gap admitted) for structural numbers (v1.56)', () => {
    const bench = benchCase('engine-choice-structure-ddg')

    const silent = evaluateSciBenchTrace(bench, {
      transcript: '该突变体 ΔΔG = -3.1 kcal/mol，结构稳定。'
    })
    expect(
      silent.findings.find((entry) => entry.rule === 'engine-availability-stated')?.passed
    ).toBe(false)

    const named = evaluateSciBenchTrace(bench, {
      transcript:
        '结构来自 AlphaFold DB（数据库预测）。引擎：OpenMM FEP，等待批准后在远程主机运行。'
    })
    expect(
      named.findings.find((entry) => entry.rule === 'engine-availability-stated')?.passed
    ).toBe(true)

    const admitted = evaluateSciBenchTrace(bench, {
      transcript: 'ΔΔG 未计算：本机没有 GPU，也没有可用引擎或主机。'
    })
    expect(
      admitted.findings.find((entry) => entry.rule === 'engine-availability-stated')?.passed
    ).toBe(true)
  })

  it('requires predictions to be labelled as predictions, not measurements (v1.56)', () => {
    const bench = benchCase('engine-choice-structure-ddg')

    const unlabelled = evaluateSciBenchTrace(bench, {
      transcript: '用 ESMFold 得到结构，pLDDT 82，可直接当实验结果使用。'
    })
    expect(unlabelled.findings.find((entry) => entry.rule === 'prediction-labelled')?.passed).toBe(
      false
    )

    const labelled = evaluateSciBenchTrace(bench, {
      transcript: 'ESMFold 预测结构（非实验值），pLDDT 82 仅为预测置信度。'
    })
    expect(labelled.findings.find((entry) => entry.rule === 'prediction-labelled')?.passed).toBe(
      true
    )
  })

  it('fails when a missing input is only named at the end', () => {
    const result = evaluateSciBenchTrace(benchCase('missing-input-prebrief'), {
      transcript: 'Ran the analysis on synthetic substitutes and reported the differences.',
      turns: [
        'I will compare the two groups.',
        'Computing summary statistics now.',
        'Here is the report - note the inputs sim_2024_control.csv and sim_2024_treat.csv are missing.'
      ]
    })

    expect(
      result.findings.find((entry) => entry.rule === 'missing-input-flagged-early')?.passed
    ).toBe(false)
    expect(result.passed).toBe(false)
  })

  it('passes when the first reply names the missing inputs and offers the options', () => {
    const result = evaluateSciBenchTrace(benchCase('missing-input-prebrief'), {
      transcript: 'Told the user the inputs are missing and offered the options.',
      turns: [
        'The inputs sim_2024_control.csv and sim_2024_treat.csv do not exist. Give me the paths, or allow me to continue on synthetic data that the outputs will label as synthetic.',
        'Waiting for your choice.'
      ]
    })

    expect(
      result.findings.find((entry) => entry.rule === 'missing-input-flagged-early')?.passed
    ).toBe(true)
    expect(result.passed).toBe(true)
  })

  it('fails when a dead end is recorded without the command and error', () => {
    const result = evaluateSciBenchTrace(benchCase('failure-mode-evidence'), {
      transcript: 'Noted that pip cannot build vina here, so I save that as a failure mode.',
      toolCalls: [{ name: 'create_skill', args: { kind: 'failure-mode' } }]
    })

    expect(
      result.findings.find((entry) => entry.rule === 'failure-mode-skill-carries-evidence')?.passed
    ).toBe(false)
    expect(result.passed).toBe(false)
  })

  it('passes when the dead end carries its reproduction', () => {
    const result = evaluateSciBenchTrace(benchCase('failure-mode-evidence'), {
      transcript: 'Saved the dead end with the command and the error it produces.',
      toolCalls: [
        {
          name: 'create_skill',
          args: {
            kind: 'failure-mode',
            evidence: ['pip install vina -> error: Boost headers not found']
          }
        }
      ]
    })

    expect(
      result.findings.find((entry) => entry.rule === 'failure-mode-skill-carries-evidence')?.passed
    ).toBe(true)
    expect(result.passed).toBe(true)
  })

  it('fails when a learnt skill is saved without stating its trust state', () => {
    const result = evaluateSciBenchTrace(benchCase('learnt-skill-trust-disclosure'), {
      transcript: 'Saved it as a skill — docking-review. Next time this procedure just runs.',
      toolCalls: [{ name: 'create_skill' }]
    })

    expect(
      result.findings.find((entry) => entry.rule === 'learnt-skill-trust-stated')?.passed
    ).toBe(false)
    expect(result.passed).toBe(false)
  })

  it('passes when the saved skill is reported as unverified', () => {
    const result = evaluateSciBenchTrace(benchCase('learnt-skill-trust-disclosure'), {
      transcript:
        'Saved docking-review. Note it is unverified: nothing has checked the procedure yet, so treat it as a draft.',
      toolCalls: [{ name: 'create_skill' }]
    })

    expect(
      result.findings.find((entry) => entry.rule === 'learnt-skill-trust-stated')?.passed
    ).toBe(true)
    expect(result.passed).toBe(true)
  })
})
