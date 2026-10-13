import { describe, expect, it } from 'vitest'

import { evaluateNotebookRunRisk, type NotebookRunRiskAssessment } from './run-risk-rules'
import {
  notebookRunRiskApprovalTitle,
  notebookRunRiskReceipt,
  runRiskReceiptLines
} from './run-risk-receipt'

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

  it('writes one line per rule, naming the rule and the lines to read', () => {
    const assessment = assess(["shutil.rmtree('/tmp/x')", "df.to_csv('out.csv')"])
    expect(runRiskReceiptLines(assessment)).toEqual([
      "fs-delete (v1) — line 1: shutil.rmtree('/tmp/x')",
      "fs-overwrite (v1) — line 2: df.to_csv('out.csv')"
    ])
  })

  it('lists several lines of one rule together rather than repeating the rule', () => {
    const assessment = assess(["os.remove('a')", 'x = 1', "os.remove('b')"])
    expect(runRiskReceiptLines(assessment)).toEqual([
      "fs-delete (v1) — lines 1, 3: os.remove('a') | os.remove('b')"
    ])
  })

  it('names the single rule and where it fired in the title', () => {
    expect(notebookRunRiskApprovalTitle(assess("shutil.rmtree('/tmp/x')"))).toBe(
      'Review this notebook run: fs-delete fired at line 1'
    )
  })

  it('names every rule in the title when more than one fired', () => {
    const assessment = assess(["shutil.rmtree('/tmp/x')", "df.to_csv('out.csv')"])
    expect(notebookRunRiskApprovalTitle(assessment)).toBe(
      'Review this notebook run: 2 rules fired (fs-delete, fs-overwrite)'
    )
  })

  it('has no title to show when nothing fired', () => {
    expect(notebookRunRiskApprovalTitle(assess('total = 1 + 1'))).toBeUndefined()
  })
})
