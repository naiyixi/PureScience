/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Vitest reporter that records UNSTABLE tests (fail → pass on retry) to a JSON file.
//
// Why this exists instead of a flag: Vitest 4 has no `--fail-on-flaky-tests` — passing it aborts the
// run with `CACError: Unknown option --failOnFlakyTests` (verified against 4.1.11). The information
// is still there (`TestCase.diagnostic()` exposes `retryCount` and `flaky`), so the scheduled lane
// collects it with this reporter and then lets scripts/ci/check-flaky-tests.mjs decide the verdict.
//
// Usage:
//   npx vitest run --retry=1 \
//     --reporter=default --reporter=./scripts/ci/flaky-tests-reporter.mjs
//   node scripts/ci/check-flaky-tests.mjs [report.json]
//
// The output file can be moved with PURESCIENCE_FLAKY_REPORT (the workflow sets it so the report lands
// in the uploaded artifact rather than the repository root).

import { writeFileSync } from 'node:fs'

const DEFAULT_REPORT_PATH = 'flaky-tests.json'

export default class FlakyTestsReporter {
  #unstable = []
  #path

  constructor(options = {}) {
    this.#path = options.outputFile ?? process.env.PURESCIENCE_FLAKY_REPORT ?? DEFAULT_REPORT_PATH
  }

  onTestCaseResult(testCase) {
    const diagnostic = testCase.diagnostic?.()
    if (!diagnostic) return

    const retryCount = diagnostic.retryCount ?? 0
    // Retried-and-failed tests are already reported as failures; the case this reporter exists for is
    // the one that PASSED only because it was retried — green on the board, unstable in reality.
    if (retryCount > 0 && diagnostic.flaky) {
      this.#unstable.push({
        name: testCase.fullName,
        file: testCase.module?.relativePath ?? testCase.module?.moduleId ?? 'unknown',
        project: testCase.project?.name ?? 'unknown',
        retryCount,
        state: testCase.result?.().state ?? 'unknown'
      })
    }
  }

  onTestRunEnd(_testModules, unhandledErrors, reason) {
    const report = {
      version: 1,
      reason,
      // Recorded so an empty list can be distinguished from "the reporter never saw a retry-enabled
      // run": the lane always passes --retry=1, so a report with retryBudget 0 is a misconfiguration.
      retryBudget: Number(process.env.VITEST_RETRY_BUDGET ?? 1),
      unhandledErrorCount: unhandledErrors.length,
      unstable: this.#unstable
    }

    writeFileSync(this.#path, `${JSON.stringify(report, null, 2)}\n`)
  }
}
