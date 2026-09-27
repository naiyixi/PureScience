import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { evaluateFlakyReport, readFlakyReport } from './check-flaky-tests.mjs'

const stableReport = {
  version: 1,
  reason: 'passed',
  retryBudget: 1,
  unhandledErrorCount: 0,
  unstable: []
}

describe('flaky-test verdict', () => {
  it('accepts a retry-enabled run with no unstable test', () => {
    const verdict = evaluateFlakyReport({ report: stableReport })

    expect(verdict.ok).toBe(true)
    expect(verdict.summary).toContain('retry budget 1')
  })

  it('names every test that passed only after a retry', () => {
    const verdict = evaluateFlakyReport({
      report: {
        ...stableReport,
        unstable: [
          {
            name: 'session store > flushes on idle',
            file: 'src/renderer/src/stores/session-store.test.ts',
            project: 'unit',
            retryCount: 1,
            state: 'passed'
          }
        ]
      }
    })

    expect(verdict.ok).toBe(false)
    expect(verdict.summary).toBe('1 unstable test passed only after a retry')
    expect(verdict.detail).toContain('session store > flushes on idle')
    expect(verdict.detail).toContain('retried 1x')
    expect(verdict.detail).toContain('src/renderer/src/stores/session-store.test.ts')
  })

  it('fails closed when the report is missing or unreadable', () => {
    const verdict = evaluateFlakyReport({ readError: new Error('ENOENT: no such file') })

    expect(verdict.ok).toBe(false)
    expect(verdict.summary).toContain('could not be read')
    expect(verdict.detail).toContain('--reporter=./scripts/ci/flaky-tests-reporter.mjs')
  })

  it('fails closed on an unrecognised report shape', () => {
    // A JSON file that parses but is not ours (e.g. vitest's own --reporter=json output) must never be
    // read as "no flaky tests".
    for (const report of [null, 'passed', { testResults: [] }, { unstable: 'none' }]) {
      const verdict = evaluateFlakyReport({ report })
      expect(verdict.ok, JSON.stringify(report)).toBe(false)
      expect(verdict.summary).toContain('unrecognised shape')
    }
  })

  it('rejects a run that never enabled retries', () => {
    // Without a retry budget "no unstable tests" is vacuous — the run cannot detect the condition at
    // all, so it must not be reported as stable.
    for (const retryBudget of [undefined, 0, -1, 'none']) {
      const verdict = evaluateFlakyReport({ report: { ...stableReport, retryBudget } })
      expect(verdict.ok, String(retryBudget)).toBe(false)
      expect(verdict.summary).toContain('no retry budget')
    }
  })

  it('reads a report from disk and reports the parse failure instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flaky-report-'))
    const validPath = join(dir, 'valid.json')
    writeFileSync(validPath, JSON.stringify(stableReport))
    expect(readFlakyReport(validPath).report).toEqual(stableReport)

    const brokenPath = join(dir, 'broken.json')
    writeFileSync(brokenPath, '{ not json')
    const broken = readFlakyReport(brokenPath)
    expect(broken.report).toBeUndefined()
    expect(broken.readError).toBeInstanceOf(Error)

    expect(readFlakyReport(join(dir, 'absent.json')).readError).toBeInstanceOf(Error)
  })
})
