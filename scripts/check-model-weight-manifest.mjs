#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Gate: the manifest that ships inside the app must be a manifest the *reader* accepts, and it must be
// the very file electron-builder copies into the package.
//
// Two refusals, both about the same failure: a manifest that reaches users cannot be fixed by a later
// commit, because the app reads it offline from the installed app. A malformed one turns the settings
// section into "invalid" on every machine that installed that build, and a manifest that no longer ships
// turns it into a silent "we never published one" — the reading that hides the packaging mistake.
//
// The shape rules are NOT re-implemented here: they are imported from
// src/main/engines/model-weight-manifest.ts, the same module the app validates the shipped file with, so
// the gate and the reader cannot drift into two opinions about what a valid manifest is.
//
//   node --no-warnings=MODULE_TYPELESS_PACKAGE_JSON scripts/check-model-weight-manifest.mjs [repoRoot]

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateModelWeightManifest } from '../src/main/engines/model-weight-manifest.ts'

/** Where the manifest lives in the repository — the source of the copy electron-builder ships. */
export const MANIFEST_REPO_PATH = 'resources/model-weights/manifest.json'
/** The extraResources mapping that puts it inside the package, as `Contents/Resources/model-weights`. */
export const SHIPPING_FROM = 'resources/model-weights'
export const SHIPPING_TO = 'model-weights'

const here = dirname(fileURLToPath(import.meta.url))

/** `from: resources/model-weights` immediately followed by its `to:` — read as the pair it is. */
const shippingMappingPattern = new RegExp(
  `-\\s*from:\\s*${SHIPPING_FROM.replace(/\//g, '\\/')}\\s*\\r?\\n\\s*to:\\s*${SHIPPING_TO}\\b`
)

/**
 * Checks a manifest against the reader's own shape rules and against the packaging declaration.
 *
 * Returns every problem rather than the first, each named: a gate that stops at one field is how a
 * half-checked manifest gets re-pushed three times.
 */
export const checkModelWeightManifest = ({ manifestText, manifestPresent, builderYml }) => {
  const problems = []

  if (!shippingMappingPattern.test(builderYml ?? '')) {
    problems.push({
      field: 'electron-builder.yml',
      message: `extraResources no longer maps ${SHIPPING_FROM} to ${SHIPPING_TO}: the manifest is not shipped any more`
    })
  }

  if (!manifestPresent) {
    problems.push({
      field: MANIFEST_REPO_PATH,
      message: `${MANIFEST_REPO_PATH} is missing while the build still ships that directory`
    })
    return problems
  }

  let parsed
  try {
    parsed = JSON.parse(manifestText)
  } catch (error) {
    problems.push({ field: MANIFEST_REPO_PATH, message: `not JSON: ${error.message}` })
    return problems
  }

  for (const problem of validateModelWeightManifest(parsed)) {
    problems.push({
      field: `entries[${problem.index}].${problem.field}`,
      message: problem.message
    })
  }

  return problems
}

/** Reads the two files the check is about. Absence is reported as absence, never as an empty manifest. */
export const readGateInputs = (repoRoot) => {
  const manifestPath = join(repoRoot, MANIFEST_REPO_PATH)
  const builderPath = join(repoRoot, 'electron-builder.yml')
  const manifestPresent = existsSync(manifestPath)
  return {
    manifestPresent,
    manifestText: manifestPresent ? readFileSync(manifestPath, 'utf8') : '',
    builderYml: existsSync(builderPath) ? readFileSync(builderPath, 'utf8') : ''
  }
}

export const main = (argv = process.argv.slice(2)) => {
  const repoRoot = resolve(argv[0] ?? join(here, '..'))
  const inputs = readGateInputs(repoRoot)
  const problems = checkModelWeightManifest(inputs)

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`[check-model-weight-manifest] ${problem.field}: ${problem.message}`)
    }
    console.error(
      `[check-model-weight-manifest] FAILED — ${problems.length} problem(s); the shipped manifest must be fixed before it reaches users`
    )
    return 1
  }

  const entries = JSON.parse(inputs.manifestText).entries.length
  console.log(
    `[check-model-weight-manifest] OK — ${MANIFEST_REPO_PATH} validates (${entries} entries) and still ships as ${SHIPPING_TO}/`
  )
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main())
}
