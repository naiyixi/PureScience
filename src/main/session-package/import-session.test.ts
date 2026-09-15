import { createHash } from 'node:crypto'

import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'

import { SESSION_PACKAGE_IMPORT_POSTURE } from '../../shared/session-package-import'
import type { SessionPackageImportRecord } from '../../shared/session-package-import'
import { createSessionPackage, type SessionPackageInput } from './export'
import { REQUIRED_PACKAGE_EVIDENCE } from './import'
import { importSessionPackage, type ImportedSessionDraft } from './import-session'

const source = (): SessionPackageInput => ({
  session: { id: 'source-session', title: 'Mpro 模拟', projectId: 'source-project' },
  appVersion: '1.59.0',
  exportedAt: '2026-09-15T00:00:00.000Z',
  conversation: {
    messages: [
      { role: 'user', text: '模拟一下分子对接' },
      { role: 'agent', text: '完成' }
    ]
  },
  citations: [{ id: 'cite-1' }],
  reviewFindings: [{ id: 'finding-1' }],
  verificationRecords: [{ id: 'verify-1' }]
})

const packageBytes = (): Uint8Array => createSessionPackage(source(), 'essential').archive

const deps = (
  bytes: Uint8Array
): { drafts: ImportedSessionDraft[]; deps: Parameters<typeof importSessionPackage>[0] } => {
  const drafts: ImportedSessionDraft[] = []
  return {
    drafts,
    deps: {
      readPackage: async (): Promise<Uint8Array> => bytes,
      saveImportedSession: async (draft: ImportedSessionDraft): Promise<void> => {
        drafts.push(draft)
      },
      now: (): Date => new Date('2026-09-16T09:00:00.000Z'),
      newId: (): string => 'imported-session-id'
    }
  }
}

describe('session package import', () => {
  it('lands the package as a new read-only session and keeps where it came from', async () => {
    const harness = deps(packageBytes())
    const result = await importSessionPackage(harness.deps, {
      packagePath: '/tmp/p.science',
      confirm: { targetProjectId: 'target-project' }
    })

    expect(result).toEqual({
      ok: true,
      sessionId: 'imported-session-id',
      posture: SESSION_PACKAGE_IMPORT_POSTURE,
      notes: []
    })
    expect(harness.drafts).toHaveLength(1)
    const draft = harness.drafts[0]
    // A fresh identity, and the source identity kept only as provenance.
    expect(draft.sessionId).toBe('imported-session-id')
    expect(draft.projectId).toBe('target-project')
    expect(draft.title).toBe('Mpro 模拟')
    expect((draft.conversation as { messages: unknown[] }).messages).toHaveLength(2)

    const record: SessionPackageImportRecord = draft.record
    expect(record.importedFrom).toEqual({
      sessionId: 'source-session',
      projectId: 'source-project',
      appVersion: '1.59.0',
      exportedAt: '2026-09-15T00:00:00.000Z'
    })
    expect(record.importedAt).toBe('2026-09-16T09:00:00.000Z')
    // The posture is pinned by the type AND carried on the record.
    expect(record.posture).toEqual({
      readOnly: true,
      executeAllowed: false,
      continueAllowed: false,
      verificationLabel: 'source-party'
    })
    expect(record.assertion).toEqual({ origin: 'source-party', locallyVerified: false })
  })

  it('writes nothing at all until the caller confirms', async () => {
    const harness = deps(packageBytes())
    await expect(
      importSessionPackage(harness.deps, { packagePath: '/tmp/p.science' })
    ).resolves.toEqual({
      ok: false,
      reason: 'not-confirmed'
    })
    expect(harness.drafts).toEqual([])
  })

  it('refuses without a target project instead of guessing one', async () => {
    const harness = deps(packageBytes())
    await expect(
      importSessionPackage(harness.deps, { packagePath: '/tmp/p.science', confirm: {} })
    ).resolves.toEqual({ ok: false, reason: 'no-target-project' })
    expect(harness.drafts).toEqual([])
  })

  it('refuses a tampered package and leaves the disk alone', async () => {
    const entries = Object.entries(unzipSync(packageBytes())).filter(
      ([name]) => name !== 'conversation.json'
    )
    const hostile = zipSync({ ...Object.fromEntries(entries), '../escape.json': strToU8('{}') })
    const harness = deps(hostile)

    await expect(
      importSessionPackage(harness.deps, {
        packagePath: '/tmp/p.science',
        confirm: { targetProjectId: 'target-project' }
      })
    ).resolves.toEqual({ ok: false, reason: 'entry-path-unsafe' })
    expect(harness.drafts).toEqual([])
  })

  it('refuses a package that lost its evidence', async () => {
    const entries = Object.entries(unzipSync(packageBytes())).filter(
      ([name]) => name !== 'evidence/verifications.json'
    )
    const harness = deps(zipSync(Object.fromEntries(entries)))
    await expect(
      importSessionPackage(harness.deps, {
        packagePath: '/tmp/p.science',
        confirm: { targetProjectId: 'target-project' }
      })
    ).resolves.toEqual({ ok: false, reason: 'required-evidence-missing' })
    expect(REQUIRED_PACKAGE_EVIDENCE).toContain('evidence/verifications.json')
    expect(harness.drafts).toEqual([])
  })

  it('reports a failed write by name', async () => {
    const harness = deps(packageBytes())
    const failing = {
      ...harness.deps,
      saveImportedSession: vi.fn(async (): Promise<void> => {
        throw new Error('disk full')
      })
    }
    await expect(
      importSessionPackage(failing, {
        packagePath: '/tmp/p.science',
        confirm: { targetProjectId: 'target-project' }
      })
    ).resolves.toEqual({ ok: false, reason: 'write-failed' })
  })

  it('does not let the package choose its own new identity', async () => {
    const harness = deps(packageBytes())
    await importSessionPackage(harness.deps, {
      packagePath: '/tmp/p.science',
      confirm: { targetProjectId: 'target-project' }
    })
    // The imported id is the one this machine generated, never the one the sender wrote.
    expect(harness.drafts[0].sessionId).not.toBe('source-session')
    expect(createHash('sha256').update('source-session').digest('hex')).not.toBe(
      harness.drafts[0].sessionId
    )
  })
})
