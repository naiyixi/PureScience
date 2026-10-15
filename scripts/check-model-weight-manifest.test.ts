import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  MANIFEST_REPO_PATH,
  SHIPPING_FROM,
  SHIPPING_TO,
  checkModelWeightManifest,
  readGateInputs
} from './check-model-weight-manifest.mjs'

// The gate reads two things: the manifest that ships and the declaration that ships it. Both are read off
// the real repository in the first case, so "the gate passes today" is a statement about the files in the
// tree rather than about a fixture that could agree with a broken gate.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const validManifest = JSON.stringify({
  schema: 1,
  revision: '2026-10-16.1',
  entries: [
    {
      id: 'structure-recognition-primary',
      revision: 'zenodo-10.5281/zenodo.8300489',
      publisher: 'example publisher',
      url: 'https://example.invalid/models.zip',
      sha256: 'a'.repeat(64),
      bytes: 298662033,
      license: 'CC-BY-4.0',
      kind: 'structure-recognition'
    }
  ]
})

const shippingDeclaration = `extraResources:
  - from: node_modules/.prisma
    to: node_modules/.prisma
  - from: ${SHIPPING_FROM}
    to: ${SHIPPING_TO}
`

describe('check-model-weight-manifest', () => {
  it('passes on the manifest in this tree, and would notice if it stopped being shipped', () => {
    const inputs = readGateInputs(repoRoot)
    // Guard against a vacuous pass: "no problems" from a missing file is the failure mode this gate exists
    // for, so the file has to be there for the green to mean anything.
    expect(inputs.manifestPresent).toBe(true)
    expect(inputs.builderYml).toContain(SHIPPING_FROM)
    expect(checkModelWeightManifest(inputs)).toEqual([])
  })

  it('fails by field when a digest is not a digest, before that manifest reaches users', () => {
    const broken = JSON.parse(validManifest) as { entries: { sha256: string }[] }
    broken.entries[0].sha256 = 'nope'
    const problems = checkModelWeightManifest({
      manifestText: JSON.stringify(broken),
      manifestPresent: true,
      builderYml: shippingDeclaration
    })
    expect(problems.map((problem) => problem.field)).toEqual(['entries[0].sha256'])
    expect(problems[0].message).toContain('64 lowercase hex')
  })

  it('fails when the manifest is gone while the build still ships that directory', () => {
    const problems = checkModelWeightManifest({
      manifestText: '',
      manifestPresent: false,
      builderYml: shippingDeclaration
    })
    expect(problems).toEqual([
      { field: MANIFEST_REPO_PATH, message: expect.stringContaining('is missing') }
    ])
  })

  it('fails when extraResources stops mapping the directory — a valid file that no longer ships is not shipped', () => {
    const problems = checkModelWeightManifest({
      manifestText: validManifest,
      manifestPresent: true,
      // The mapping dropped, everything else intact: exactly the edit that would otherwise read as a pass.
      builderYml: shippingDeclaration.replace(
        `  - from: ${SHIPPING_FROM}\n    to: ${SHIPPING_TO}\n`,
        ''
      )
    })
    expect(problems.map((problem) => problem.field)).toContain('electron-builder.yml')
  })

  it('names unparseable text instead of reporting it as an empty manifest', () => {
    const problems = checkModelWeightManifest({
      manifestText: '{ not json',
      manifestPresent: true,
      builderYml: shippingDeclaration
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ field: MANIFEST_REPO_PATH })
    expect(problems[0].message).toContain('not JSON')
  })

  it('reads exactly the file the build ships: its path follows from the shipping declaration', () => {
    // If the mapping moved, the gate would keep validating a file nobody installs — so the two constants are
    // tied together here rather than in prose.
    expect(MANIFEST_REPO_PATH).toBe(`${SHIPPING_FROM}/manifest.json`)
  })
})
