import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { evaluateNotebookRunRisk, type NotebookRunRiskAssessment } from './run-risk-rules'
import {
  NotebookRunDeclinedError,
  notebookRunRiskReceipt,
  notebookRunSourceHash,
  resolveNotebookRunRiskGate
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

  describe('resolveNotebookRunRiskGate', () => {
    const risky = "shutil.rmtree('/tmp/x')"
    const safe = 'total = 1 + 1'

    it('passes a cell the review finds nothing in, without asking', async () => {
      const reviewer = vi.fn()
      const { gate, receipt } = await resolveNotebookRunRiskGate({ code: safe, reviewer })
      expect(gate).toBe('pass')
      expect(receipt.verdict).toBe('allow')
      expect(reviewer).not.toHaveBeenCalled()
    })

    it('passes the receipt through to the reviewer and reports an approval', async () => {
      const reviewer = vi.fn().mockResolvedValue(true)
      const { gate, receipt } = await resolveNotebookRunRiskGate({
        code: risky,
        sessionId: 'session-1',
        language: 'python',
        reviewer
      })
      expect(gate).toBe('allow')
      expect(reviewer).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1', code: risky, receipt })
      )
      expect(receipt.hits[0].ruleId).toBe('fs-delete')
    })

    it('reports a decline without running anything itself', async () => {
      const { gate } = await resolveNotebookRunRiskGate({
        code: risky,
        reviewer: async () => false
      })
      expect(gate).toBe('decline')
    })

    it('names a needed review that had no approver instead of calling it passed', async () => {
      const { gate, receipt } = await resolveNotebookRunRiskGate({ code: risky })
      expect(gate).toBe('unreviewed')
      expect(receipt.verdict).toBe('review')
    })
  })

  it('names the refused rules on the decline error, so a caller can say what it refused', () => {
    const error = new NotebookRunDeclinedError(['fs-delete', 'shell-exec'])
    expect(error.name).toBe('NotebookRunDeclinedError')
    expect(error.ruleIds).toEqual(['fs-delete', 'shell-exec'])
    expect(error.message).toContain('fs-delete')
  })
})

// The read side needs the hash without a receipt (records written before receipts existed). It must be
// the SAME value a receipt would carry — this test holds the two paths together by comparing them
// against a hash computed here, the way a third party recomputing the published recipe would.
describe('notebookRunSourceHash', () => {
  const independent = (source: string): string =>
    createHash('sha256').update(source, 'utf8').digest('hex')

  it('equals the hash the receipt carries for the same cell source', () => {
    const sources = ['df = load()', "shutil.rmtree('/tmp/run')", '注意：中文注释\nx = 1', '']
    for (const source of sources) {
      expect(notebookRunSourceHash(source)).toBe(independent(source))
      expect(notebookRunSourceHash(source)).toBe(assess(source).codeHash)
      expect(notebookRunSourceHash(source)).toBe(notebookRunRiskReceipt(assess(source)).codeHash)
    }
  })
})
