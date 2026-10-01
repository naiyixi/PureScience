import { describe, expect, it } from 'vitest'

import {
  capturedFileEvidence,
  classifyReadFiles,
  sanitizeFileEvidence,
  uncapturedFileEvidence
} from './notebook'

describe('per-run file evidence', () => {
  const written = [
    { path: '/ws/data/plot.png', relativePath: 'data/plot.png' },
    { path: '/ws/data/clean.csv', relativePath: 'data/clean.csv' }
  ]

  it('separates a pre-existing input from a file this same run wrote first', () => {
    const read = classifyReadFiles(
      [
        { path: '/ws/data/raw.csv', relativePath: 'data/raw.csv', reads: 2 },
        { path: '/ws/data/clean.csv', relativePath: 'data/clean.csv' }
      ],
      written
    )

    expect(read).toEqual([
      { path: '/ws/data/raw.csv', relativePath: 'data/raw.csv', kind: 'input', reads: 2 },
      { path: '/ws/data/clean.csv', relativePath: 'data/clean.csv', kind: 'intermediate' }
    ])
  })

  it('matches the written set on the portable relative path, not the host path', () => {
    // The same file can be reached through a different absolute path (symlinked root, mounted data
    // dir). Classifying by host path would then call an intermediate step an input.
    const [file] = classifyReadFiles(
      [{ path: '/private/var/ws/data/clean.csv', relativePath: 'data/clean.csv' }],
      written
    )

    expect(file.kind).toBe('intermediate')
  })

  it('leaves reads absent when the driver did not report a count', () => {
    const [file] = classifyReadFiles([{ path: '/ws/a.csv', relativePath: 'a.csv' }], [])

    expect(file).not.toHaveProperty('reads')
  })

  it('cannot express an unexplained empty list: an uncaptured record always carries its reason', () => {
    const uncaptured = uncapturedFileEvidence('driver-without-read-capture')

    expect(uncaptured).toEqual({
      read: [],
      readStatus: 'unsupported',
      readReason: 'driver-without-read-capture'
    })
  })

  it('distinguishes "no reads" from "we could not look"', () => {
    const lookedAndFoundNothing = capturedFileEvidence([])
    const couldNotLook = uncapturedFileEvidence('capture-failed', 'unavailable')

    expect(lookedAndFoundNothing).not.toHaveProperty('readReason')
    expect(couldNotLook.readReason).toBe('capture-failed')
    expect(couldNotLook).not.toEqual(lookedAndFoundNothing)
  })

  it('carries the write-side observations with a captured list', () => {
    expect(
      capturedFileEvidence([], { writeTruncatedCount: 12, directoryConflict: 'shared-directory' })
    ).toEqual({
      read: [],
      readStatus: 'captured',
      writeTruncatedCount: 12,
      directoryConflict: 'shared-directory'
    })
  })

  describe('read-back sanitizing', () => {
    it('keeps a well-formed record', () => {
      const evidence = capturedFileEvidence(
        [{ path: '/ws/a.csv', relativePath: 'a.csv', kind: 'input', reads: 1 }],
        { writeTruncatedCount: 3 }
      )

      expect(sanitizeFileEvidence(evidence)).toEqual(evidence)
    })

    it('drops the whole record when the status contradicts its payload', () => {
      // 'truncated' without a count would read as a complete list that happens to be short.
      expect(sanitizeFileEvidence({ read: [], readStatus: 'truncated' })).toBeUndefined()
      // An unsupported capture with no reason is the silent-empty shape this type exists to prevent.
      expect(sanitizeFileEvidence({ read: [], readStatus: 'unsupported' })).toBeUndefined()
      expect(
        sanitizeFileEvidence({ read: [], readStatus: 'unsupported', readReason: 'made-up' })
      ).toBeUndefined()
    })

    it('drops the whole record when one read entry is malformed', () => {
      const good = { path: '/ws/a.csv', relativePath: 'a.csv', kind: 'input' } as const

      expect(
        sanitizeFileEvidence({
          read: [good, { path: '/ws/b.csv', relativePath: 'b.csv', kind: 'guess' }],
          readStatus: 'captured'
        })
      ).toBeUndefined()
      expect(
        sanitizeFileEvidence({
          read: [good, { path: '/ws/b.csv', kind: 'input' }],
          readStatus: 'captured'
        })
      ).toBeUndefined()
      expect(
        sanitizeFileEvidence({ read: [good], readStatus: 'captured', writeTruncatedCount: -1 })
      ).toBeUndefined()
      expect(
        sanitizeFileEvidence({ read: [good], readStatus: 'captured', directoryConflict: 'maybe' })
      ).toBeUndefined()
    })

    it('rejects anything that is not an evidence record at all', () => {
      expect(sanitizeFileEvidence(undefined)).toBeUndefined()
      expect(sanitizeFileEvidence(null)).toBeUndefined()
      expect(sanitizeFileEvidence('captured')).toBeUndefined()
      expect(sanitizeFileEvidence({ readStatus: 'captured' })).toBeUndefined()
    })
  })
})
