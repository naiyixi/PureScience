#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Gate: every Node launcher in this repository must be parseable by the Node that will run it.
//
// Why it exists (2026-10-16). The launcher directories — `scripts/`, `scripts/ci/`, `cli/`,
// `packages/purescience/` and `build/` — sit OUTSIDE both tsconfig projects (`tsconfig.node.json`,
// `tsconfig.web.json`), and their `.mjs`/`.cjs` files are not parsed by `tsc` either: `allowJs` is off
// in both, and turning it on was measured at 65 pre-existing errors (almost all vitest-mock variance)
// so it is a separate decision, not a free win. That left a hole wide enough to ship through: a
// duplicate export in `scripts/publish-model-weights.mjs` made the documented
// `npm run publish:model-weights` entry die with `SyntaxError: Duplicate export of 'prepareUpload'`
// while every existing gate stayed green — `vitest` still links such a module, `eslint` never links
// one, and `tsc` never saw the file at all.
//
// So this gate asks NODE, with Node's own parser, whether the file is a module Node can link. No second
// opinion about "valid JavaScript" is invented here; `--check` is the very parse that fails on the
// duplicate export above (`Duplicate export of '<name>'`).
//
//   node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON scripts/check-script-entrypoints.mjs [treeRoot]

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directories whose contents Node is asked to run directly. Order is stable so output is diffable. */
export const LAUNCHER_ROOTS = ['scripts', 'cli', 'packages/purescience', 'build']

/** Only these carry the "run me" meaning here; `.ts` under `scripts/` is covered by `tsc` instead. */
const LAUNCHER_SUFFIXES = ['.mjs', '.cjs']

/**
 * Floor on the number of launchers found. Measured on 2026-10-16: 52 files (28 + 14 + 3 + 6 + 1).
 * It is deliberately below that count — it is not a pin, it only makes a walk that found nothing
 * (or found one directory) fail instead of reporting "0 problems", which is what a clean tree reports.
 */
export const MIN_LAUNCHERS = 40

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Every launcher under the declared roots. A root that does not exist is returned in `missingRoots`
 * rather than skipped: silently looking in one place fewer is indistinguishable from a clean tree.
 */
export const collectLaunchers = (root) => {
  const missingRoots = LAUNCHER_ROOTS.filter((candidate) => !existsSync(join(root, candidate)))
  const files = []

  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (LAUNCHER_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) files.push(full)
    }
  }

  for (const candidate of LAUNCHER_ROOTS) {
    const dir = join(root, candidate)
    if (existsSync(dir)) walk(dir)
  }

  return { files, missingRoots }
}

/** The one line worth printing out of a `node --check` failure: Node's own `SyntaxError: …`. */
const failureReason = (stderr) => {
  const line = String(stderr)
    .split('\n')
    .map((text) => text.trim())
    .find((text) => /Error:/.test(text))
  return line ?? String(stderr).trim().split('\n').slice(-1)[0] ?? 'could not be parsed'
}

/** Runs Node's own parser over every launcher. Returns findings; never throws on a bad file. */
export const checkScriptEntrypoints = (root) => {
  const { files, missingRoots } = collectLaunchers(root)
  const failures = []

  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    } catch (error) {
      failures.push({
        // Printed with forward slashes on every platform: the line is read by humans and compared in CI
        // logs, and a Windows-flavoured separator there is a difference nobody is asking about.
        file: relative(root, file).split(sep).join('/'),
        reason: failureReason(error.stderr ?? error.message)
      })
    }
  }

  return { scanned: files.length, missingRoots, failures }
}

const main = () => {
  const root = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '..')
  const { scanned, missingRoots, failures } = checkScriptEntrypoints(root)

  let bad = false

  if (missingRoots.length > 0) {
    bad = true
    for (const candidate of missingRoots) {
      console.error(`✗ launcher directory ${candidate}/ does not exist under ${root}`)
    }
  }

  if (scanned < MIN_LAUNCHERS) {
    bad = true
    console.error(
      `✗ found only ${scanned} launcher(s) under ${root} (floor ${MIN_LAUNCHERS}) — the walk looked in the wrong place, so nothing below may be read as a pass`
    )
  }

  for (const failure of failures) {
    bad = true
    console.error(`✗ ${failure.file}: ${failure.reason}`)
  }

  if (bad) {
    console.error(`✗ script entrypoints: ${failures.length} of ${scanned} launcher(s) do not parse`)
    process.exit(1)
  }

  console.log(
    `✓ script entrypoints: ${scanned} launcher(s) under ${LAUNCHER_ROOTS.join(', ')} parse under Node`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
