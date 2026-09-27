/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Verdict for the flaky-test report written by scripts/ci/flaky-tests-reporter.mjs.
//
// Fails CLOSED on every uncertain input: a missing report, unreadable JSON, or a report whose shape
// is not the one this script writes all mean "we cannot prove the run was stable", which is a
// failure — never a pass. A lane that forgets the reporter would otherwise report green while
// measuring nothing, which is exactly the silent-degradation class this pair of scripts exists to
// prevent.
//
// Usage: node scripts/ci/check-flaky-tests.mjs [path]
//   exit 0 — report parsed, retry budget applied, no unstable test
//   exit 1 — unstable tests found, or the report is missing/unreadable/unrecognised
//
// The verdict logic is exported (evaluateFlakyReport) so scripts/ci/check-flaky-tests.test.ts can
// pin every branch without spawning a process.

import { readFileSync } from 'node:fs'

const DEFAULT_REPORT_PATH = 'flaky-tests.json'

/**
 * @param {{ report?: unknown, readError?: Error }} input
 * @returns {{ ok: boolean, summary: string, detail?: string }}
 */
export function evaluateFlakyReport({ report, readError } = {}) {
  if (readError) {
    return {
      ok: false,
      summary: 'flaky-test report could not be read',
      detail: `${readError.message}\n  The lane must run vitest with --retry=1 and --reporter=./scripts/ci/flaky-tests-reporter.mjs.`
    }
  }

  if (typeof report !== 'object' || report === null || !Array.isArray(report.unstable)) {
    return {
      ok: false,
      summary: 'flaky-test report has an unrecognised shape',
      detail:
        '  Expected the object written by scripts/ci/flaky-tests-reporter.mjs (with an `unstable` array).'
    }
  }

  const retryBudget = Number(report.retryBudget ?? 0)
  if (!Number.isFinite(retryBudget) || retryBudget < 1) {
    return {
      ok: false,
      summary: `the run had no retry budget (retryBudget=${report.retryBudget ?? 'missing'})`,
      detail:
        '  Without retries a test cannot be caught passing on a second attempt, so this run cannot prove stability. Pass --retry=1.'
    }
  }

  if (report.unstable.length > 0) {
    const lines = report.unstable
      .map(
        (test) => `  - ${test.name} [${test.project}] (${test.file}) retried ${test.retryCount}x`
      )
      .join('\n')

    return {
      ok: false,
      summary: `${report.unstable.length} unstable test${report.unstable.length === 1 ? '' : 's'} passed only after a retry`,
      detail: `${lines}\n  Unstable tests are treated as failures here: the retry is what keeps CI green, so a\n  passing-after-retry result would otherwise hide a real race, timeout or shared-state leak.`
    }
  }

  return {
    ok: true,
    summary: `No unstable tests: report v${report.version ?? '?'}, retry budget ${retryBudget}, ${report.unhandledErrorCount ?? 0} unhandled error(s).`
  }
}

/** @returns {{ report?: unknown, readError?: Error }} */
export function readFlakyReport(path) {
  try {
    return { report: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { readError: error }
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (isMain) {
  const reportPath = process.argv[2] ?? process.env.PURESCIENCE_FLAKY_REPORT ?? DEFAULT_REPORT_PATH
  const verdict = evaluateFlakyReport(readFlakyReport(reportPath))

  if (!verdict.ok) {
    console.error(`✗ ${verdict.summary}${reportPath ? ` (${reportPath})` : ''}`)
    if (verdict.detail) console.error(verdict.detail)
    process.exit(1)
  }

  console.log(`✓ ${verdict.summary}`)
}
