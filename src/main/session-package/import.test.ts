import { createHash } from 'node:crypto'

import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { createSessionPackage, type SessionPackageInput } from './export'
import { inspectSessionPackage, REQUIRED_PACKAGE_EVIDENCE } from './import'

const input = (): SessionPackageInput => ({
  session: { id: 'session-1', title: 'Mpro 模拟', projectId: 'project-1' },
  appVersion: '1.59.0',
  exportedAt: '2026-09-15T00:00:00.000Z',
  conversation: { messages: [{ role: 'user', text: '模拟一下分子对接' }] },
  citations: [{ id: 'cite-1' }],
  reviewFindings: [{ id: 'finding-1' }],
  verificationRecords: [{ id: 'verify-1' }]
})

const packageBytes = (
  overrides: Partial<SessionPackageInput> = {},
  mode: 'essential' | 'full' = 'essential'
): Uint8Array => createSessionPackage({ ...input(), ...overrides }, mode).archive

describe('session package inspection', () => {
  it('accepts a package the exporter wrote, and describes it without claiming its verification', () => {
    const preview = inspectSessionPackage(packageBytes())

    expect(preview.accepted).toBe(true)
    expect(preview.described?.session).toEqual({
      id: 'session-1',
      title: 'Mpro 模拟',
      projectId: 'project-1'
    })
    expect(preview.described?.counts.messages).toBe(1)
    // The sender's own words about provenance travel unchanged into the preview.
    expect(preview.described?.assertion).toEqual({ origin: 'source-party', locallyVerified: false })
  })

  it('refuses bytes that are not an archive at all', () => {
    expect(inspectSessionPackage(strToU8('this is not a zip'))).toEqual({
      accepted: false,
      reason: 'not-a-package'
    })
  })

  it('refuses an archive with no manifest', () => {
    const archive = zipSync({ 'notes.txt': strToU8('hello') })
    expect(inspectSessionPackage(archive)).toEqual({ accepted: false, reason: 'not-a-package' })
  })

  it('refuses a manifest it cannot parse', () => {
    const archive = zipSync({
      'manifest.json': strToU8('{not json'),
      ...Object.fromEntries(REQUIRED_PACKAGE_EVIDENCE.map((path) => [path, strToU8('{}')]))
    })
    expect(inspectSessionPackage(archive)).toEqual({ accepted: false, reason: 'manifest-invalid' })
  })

  it('refuses a format version this build does not know', () => {
    const { archive } = createSessionPackage(input(), 'essential')
    // Rewrite the version the way a newer build would have written it.
    const entries = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({
          formatVersion: 99,
          mode: 'essential',
          exportedAt: '2026-09-15T00:00:00.000Z',
          app: { version: '9.9.9' },
          session: { id: 's', title: 't', projectId: 'p' },
          counts: {
            messages: 0,
            citations: 0,
            reviewFindings: 0,
            verificationRecords: 0,
            files: 0
          },
          entries: [],
          assertion: { origin: 'source-party', locallyVerified: false },
          notes: []
        })
      ),
      ...Object.fromEntries(REQUIRED_PACKAGE_EVIDENCE.map((path) => [path, strToU8('{}')]))
    })
    expect(archive.byteLength).toBeGreaterThan(0)
    expect(inspectSessionPackage(entries)).toEqual({
      accepted: false,
      reason: 'unsupported-format-version'
    })
  })

  it('refuses a package that dropped a piece of required evidence', () => {
    const { archive } = createSessionPackage(input(), 'essential')
    const entries = new Map(Object.entries(unzipSync(archive)))
    // Rebuild the archive without one evidence file.
    const rebuilt = zipSync(
      Object.fromEntries([...entries].filter(([name]) => name !== 'evidence/verifications.json'))
    )
    console.log('DROPPED_EVIDENCE_REASON', inspectSessionPackage(rebuilt).reason)
    expect(inspectSessionPackage(rebuilt)).toEqual({
      accepted: false,
      reason: 'required-evidence-missing'
    })
  })

  it('refuses an entry path that would escape the extraction directory', () => {
    const { archive } = createSessionPackage(input(), 'essential')
    const entries = Object.entries(unzipSync(archive)).filter(
      ([name]) => name !== 'conversation.json'
    )
    const hostile = zipSync({
      ...Object.fromEntries(entries),
      '../escape.json': strToU8('{}')
    })
    expect(inspectSessionPackage(hostile)).toEqual({ accepted: false, reason: 'entry-path-unsafe' })
  })

  it('refuses a package that exceeds the entry-count ceiling', () => {
    const many: Record<string, Uint8Array> = {}
    for (let index = 0; index < 5_001; index += 1) many[`filler/${index}.json`] = strToU8('{}')
    expect(inspectSessionPackage(zipSync(many))).toEqual({
      accepted: false,
      reason: 'entry-count-exceeded'
    })
  })

  it('hashes nothing on trust: the described package still carries the sender’s hashes', () => {
    const { archive, manifest } = createSessionPackage(input(), 'full')
    const preview = inspectSessionPackage(archive)
    const conversationEntry = manifest.entries.find((entry) => entry.path === 'conversation.json')
    const bytes = unzipSync(archive)['conversation.json']

    expect(preview.accepted).toBe(true)
    expect(conversationEntry?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  })
})
