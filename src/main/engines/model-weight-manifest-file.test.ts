import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  parseModelWeightManifestText,
  readModelWeightManifestFile,
  readShippedModelWeightManifest,
  resolveModelWeightManifestLocation
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
    // A directory that demonstrably exists, so "absent" can only be about the file we asked for.
    const state = readModelWeightManifestFile(
      join(mkdtempSync(join(tmpdir(), 'ps-manifest-')), 'manifest.json')
    )
    expect(state).toMatchObject({ state: 'absent' })
  })

  it('reports a path we cannot read as unreadable rather than downgrading it to absent', () => {
    // A directory is readable-but-not-a-file: EISDIR, not ENOENT, so it must not read as "nothing shipped".
    // It is created here instead of borrowed from the machine, because the failure has to be the same one on
    // every runner — a literal like /Users exists on macOS and not on Windows, which turns this assertion into
    // a statement about the host rather than about the code.
    const directory = mkdtempSync(join(tmpdir(), 'ps-manifest-dir-'))
    try {
      const state = readModelWeightManifestFile(directory)
      expect(state).toMatchObject({ state: 'invalid', reason: 'unreadable' })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

// The shipped-manifest path: a real tree on a real filesystem, laid out the way electron-builder ships it
// (packaged) and the way a dev build keeps it (under `resources/`). The temp root is removed afterwards, so
// the "nothing found" case cannot accidentally be satisfied by a leftover from an earlier case.
const withTree = <T>(run: (root: string) => T): T => {
  const root = mkdtempSync(join(tmpdir(), 'ps-manifest-tree-'))
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const writeManifestAt = (root: string, relative: string, text = usableText): string => {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

describe('resolveModelWeightManifestLocation', () => {
  it('prefers the packaged copy, and reports which copy answered', () => {
    withTree((root) => {
      // Packaged layout: `resources/model-weights` is mapped to `model-weights` beside app.asar, so the
      // file sits directly under `process.resourcesPath` — not under a second `resources/` directory.
      const packaged = writeManifestAt(root, 'model-weights/manifest.json')
      const location = resolveModelWeightManifestLocation({
        resourcesPath: root,
        fromDir: join(root, 'out', 'main')
      })
      expect(location).toMatchObject({ found: true, source: 'packaged', path: packaged })
    })
  })

  it('finds the dev copy by walking up from the asking module', () => {
    withTree((root) => {
      const dev = writeManifestAt(root, 'resources/model-weights/manifest.json')
      const location = resolveModelWeightManifestLocation({
        fromDir: join(root, 'out', 'main')
      })
      expect(location).toMatchObject({ found: true, source: 'dev', path: dev })
    })
  })

  it('treats an explicit override as the only candidate — no silent fallback to a shipped copy', () => {
    withTree((root) => {
      writeManifestAt(root, 'resources/model-weights/manifest.json')
      const taken = resolveModelWeightManifestLocation({
        override: join(root, 'candidate', 'manifest.json'),
        resourcesPath: join(root, 'resources'),
        fromDir: join(root, 'out', 'main')
      })
      // An override names the one file that counts. Quietly falling back to another copy would let a run
      // that meant to test an unpublished manifest validate the shipped one instead.
      expect(taken).toMatchObject({ found: false, source: 'none' })
    })
  })

  it('names a miss as a miss instead of reporting a path nothing was read from', () => {
    withTree((root) => {
      const location = resolveModelWeightManifestLocation({
        fromDir: join(root, 'nowhere', 'deep')
      })
      expect(location).toMatchObject({ found: false, source: 'none' })
      expect(Object.keys(location)).not.toContain('path')
      // The candidates it looked at ride along: a resolution miss has to be debuggable from its own reading.
      expect(location.candidates.length).toBeGreaterThan(0)
    })
  })
})

describe('readShippedModelWeightManifest', () => {
  it('reads the manifest a production caller would, and carries the parsed entries', () => {
    withTree((root) => {
      const path = writeManifestAt(root, 'resources/model-weights/manifest.json')
      const reading = readShippedModelWeightManifest({ override: path, fromDir: root })
      expect(reading.location).toMatchObject({ found: true, source: 'override' })
      expect(reading.state?.state).toBe('usable')
      expect(reading.report).toMatchObject({ source: 'override', present: true, state: 'usable' })
      expect(reading.report.entryCount).toBe(1)
      expect(reading.report.problems).toEqual([])
    })
  })

  it('keeps "nothing shipped" apart from "shipped but unreadable"', () => {
    withTree((root) => {
      const missing = readShippedModelWeightManifest({
        override: join(root, 'absent', 'manifest.json'),
        fromDir: root
      })
      // The override names a file that is not there: the answer is "no manifest", and there is no path in it
      // because nothing was read.
      expect(missing.report).toEqual({
        source: 'none',
        present: false,
        state: 'absent',
        problems: []
      })

      const unreadable = readShippedModelWeightManifest({ override: root, fromDir: root })
      expect(unreadable.report).toMatchObject({
        source: 'override',
        present: true,
        state: 'invalid',
        reason: 'unreadable'
      })
      expect(unreadable.report.entryCount).toBeUndefined()
    })
  })

  it('reports a failed validation by field and never invents an entry count', () => {
    withTree((root) => {
      const broken = JSON.parse(usableText) as { entries: { sha256: string }[] }
      broken.entries[0].sha256 = 'not-a-digest'
      const path = writeManifestAt(
        root,
        'resources/model-weights/manifest.json',
        JSON.stringify(broken)
      )
      const reading = readShippedModelWeightManifest({ override: path, fromDir: root })
      expect(reading.report).toMatchObject({ state: 'invalid', reason: 'failed-validation' })
      expect(reading.report.problems.map((problem) => problem.field)).toEqual(['sha256'])
      // Zero here would be a number nobody measured; absent is the honest reading.
      expect(reading.report.entryCount).toBeUndefined()
    })
  })

  it('is pathless: the reading that leaves the machine carries no path, while the location still does', () => {
    withTree((root) => {
      const path = writeManifestAt(root, 'resources/model-weights/manifest.json')
      const reading = readShippedModelWeightManifest({
        override: path,
        resourcesPath: root,
        fromDir: join(root, 'out', 'main')
      })

      // Exact shape on purpose: this object is copied into a bundle that leaves the device, so a new field
      // is a decision, not an accident.
      expect(JSON.parse(JSON.stringify(reading.report))).toEqual({
        source: 'override',
        present: true,
        state: 'usable',
        entryCount: 1,
        problems: []
      })
      expect(Object.keys(reading.report)).not.toContain('path')

      // Read back through the serialized form, the way a consumer sees it: comparing escaped JSON on the
      // host's own separators is how a Windows runner ends up disagreeing with macOS about a path.
      const location = JSON.parse(JSON.stringify(reading.location)) as { path?: string }
      expect(location.path).toBe(path)
    })
  })
})
