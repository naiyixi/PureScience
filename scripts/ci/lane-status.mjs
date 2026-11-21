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
import { pathToFileURL } from 'node:url'

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

// Whether this file was invoked as a program: `import.meta.url` against the argv path, normalised through
// pathToFileURL. The obvious `` `file://${process.argv[1]}` `` comparison is false on Windows (argv comes
// back as D:\\a\\...\, the URL as file:///D:/a/.../), which made this script print nothing at all there —
// the Windows P0 record was then refused for an empty `--electron-p0` and the whole job went red on a
// correct lane reading.
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/

export const moduleUrlFor = (argv1) => {
  if (!argv1) return ''
  // pathToFileURL only understands Windows paths when it is *running* on Windows; a POSIX host treats
  // `D:\a\x` as a relative path and produces file:///<cwd>/D:%5Ca%5Cx. The drive-letter form is
  // normalised here so the comparison means the same thing on both hosts (and can be tested on either).
  if (WINDOWS_ABSOLUTE.test(argv1)) {
    const [drive, ...rest] = argv1.replace(/\\/g, '/').split('/')
    return `file:///${drive}/${rest.map((segment) => encodeURIComponent(segment)).join('/')}`
  }
  return pathToFileURL(argv1).href
}

if (moduleUrlFor(process.argv[1]) === import.meta.url) {
  process.stdout.write(`${laneStatus(process.argv[2])}\n`)
}
