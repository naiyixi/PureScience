import { describe, expect, it } from 'vitest'

import {
  isUsableModelWeightManifest,
  validateModelWeightManifest,
  type ModelWeightManifest
} from './model-weight-manifest'

// A manifest is the publisher's own claim about bytes we redistribute. Each case below removes exactly
// one thing that claim depends on; the validator has to name the field rather than accept the manifest,
// because a half-checked manifest is how an unverified weight reaches a reader.
const valid = (): ModelWeightManifest => ({
  schema: 1,
  revision: '2026-10-16.1',
  entries: [
    {
      id: 'structure-recognition-primary',
      revision: 'abc123',
      publisher: 'PureScience',
      url: 'https://github.com/naiyixi/PureScience/releases/download/models-v1/abc123.bin',
      sha256: 'a'.repeat(64),
      bytes: 1234,
      license: 'MIT',
      kind: 'structure-recognition',
      publisherMd5: 'b'.repeat(32),
      note: 'pinned revision, digest computed by us over the file we host'
    }
  ]
})

describe('validateModelWeightManifest', () => {
  it('accepts a pinned, digested, licensed entry', () => {
    const manifest = valid()
    expect(validateModelWeightManifest(manifest)).toEqual([])
    expect(isUsableModelWeightManifest(manifest)).toBe(true)
  })

  it('rejects a digest that is not 64 lowercase hex characters', () => {
    const manifest = valid()
    manifest.entries[0].sha256 = 'NOT-A-DIGEST'
    expect(validateModelWeightManifest(manifest)).toEqual([
      { index: 0, field: 'sha256', message: 'sha256 must be 64 lowercase hex characters' }
    ])
    expect(isUsableModelWeightManifest(manifest)).toBe(false)
  })

  it('rejects an unpinned revision', () => {
    const manifest = valid()
    manifest.entries[0].revision = 'latest'
    const problems = validateModelWeightManifest(manifest)
    expect(problems.map((problem) => problem.field)).toContain('revision')
    expect(problems.some((problem) => /pinned, not "latest"/.test(problem.message))).toBe(true)
  })

  it('rejects a non-https url, a blank license, zero bytes and an unknown kind, naming each field', () => {
    const manifest = valid()
    manifest.entries[0].url = 'http://example.com/w.bin'
    manifest.entries[0].license = '   '
    manifest.entries[0].bytes = 0
    manifest.entries[0].kind = 'anything-goes' as never
    const fields = validateModelWeightManifest(manifest).map((problem) => problem.field)
    expect(fields).toEqual(expect.arrayContaining(['url', 'license', 'bytes', 'kind']))
    expect(fields).toHaveLength(4)
  })

  it('rejects two entries claiming the same id@revision', () => {
    const manifest = valid()
    manifest.entries.push({ ...manifest.entries[0] })
    const problems = validateModelWeightManifest(manifest)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ index: 1, field: 'id' })
    expect(problems[0].message).toContain('already used by entry 0')
  })

  it('rejects a malformed publisher md5 when one is given, and allows omitting it', () => {
    const manifest = valid()
    manifest.entries[0].publisherMd5 = 'tooshort'
    expect(validateModelWeightManifest(manifest)).toEqual([
      {
        index: 0,
        field: 'publisherMd5',
        message: 'publisherMd5, when present, must be 32 lowercase hex characters'
      }
    ])
    const withoutMd5 = valid()
    delete withoutMd5.entries[0].publisherMd5
    expect(validateModelWeightManifest(withoutMd5)).toEqual([])
  })

  it('rejects a manifest that is not an object, and one without an entries array', () => {
    expect(validateModelWeightManifest(null)).toEqual([
      { index: -1, field: 'manifest', message: 'manifest must be an object' }
    ])
    expect(validateModelWeightManifest([])).toEqual([
      { index: -1, field: 'manifest', message: 'manifest must be an object' }
    ])
    const noEntries = { schema: 1, revision: 'r' }
    const problems = validateModelWeightManifest(noEntries)
    expect(problems).toEqual([{ index: -1, field: 'entries', message: 'entries must be an array' }])
  })

  it('reports every problem in an entry rather than stopping at the first', () => {
    const manifest = valid()
    manifest.entries[0] = {
      id: '',
      revision: '',
      publisher: '',
      url: '',
      sha256: '',
      bytes: -1,
      license: '',
      kind: 'x' as never
    }
    const fields = validateModelWeightManifest(manifest).map((problem) => problem.field)
    expect(fields).toEqual(
      expect.arrayContaining([
        'id',
        'revision',
        'publisher',
        'url',
        'sha256',
        'bytes',
        'license',
        'kind'
      ])
    )
  })
})
