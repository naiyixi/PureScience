import { describe, expect, it } from 'vitest'

import {
  buildCaseBundle,
  caseBundleIsComplete,
  reconcileCaseBundle,
  validateCaseBundle,
  type CaseBundleManifest
} from './case-bundle'

const files = [
  { name: 'report.md', kind: 'md', sizeBytes: 1200, sha256: 'AB'.repeat(32) },
  { name: 'figure.png', kind: 'png', sizeBytes: 3400, sha256: 'cd'.repeat(32) }
]

const built = (): CaseBundleManifest => {
  const result = buildCaseBundle({ name: 'GPCR 激活途径', domain: 'structure', files })
  if (!result.ok) throw new Error(`expected a bundle, got ${result.problem}`)
  return result.manifest
}

describe('case bundle format', () => {
  it('sorts files by name and lowercases checksums, so two exports of one case diff cleanly', () => {
    const manifest = built()
    expect(manifest.format).toBe('purescience.case-bundle')
    expect(manifest.version).toBe(1)
    expect(manifest.files.map((file) => file.name)).toEqual(['figure.png', 'report.md'])
    expect(manifest.files.find((file) => file.name === 'report.md')?.sha256).toBe('ab'.repeat(32))
  })

  it('refuses a nameless case and an empty file list instead of writing an unusable bundle', () => {
    expect(buildCaseBundle({ name: '   ', domain: 'general', files })).toEqual({
      ok: false,
      problem: 'missing-name'
    })
    expect(buildCaseBundle({ name: 'x', domain: 'general', files: [] })).toEqual({
      ok: false,
      problem: 'no-files'
    })
  })

  it('refuses two files claiming one name, rather than picking one of them', () => {
    const result = buildCaseBundle({
      name: 'x',
      domain: 'general',
      files: [
        { name: 'a.csv', kind: 'csv', sizeBytes: 1 },
        { name: 'A.CSV', kind: 'csv', sizeBytes: 2 }
      ]
    })
    expect(result).toEqual({ ok: false, problem: 'duplicate-file-name' })
  })

  it('accepts its own output', () => {
    const manifest = built()
    const checked = validateCaseBundle(JSON.parse(JSON.stringify(manifest)))
    expect(checked.ok).toBe(true)
    if (checked.ok) expect(checked.manifest).toEqual(manifest)
  })

  it('names every rejection: a bundle from a future version, a foreign file, a broken entry', () => {
    const manifest = built()
    expect(validateCaseBundle(null)).toEqual({ ok: false, problem: 'not-an-object' })
    expect(validateCaseBundle({ ...manifest, format: 'other' })).toEqual({
      ok: false,
      problem: 'unknown-format'
    })
    expect(validateCaseBundle({ ...manifest, version: 2 })).toMatchObject({
      ok: false,
      problem: 'unsupported-version',
      detail: '2'
    })
    expect(validateCaseBundle({ ...manifest, name: '' })).toEqual({
      ok: false,
      problem: 'missing-name'
    })
    expect(validateCaseBundle({ ...manifest, files: [{ name: 'a', sizeBytes: -1 }] })).toEqual({
      ok: false,
      problem: 'bad-file-entry'
    })
    expect(
      validateCaseBundle({
        ...manifest,
        files: [
          { name: 'a.csv', sizeBytes: 1 },
          { name: 'a.csv', sizeBytes: 2 }
        ]
      })
    ).toMatchObject({ ok: false, problem: 'duplicate-file-name', detail: 'a.csv' })
  })

  it('defaults a missing domain and timestamp rather than refusing an otherwise valid bundle', () => {
    const manifest = built()
    const { domain: _domain, createdAt: _createdAt, ...rest } = manifest
    const checked = validateCaseBundle(rest)
    expect(checked.ok).toBe(true)
    if (checked.ok) {
      expect(checked.manifest.domain).toBe('general')
      expect(typeof checked.manifest.createdAt).toBe('number')
    }
  })
})

describe('case bundle reconciliation', () => {
  const manifest = built()

  it('calls a bundle complete only when every promised file arrived with the promised bytes', () => {
    const result = reconcileCaseBundle(manifest, [
      { name: 'report.md', sha256: 'ab'.repeat(32) },
      { name: 'figure.png', sha256: 'cd'.repeat(32) }
    ])
    expect(result).toEqual({
      matched: ['figure.png', 'report.md'],
      missing: [],
      checksumMismatch: [],
      unexpected: []
    })
    expect(caseBundleIsComplete(result)).toBe(true)
  })

  it('separates "arrived" from "arrived wrong", and reports files the manifest never described', () => {
    const result = reconcileCaseBundle(manifest, [
      { name: 'report.md', sha256: 'ff'.repeat(32) },
      { name: 'stowaway.exe', sha256: '00'.repeat(32) }
    ])
    expect(result.checksumMismatch).toEqual(['report.md'])
    expect(result.missing).toEqual(['figure.png'])
    expect(result.unexpected).toEqual(['stowaway.exe'])
    expect(caseBundleIsComplete(result)).toBe(false)
  })
})
