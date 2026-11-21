#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Reads a soft lane's exit code and says what the certification record may claim about it.
//
// Why a module and not three lines of shell: these lanes run with `continue-on-error`, which flattens
// `steps.<id>.outcome` to `success` — so the step's own reading cannot tell "ran and disagreed" from
// "passed", and `not-applicable` (never ran) becomes indistinguishable from a red. What survives is the
// exit code the step writes down. This mapping is used by both the visual lane and the Windows P0 lane,
// and it is tested (scripts/ci/lane-status.test.ts) instead of being re-derived in YAML.
//
// Three states, three meanings:
//   passed          — the lane ran and agreed
//   failed          — it ran and disagreed: the product moved, or the machine's environment differs
//   not-applicable  — it did not run at all (no packaged app, lane skipped for this platform)
import { readFileSync } from 'node:fs'

const MISSING = 'not-applicable'

/** @param {string | undefined} path */
export const laneStatus = (path) => {
  if (!path) return MISSING
  let raw
  try {
    raw = readFileSync(path, 'utf8').trim()
  } catch {
    // No file: the lane never ran. Not the same as "ran and disagreed".
    return MISSING
  }
  if (raw === '') return MISSING
  if (!/^-?\d+$/.test(raw)) {
    // A file that exists but says nothing readable is a broken writer, not a passing lane: fail closed.
    throw new Error(`Lane exit code is not a number: ${JSON.stringify(raw)}`)
  }
  return Number(raw) === 0 ? 'passed' : 'failed'
}

// The visual lane's original name, kept so its call sites (workflow, record writer, contract test) and the
// existing test file keep working unchanged.
export const visualRegressionStatus = laneStatus

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${laneStatus(process.argv[2])}\n`)
}
