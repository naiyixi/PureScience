import { createHash } from 'node:crypto'

import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  SESSION_PACKAGE_ASSERTION,
  SESSION_PACKAGE_FORMAT_VERSION,
  SESSION_PACKAGE_MANIFEST_PATH,
  type SessionPackageManifest
} from '../../shared/session-package'
import { createSessionPackage, type SessionPackageInput } from './export'

const sha256 = (contents: Uint8Array): string => createHash('sha256').update(contents).digest('hex')

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

const input = (overrides: Partial<SessionPackageInput> = {}): SessionPackageInput => ({
  session: { id: 'session-1', title: 'Mpro 模拟', projectId: 'project-1', projectName: 'PRX' },
  appVersion: '1.59.0',
  exportedAt: '2026-09-15T00:00:00.000Z',
  conversation: {
    messages: [
      { role: 'user', text: '模拟一下分子对接' },
      { role: 'agent', text: '完成' }
    ]
  },
  citations: [{ id: 'cite-1', gbt: 'GB/T 7714 引用' }],
  reviewFindings: [{ id: 'finding-1', verdict: 'pass' }],
  verificationRecords: [{ id: 'verify-1', outcome: 'pass' }],
  files: [
    { path: 'files/figures/figA.png', contents: bytes('PNG-A') },
    { path: 'files/data/results.csv', contents: bytes('id,value\n1,2\n') }
  ],
  environment: { python: '3.11.15' },
  reproductionOutputs: [{ path: 'reproduction/figA.png', contents: bytes('REPRO-A') }],
  ...overrides
})

const unzip = (archive: Uint8Array): Record<string, Uint8Array> => unzipSync(archive)

describe('session package export', () => {
  it('carries every required evidence kind in essential mode too', () => {
    // The caller names how many files it left behind: an essential package never reads them, but a
    // reader must not conclude the session had none.
    const { archive, manifest } = createSessionPackage(input({ filesNotRequested: 2 }), 'essential')
    const entries = unzip(archive)

    for (const path of [
      'conversation.json',
      'evidence/citations.json',
      'evidence/review-findings.json',
      'evidence/verifications.json'
    ]) {
      expect(entries[path], path).toBeTruthy()
    }
    expect(manifest.mode).toBe('essential')
    expect(manifest.counts).toMatchObject({
      messages: 2,
      citations: 1,
      reviewFindings: 1,
      verificationRecords: 1
    })
    // Files are not requested in this mode, and the package says so by name instead of quietly
    // shipping a session that looks file-free.
    expect(manifest.notes).toContain('files-not-requested:2')
    expect(entries['files/figures/figA.png']).toBeUndefined()
  })

  it('pins the manifest to the source party so an import can never claim local verification', () => {
    const { archive, manifest } = createSessionPackage(input(), 'essential')
    const parsed = JSON.parse(
      strFromU8(unzip(archive)[SESSION_PACKAGE_MANIFEST_PATH])
    ) as SessionPackageManifest

    expect(manifest.assertion).toEqual(SESSION_PACKAGE_ASSERTION)
    expect(parsed.assertion).toEqual({ origin: 'source-party', locallyVerified: false })
    expect(manifest.formatVersion).toBe(SESSION_PACKAGE_FORMAT_VERSION)
    expect(parsed).toEqual(manifest)
  })

  it('adds the files, the environment lock and the reproduction outputs in full mode', () => {
    const { archive, manifest } = createSessionPackage(input(), 'full')
    const entries = unzip(archive)

    expect(strFromU8(entries['files/figures/figA.png'])).toBe('PNG-A')
    expect(strFromU8(entries['files/data/results.csv'])).toBe('id,value\n1,2\n')
    expect(strFromU8(entries['reproduction/figA.png'])).toBe('REPRO-A')
    expect(JSON.parse(strFromU8(entries['environment.json']))).toEqual({ python: '3.11.15' })
    expect(manifest.counts.files).toBe(2)
    expect(manifest.notes).not.toContain('files-not-requested:2')
  })

  it('names a file it refuses to carry instead of dropping or silently including it', () => {
    const { archive, manifest } = createSessionPackage(
      input({ maxFileBytes: 4, files: [{ path: 'files/big.bin', contents: bytes('12345') }] }),
      'full'
    )
    const entries = unzip(archive)

    expect(entries['files/big.bin']).toBeUndefined()
    const omitted = manifest.entries.find((entry) => entry.path === 'files/big.bin')
    expect(omitted?.omitted).toBe(true)
    expect(manifest.notes).toContain('file-omitted-too-large:files/big.bin')
    // The hash is still recorded, so a reader can recognise the file when it arrives another way.
    expect(omitted?.sha256).toBe(sha256(bytes('12345')))
  })

  it('records a hash and a byte count for every entry it writes', () => {
    const { archive, manifest } = createSessionPackage(input(), 'full')
    const entries = unzip(archive)

    for (const entry of manifest.entries) {
      expect(entries[entry.path], entry.path).toBeTruthy()
      expect(entry.bytes).toBe(entries[entry.path].byteLength)
      expect(entry.sha256).toBe(sha256(entries[entry.path]))
    }
    // The manifest describes every member of the archive except itself: a document cannot carry its
    // own hash truthfully, so readers verify the manifest by presence, not by a self-hash.
    expect(Object.keys(entries)).toContain(SESSION_PACKAGE_MANIFEST_PATH)
    expect(manifest.entries.map((entry) => entry.path)).not.toContain(SESSION_PACKAGE_MANIFEST_PATH)
    expect(Object.keys(entries).sort()).toEqual(
      [...manifest.entries.map((entry) => entry.path), SESSION_PACKAGE_MANIFEST_PATH].sort()
    )
  })

  it('names the environment and reproduction gaps it could not fill', () => {
    const { manifest } = createSessionPackage(
      input({ environment: undefined, reproductionOutputs: [] }),
      'full'
    )
    expect(manifest.notes).toContain('environment-lock-unavailable')
    expect(manifest.notes).toContain('reproduction-outputs-unavailable')
  })

  it('refuses an entry path that would escape the archive', () => {
    expect(() =>
      createSessionPackage(
        input({ files: [{ path: '../escape.txt', contents: bytes('x') }] }),
        'full'
      )
    ).toThrow(/escapes the archive root/)
  })
})
