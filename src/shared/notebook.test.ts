import { describe, it, expect } from 'vitest'
import { sanitizeNotebookRunRiskReceipt } from './notebook'
import type { NotebookLanguage, NotebookOutput, NotebookCell } from './notebook'

describe('shared notebook types', () => {
  it('NotebookLanguage admits python and r', () => {
    const langs: NotebookLanguage[] = ['python', 'r']
    expect(langs).toEqual(['python', 'r'])
  })

  it('NotebookOutput supports a display (mime bundle) variant', () => {
    const output: NotebookOutput = {
      type: 'display',
      data: { 'text/plain': '42', 'image/png': 'iVBORw0KGgo=' }
    }
    expect(output.type).toBe('display')
    // data is a string→string mime bundle
    expect(output.data['text/plain']).toBe('42')
  })

  it('NotebookCell.language is a NotebookLanguage', () => {
    const cell: NotebookCell = { id: 'c1', language: 'r', code: '1+1', status: 'idle' }
    expect(cell.language).toBe('r')
  })
})

describe('notebook run risk receipt sanitizing', () => {
  const valid = {
    verdict: 'review' as const,
    ruleSetVersion: 'notebook-run-risk:v1',
    codeHash: 'a'.repeat(64),
    hits: [
      {
        ruleId: 'fs-delete' as const,
        ruleVersion: 'v1',
        lines: [2],
        excerpts: ["shutil.rmtree('/tmp/x')"]
      }
    ]
  }

  it('keeps a well-formed receipt, copying its arrays', () => {
    const sanitized = sanitizeNotebookRunRiskReceipt(valid)
    expect(sanitized).toEqual(valid)
    expect(sanitized?.hits[0].lines).not.toBe(valid.hits[0].lines)
  })

  it('drops the WHOLE receipt when any part of it is malformed', () => {
    const cases: unknown[] = [
      null,
      'receipt',
      { ...valid, verdict: 'maybe' },
      { ...valid, ruleSetVersion: '' },
      { ...valid, codeHash: 'not-a-hash' },
      { ...valid, hits: [{ ...valid.hits[0], ruleId: 'made-up-rule' }] },
      { ...valid, hits: [{ ...valid.hits[0], ruleVersion: '' }] },
      { ...valid, hits: [{ ...valid.hits[0], lines: [] }] },
      { ...valid, hits: [{ ...valid.hits[0], lines: [0] }] },
      { ...valid, hits: [{ ...valid.hits[0], lines: [1, 2] }] },
      { ...valid, hits: [{ ...valid.hits[0], excerpts: [1] }] },
      {
        verdict: 'review',
        ruleSetVersion: 'notebook-run-risk:v1',
        codeHash: 'a'.repeat(64),
        hits: []
      },
      {
        verdict: 'allow',
        ruleSetVersion: 'notebook-run-risk:v1',
        codeHash: 'a'.repeat(64),
        hits: valid.hits
      }
    ]
    for (const value of cases) {
      expect(
        sanitizeNotebookRunRiskReceipt(value),
        JSON.stringify(value)?.slice(0, 60)
      ).toBeUndefined()
    }
  })

  it('accepts an allow with no hits: that is a real assessment, not a missing one', () => {
    const allow = {
      verdict: 'allow' as const,
      ruleSetVersion: 'notebook-run-risk:v1',
      codeHash: 'b'.repeat(64),
      hits: []
    }
    expect(sanitizeNotebookRunRiskReceipt(allow)).toEqual(allow)
  })
})
