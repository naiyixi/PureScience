import { describe, expect, it } from 'vitest'

import {
  parseModelWeightManifestText,
  readModelWeightManifestFile
} from './model-weight-manifest-file'

const usableText = JSON.stringify({
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
      kind: 'structure-recognition'
    }
  ]
})

describe('parseModelWeightManifestText', () => {
  it('returns usable for a manifest that validates, carrying the parsed manifest through', () => {
    const state = parseModelWeightManifestText(usableText, '/x/manifest.json')
    expect(state.state).toBe('usable')
    if (state.state !== 'usable') throw new Error('unreachable')
    expect(state.manifest.entries).toHaveLength(1)
    expect(state.manifest.entries[0].id).toBe('structure-recognition-primary')
  })

  it('separates "not JSON" from "failed validation" — both are publisher errors, never an empty list', () => {
    const notJson = parseModelWeightManifestText('{ not json', '/x/manifest.json')
    expect(notJson).toMatchObject({ state: 'invalid', reason: 'not-json', problems: [] })

    const badDigest = JSON.parse(usableText) as { entries: { sha256: string }[] }
    badDigest.entries[0].sha256 = 'nope'
    const failed = parseModelWeightManifestText(JSON.stringify(badDigest), '/x/manifest.json')
    expect(failed.state).toBe('invalid')
    if (failed.state !== 'invalid') throw new Error('unreachable')
    expect(failed.reason).toBe('failed-validation')
    expect(failed.problems.map((problem) => problem.field)).toEqual(['sha256'])
  })

  it('never reports a state other than the three named ones', () => {
    const states = [usableText, '{ not json', JSON.stringify({ schema: 2 })].map(
      (text) => parseModelWeightManifestText(text).state
    )
    expect(states).toEqual(['usable', 'invalid', 'invalid'])
  })
})

describe('readModelWeightManifestFile', () => {
  it('reports a missing file as absent — we have not published weights yet, which is about us', () => {
    const state = readModelWeightManifestFile('/definitely/not/here/manifest.json')
    expect(state).toMatchObject({ state: 'absent' })
  })

  it('reports a path we cannot read as unreadable rather than downgrading it to absent', () => {
    // A directory is readable-but-not-a-file: EISDIR, not ENOENT, so it must not read as "nothing shipped".
    const state = readModelWeightManifestFile('/Users')
    expect(state).toMatchObject({ state: 'invalid', reason: 'unreadable' })
  })
})
