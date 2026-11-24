#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Pre-fetches the curated runtime pack into the machine cache the runtime client reads, so a lane that
// starts many apps (the packaged P0 suite starts one per spec) pays for the ~100 MB transfer once.
//
// The app still fetches the manifest over the network on each provisioning attempt and still decides on
// that manifest's digest; this step only removes the repeated transfer. See
// docs/evidence/2026-11-24-windows-gate-second-reading-and-the-transfer-that-cost-it.md for the reading
// that motivated it (a 565 s `artifacts:replay-version` handler whose budget went to the transfer).
//
// Usage:
//   PURESCIENCE_RUNTIME_PACK_CACHE=<dir> node scripts/ci/prewarm-runtime-pack.mjs <subdir> [--languages python,r]
//
// `subdir` is the conda platform segment the app resolves: win-64 / osx-arm64 / osx-64 / linux-64.

import { readDefaultEnvVersion } from '../stage-default-envs.mjs'
import { DEFAULT_CDN_BASE, prewarmRuntimePack } from '../verify-runtime-bundle.mjs'

const main = async () => {
  const subdir = process.argv[2]
  if (!subdir || subdir.startsWith('-')) {
    throw new Error(
      'usage: PURESCIENCE_RUNTIME_PACK_CACHE=<dir> node scripts/ci/prewarm-runtime-pack.mjs <subdir> [--languages python,r]'
    )
  }
  const cacheDir = process.env.PURESCIENCE_RUNTIME_PACK_CACHE?.trim()
  if (!cacheDir) {
    throw new Error(
      'PURESCIENCE_RUNTIME_PACK_CACHE must name the cache root the runtime client reads; without it the app would transfer the pack per spec again'
    )
  }
  const flag = process.argv.indexOf('--languages')
  const languages =
    flag === -1
      ? ['python']
      : String(process.argv[flag + 1] ?? '')
          .split(',')
          .map((language) => language.trim())
          .filter(Boolean)
  const results = await prewarmRuntimePack({
    cacheDir,
    cdnBase: process.env.PURESCIENCE_ENV_CDN_BASE || DEFAULT_CDN_BASE,
    envVersion: readDefaultEnvVersion(),
    subdir,
    languages
  })
  console.log(
    `prewarm: ${results.length} archive(s) ready in ${cacheDir} (${results
      .map(({ file, action }) => `${file}=${action}`)
      .join(' ')})`
  )
}

main().catch((error) => {
  console.log(`prewarm: FAILED ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
