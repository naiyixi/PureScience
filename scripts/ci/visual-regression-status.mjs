#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Reads the visual regression lane's exit code and says what the certification record may claim.
//
// The workflow keeps the visual step soft (`continue-on-error`) so a rendering-variance red does not sink an
// otherwise good build — but that makes `steps.visual.outcome` useless as evidence: it is `failure`, while the
// step's conclusion is `success`. What survives is the exit code the step wrote down. This mapping used to be
// three lines of shell inside the workflow, where nothing could test it; a red measured on run 44730436800 was
// recorded as `not-applicable`, i.e. indistinguishable from "never ran".
//
// Three states, and they mean three different things:
//   passed          — the comparison ran and agreed with this machine's baseline
//   failed          — it ran and disagreed: the product moved, or the baseline is stale for this machine
//   not-applicable  — it did not run at all (no packaged app, skipped lane)
import { readFileSync } from 'node:fs'

const MISSING = 'not-applicable'

/** @param {string | undefined} path */
export const visualRegressionStatus = (path) => {
  if (!path) return MISSING
  let raw
  try {
    raw = readFileSync(path, 'utf8').trim()
  } catch {
    // No file: the step never ran. Not the same as "ran and disagreed".
    return MISSING
  }
  if (raw === '') return MISSING
  if (!/^-?\d+$/.test(raw)) {
    // A file that exists but says nothing readable is a broken writer, not a passing comparison: fail closed.
    throw new Error(`Visual regression exit code is not a number: ${JSON.stringify(raw)}`)
  }
  return Number(raw) === 0 ? 'passed' : 'failed'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${visualRegressionStatus(process.argv[2])}\n`)
}
