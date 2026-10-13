import { describe, expect, it } from 'vitest'

import { evaluateNotebookRunRisk, type NotebookRunRiskAssessment } from './run-risk-rules'
import { notebookRunRiskReceipt } from './run-risk-receipt'

const assess = (source: string | string[]): NotebookRunRiskAssessment =>
  evaluateNotebookRunRisk(Array.isArray(source) ? source.join('\n') : source)

describe('run risk receipt', () => {
  it('keeps the names a recomputation needs: rule, version, verdict, hash', () => {
    const assessment = assess("shutil.rmtree('/tmp/run')")
    const receipt = notebookRunRiskReceipt(assessment)
    expect(receipt.verdict).toBe('review')
    expect(receipt.ruleSetVersion).toBe(assessment.ruleSetVersion)
    expect(receipt.codeHash).toBe(assessment.codeHash)
    expect(receipt.hits).toEqual([
      {
        ruleId: 'fs-delete',
        ruleVersion: 'v1',
        lines: [1],
        excerpts: ["shutil.rmtree('/tmp/run')"]
      }
    ])
  })

  it('is a copy: mutating the assessment afterwards cannot rewrite what was recorded', () => {
    const assessment = assess("shutil.rmtree('/tmp/run')")
    const receipt = notebookRunRiskReceipt(assessment)
    assessment.hits[0].lines.push(999)
    assessment.hits[0].excerpts.push('tampered')
    expect(receipt.hits[0].lines).toEqual([1])
    expect(receipt.hits[0].excerpts).toEqual(["shutil.rmtree('/tmp/run')"])
  })

  it('is plain data a record can hold', () => {
    const receipt = notebookRunRiskReceipt(assess("open('out.txt', 'w')"))
    expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt)
  })
})
