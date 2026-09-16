import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { SESSION_PACKAGE_MANIFEST_PATH } from '../../shared/session-package'

import { verifySessionPackageIntegrity } from './integrity'

const sha256 = (value: string): string =>
  createHash('sha256').update(Buffer.from(value)).digest('hex')

const entry = (path: string, contents: string, overrides: Record<string, unknown> = {}) => ({
  path,
  bytes: Buffer.byteLength(contents),
  sha256: sha256(contents),
  ...overrides
})

const manifest = (entries: ReturnType<typeof entry>[]) => ({ app: { version: '1.61.0' }, entries })

const bytes = (values: Record<string, string>): Map<string, Uint8Array> =>
  new Map(Object.entries(values).map(([path, value]) => [path, Buffer.from(value)]))

describe('session package integrity', () => {
  it('finds a package intact when every member still hashes to its recorded digest', () => {
    const report = verifySessionPackageIntegrity(
      manifest([entry('transcript.json', '{"a":1}'), entry('files/data.csv', 'x,y\n1,2\n')]),
      bytes({ 'transcript.json': '{"a":1}', 'files/data.csv': 'x,y\n1,2\n' })
    )

    expect(report.verdict).toBe('intact')
    expect(report.mode).toBe('record-integrity')
    expect(report.files.every((file) => file.status === 'match')).toBe(true)
  })

  // The whole point: a member edited after export must be caught, and the reader told where it changed.
  it('catches a member that was altered after export and says where it diverges', () => {
    const report = verifySessionPackageIntegrity(
      manifest([entry('files/data.csv', 'x,y\n1,2\n')]),
      bytes({ 'files/data.csv': 'x,y\n1,9\n' })
    )

    expect(report.verdict).toBe('changed')
    // The manifest records digests, never the bytes, so the difference is locatable only by digest —
    // that is the provenance this check can honestly give, and it says so.
    expect(report.files[0]).toMatchObject({ status: 'differs', firstDifferingByte: -1 })
    expect(report.reasons[0]).toContain('the byte offset was not captured')
    expect(report.reasons[0]).toContain('recorded ')
  })

  it('reports a declared member the package does not contain', () => {
    const report = verifySessionPackageIntegrity(
      manifest([entry('transcript.json', '{"a":1}'), entry('files/gone.csv', 'x')]),
      bytes({ 'transcript.json': '{"a":1}' })
    )

    expect(report.verdict).toBe('changed')
    expect(report.files).toContainEqual({ path: 'files/gone.csv', status: 'missing' })
  })

  // The manifest is the record, not a member of it: treating it as undeclared would make every package
  // with a manifest fail — which is every package. Caught by running the check against a real export.
  it('does not count the manifest itself as an undeclared member', () => {
    const packaged = bytes({ 'transcript.json': '{"a":1}' })
    packaged.set(SESSION_PACKAGE_MANIFEST_PATH, Buffer.from('{"formatVersion":1}'))

    const report = verifySessionPackageIntegrity(
      manifest([entry('transcript.json', '{"a":1}')]),
      packaged
    )

    expect(report.verdict).toBe('intact')
  })

  it('reports a packed member the manifest never declared', () => {
    const report = verifySessionPackageIntegrity(
      manifest([entry('transcript.json', '{"a":1}')]),
      bytes({ 'transcript.json': '{"a":1}', 'files/smuggled.csv': 'x' })
    )

    expect(report.verdict).toBe('changed')
    expect(report.files).toContainEqual({ path: 'files/smuggled.csv', status: 'extra' })
    expect(report.reasons.at(-1)).toContain('packed without being declared')
  })

  // An omitted member was never packed, so it cannot be vouched for — and that must not read as a pass.
  it('reports an omitted member as something it could not check', () => {
    const report = verifySessionPackageIntegrity(
      manifest([
        entry('transcript.json', '{"a":1}'),
        entry('files/big.bin', '', { bytes: 0, sha256: '', omitted: true })
      ]),
      bytes({ 'transcript.json': '{"a":1}' })
    )

    expect(report.verdict).toBe('unverifiable')
    expect(report.files).toContainEqual({
      path: 'files/big.bin',
      status: 'not-comparable',
      reason: 'no-digest-recorded'
    })
  })

  it('keeps the exporter’s own version as information rather than comparing against it', () => {
    const report = verifySessionPackageIntegrity(manifest([entry('a', 'a')]), bytes({ a: 'a' }))

    // A record compared with itself has no second environment to differ from, so nothing is withheld.
    expect(report.verdict).toBe('intact')
    expect(report.reasons).toEqual([])
  })
})
