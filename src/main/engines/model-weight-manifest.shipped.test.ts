import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { readModelWeightManifestFile } from './model-weight-manifest-file'

// The gate on the SHIPPED manifest.
//
// This does not re-implement any rule: it reads the file the app actually ships and puts it through the
// same reader and validator the app itself uses, so a manifest that would confuse the app fails here
// first. Two failures it exists to catch, both of which have happened to projects in this shape: a
// manifest edited into something invalid (a digest that is not a digest, a duplicate id@revision), and a
// manifest that never makes it into the package at all because nobody wired it into the build.
const repoRoot = process.cwd()
const manifestPath = join(repoRoot, 'resources', 'model-weights', 'manifest.json')

describe('shipped model-weight manifest', () => {
  it('is present and usable by the app’s own reader', () => {
    const state = readModelWeightManifestFile(manifestPath)
    // Spell out which of the three states we got: "invalid" and "absent" mean very different things to
    // whoever reads the failure, and the message should say which one happened.
    if (state.state !== 'usable') {
      throw new Error(
        state.state === 'absent'
          ? `the manifest is not shipped at ${manifestPath}`
          : `the manifest at ${manifestPath} is invalid (${state.reason}): ${JSON.stringify(state.problems)}`
      )
    }
    expect(state.manifest.entries.length).toBeGreaterThan(0)
  })

  it('names a license and a pinning revision for every entry — no entry may be unpinned or unlicensed', () => {
    const state = readModelWeightManifestFile(manifestPath)
    if (state.state !== 'usable') throw new Error(`manifest not usable (${state.state})`)
    for (const entry of state.manifest.entries) {
      expect(entry.revision.trim().length).toBeGreaterThan(0)
      expect(entry.revision.toLowerCase()).not.toBe('latest')
      expect(entry.license.trim().length).toBeGreaterThan(0)
      expect(entry.bytes).toBeGreaterThan(0)
    }
  })

  it('stays declared in the packager config, so shipped data actually ships', () => {
    // The manifest is data, so nothing else would notice it silently dropping out of the package.
    const builderConfig = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
    expect(builderConfig).toContain('resources/model-weights')
    expect(builderConfig).toContain('to: model-weights')
  })
})
