import { describe, expect, it } from 'vitest'

import {
  buildFileEvidence,
  capturedReadEvidence,
  capturedWriteEvidence,
  classifyReadFiles,
  sanitizeFileEvidence,
  truncatedReadEvidence,
  truncatedWriteEvidence,
  unattributedWriteEvidence,
  uncapturedReadEvidence,
  unavailableWriteEvidence,
  unsupportedWriteEvidence
} from './notebook'

describe('per-run file evidence', () => {
  const written = [
    { path: '/ws/data/plot.png', relativePath: 'data/plot.png' },
    { path: '/ws/data/clean.csv', relativePath: 'data/clean.csv' }
  ]

  describe('read axis', () => {
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
      expect(uncapturedReadEvidence('driver-without-read-capture')).toEqual({
        read: [],
        readStatus: 'unsupported',
        readReason: 'driver-without-read-capture'
      })
    })

    it('distinguishes "no reads" from "we could not look"', () => {
      const lookedAndFoundNothing = capturedReadEvidence([])
      const couldNotLook = uncapturedReadEvidence('capture-failed', 'unavailable')

      expect(lookedAndFoundNothing).not.toHaveProperty('readReason')
      expect(couldNotLook.readReason).toBe('capture-failed')
      expect(couldNotLook).not.toEqual(lookedAndFoundNothing)
    })

    it('keeps the collected list and states the shortfall when it stopped at the limit', () => {
      expect(
        truncatedReadEvidence([{ path: '/ws/a.csv', relativePath: 'a.csv', kind: 'input' }], 42)
      ).toEqual({
        read: [{ path: '/ws/a.csv', relativePath: 'a.csv', kind: 'input' }],
        readStatus: 'truncated',
        readTruncatedCount: 42
      })
    })
  })

  describe('write axis', () => {
    it('says how short the write list is instead of dropping it', () => {
      expect(truncatedWriteEvidence(7)).toEqual({ status: 'truncated', droppedCount: 7 })
    })

    it('keeps an unattributable list, labelled with the shared directory', () => {
      expect(unattributedWriteEvidence('attribution-conflict')).toEqual({
        status: 'unattributed',
        reason: 'attribution-conflict',
        directoryConflict: 'shared-directory'
      })
      // An over-limit run can also be an unattributable one: both facts travel.
      expect(unattributedWriteEvidence('attribution-conflict', { droppedCount: 3 })).toEqual({
        status: 'unattributed',
        reason: 'attribution-conflict',
        directoryConflict: 'shared-directory',
        droppedCount: 3
      })
    })

    it("keeps what was seen in a shared directory under a label, not as this run's list", () => {
      expect(
        unattributedWriteEvidence('attribution-conflict', {
          observedPaths: ['data/shared.csv', 'data/other.csv']
        })
      ).toEqual({
        status: 'unattributed',
        reason: 'attribution-conflict',
        directoryConflict: 'shared-directory',
        observedPaths: ['data/shared.csv', 'data/other.csv']
      })
      // The paths are validated on read-back: a non-string or empty entry makes the whole record
      // untrustworthy rather than half-readable.
      expect(
        sanitizeFileEvidence({
          read: capturedReadEvidence([]),
          write: {
            status: 'unattributed',
            reason: 'attribution-conflict',
            directoryConflict: 'shared-directory',
            observedPaths: ['data/a.csv', 7]
          }
        })
      ).toBeUndefined()
    })

    it('names why a write capture did not happen', () => {
      expect(unavailableWriteEvidence('observation-unavailable')).toEqual({
        status: 'unavailable',
        reason: 'observation-unavailable'
      })
      expect(unsupportedWriteEvidence('limit-exceeded')).toEqual({
        status: 'unsupported',
        reason: 'limit-exceeded'
      })
    })
  })

  describe('read-back sanitizing', () => {
    it('keeps a well-formed two-axis record', () => {
      const evidence = buildFileEvidence(
        capturedReadEvidence([
          { path: '/ws/a.csv', relativePath: 'a.csv', kind: 'input', reads: 1 }
        ]),
        truncatedWriteEvidence(3)
      )

      expect(sanitizeFileEvidence(evidence)).toEqual(evidence)
    })

    it('drops the whole record when an axis contradicts its payload', () => {
      // 'truncated' without a count would read as a complete list that happens to be short.
      expect(
        sanitizeFileEvidence({
          read: { read: [], readStatus: 'truncated' },
          write: capturedWriteEvidence()
        })
      ).toBeUndefined()
      // An unsupported capture with no reason is the silent-empty shape this type exists to prevent.
      expect(
        sanitizeFileEvidence({
          read: { read: [], readStatus: 'unsupported' },
          write: capturedWriteEvidence()
        })
      ).toBeUndefined()
      expect(
        sanitizeFileEvidence({
          read: { read: [], readStatus: 'unsupported', readReason: 'made-up' },
          write: capturedWriteEvidence()
        })
      ).toBeUndefined()
      expect(
        sanitizeFileEvidence({
          read: capturedReadEvidence([]),
          write: { status: 'unattributed', reason: 'attribution-conflict' }
        })
      ).toBeUndefined()
      expect(
        sanitizeFileEvidence({ read: capturedReadEvidence([]), write: { status: 'truncated' } })
      ).toBeUndefined()
    })

    it('drops the whole record when one read entry is malformed', () => {
      const good = { path: '/ws/a.csv', relativePath: 'a.csv', kind: 'input' } as const

      expect(
        sanitizeFileEvidence({
          read: {
            read: [good, { path: '/ws/b.csv', relativePath: 'b.csv', kind: 'guess' }],
            readStatus: 'captured'
          },
          write: capturedWriteEvidence()
        })
      ).toBeUndefined()
      expect(
        sanitizeFileEvidence({
          read: { read: [good, { path: '/ws/b.csv', kind: 'input' }], readStatus: 'captured' },
          write: capturedWriteEvidence()
        })
      ).toBeUndefined()
    })

    it('rejects anything that is not an evidence record at all', () => {
      expect(sanitizeFileEvidence(undefined)).toBeUndefined()
      expect(sanitizeFileEvidence(null)).toBeUndefined()
      expect(sanitizeFileEvidence('captured')).toBeUndefined()
      // Both axes are required: a record with only the read side cannot say how complete the write
      // list is, and the reader would have to assume it is whole.
      expect(sanitizeFileEvidence({ read: capturedReadEvidence([]) })).toBeUndefined()
      expect(sanitizeFileEvidence({ write: capturedWriteEvidence() })).toBeUndefined()
    })
  })
})
