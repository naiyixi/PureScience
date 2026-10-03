import { createHash } from 'node:crypto'

import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'

import { SESSION_PACKAGE_IMPORT_POSTURE } from '../../shared/session-package-import'
import type {
  SessionPackageEvidenceLanding,
  SessionPackageImportRecord
} from '../../shared/session-package-import'
import { createSessionPackage, type SessionPackageInput } from './export'
import { REQUIRED_PACKAGE_EVIDENCE } from './import'
import type { ImportedEvidenceInput } from './import-evidence'
import { importSessionPackage, type ImportedSessionDraft } from './import-session'

const source = (conversation?: Record<string, unknown>): SessionPackageInput => ({
  session: { id: 'source-session', title: 'Mpro 模拟', projectId: 'source-project' },
  appVersion: '1.59.0',
  exportedAt: '2026-09-15T00:00:00.000Z',
  conversation: conversation ?? {
    messages: [
      { id: 'm1', role: 'user', text: '模拟一下分子对接' },
      { id: 'm2', role: 'agent', text: '完成' }
    ]
  },
  citations: [{ id: 'cite-1' }],
  reviewFindings: [{ id: 'finding-1' }],
  verificationRecords: [{ id: 'verify-1' }]
})

const packageBytes = (conversation?: Record<string, unknown>): Uint8Array =>
  createSessionPackage(source(conversation), 'essential').archive

const NO_LANDING: SessionPackageEvidenceLanding = {
  citations: 0,
  reviews: 0,
  reviewFindings: 0,
  verificationRecords: 0,
  skipped: []
}

const deps = (
  bytes: Uint8Array,
  land: (input: ImportedEvidenceInput) => Promise<SessionPackageEvidenceLanding> = async () =>
    NO_LANDING
): {
  drafts: ImportedSessionDraft[]
  landed: ImportedEvidenceInput[]
  deps: Parameters<typeof importSessionPackage>[0]
} => {
  const drafts: ImportedSessionDraft[] = []
  const landed: ImportedEvidenceInput[] = []
  return {
    drafts,
    landed,
    deps: {
      readPackage: async (): Promise<Uint8Array> => bytes,
      saveImportedSession: async (draft: ImportedSessionDraft): Promise<void> => {
        drafts.push(draft)
      },
      landEvidence: async (
        input: ImportedEvidenceInput
      ): Promise<SessionPackageEvidenceLanding> => {
        landed.push(input)
        return land(input)
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
      notes: [],
      landed: NO_LANDING
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

  // The session document this draft becomes needs container timestamps: without them the app builds a
  // conversation graph whose frames carry none, drops them, and quarantines the imported session as
  // corrupt. A package exported by this build carries them; an older one is stamped at import time.
  it('carries the container timestamps the package brought', async () => {
    const harness = deps(
      packageBytes({
        messages: [{ id: 'm1', role: 'user', content: '模拟一下分子对接' }],
        createdAt: 1_789_000_000_000,
        updatedAt: 1_789_000_123_000
      })
    )

    await importSessionPackage(harness.deps, {
      packagePath: '/tmp/p.science',
      confirm: { targetProjectId: 'target-project' }
    })

    expect(harness.drafts[0].createdAt).toBe(1_789_000_000_000)
    expect(harness.drafts[0].updatedAt).toBe(1_789_000_123_000)
  })

  it('stamps an older package at import time instead of inventing a history', async () => {
    const harness = deps(packageBytes())

    await importSessionPackage(harness.deps, {
      packagePath: '/tmp/p.science',
      confirm: { targetProjectId: 'target-project' }
    })

    const importedAt = Date.parse('2026-09-16T09:00:00.000Z')
    expect(harness.drafts[0].createdAt).toBe(importedAt)
    expect(harness.drafts[0].updatedAt).toBe(importedAt)
  })

  // The evidence a package carries used to be read from the archive and thrown away: the receiver got
  // a transcript with no citations, no findings and no pins behind it. It now reaches the landing port
  // with the ids of the transcript THIS machine just wrote (a pin is re-derived against that session).
  it('hands the carried evidence to the landing port, against the imported transcript', async () => {
    const harness = deps(packageBytes())

    const result = await importSessionPackage(harness.deps, {
      packagePath: '/tmp/p.science',
      confirm: { targetProjectId: 'target-project' }
    })

    expect(result.ok).toBe(true)
    expect(harness.landed).toHaveLength(1)
    expect(harness.landed[0]).toEqual({
      targetProjectId: 'target-project',
      sessionId: 'imported-session-id',
      messageIds: ['m1', 'm2'],
      citations: [{ id: 'cite-1' }],
      reviewFindings: [{ id: 'finding-1' }],
      verificationRecords: [{ id: 'verify-1' }]
    })
  })

  it('reports what landed, and names what did not', async () => {
    const landing: SessionPackageEvidenceLanding = {
      citations: 1,
      reviews: 1,
      reviewFindings: 2,
      verificationRecords: 0,
      skipped: [{ kind: 'verifications', reason: 'message-not-found', id: 'review-1' }]
    }
    const harness = deps(packageBytes(), async () => landing)

    const result = await importSessionPackage(harness.deps, {
      packagePath: '/tmp/p.science',
      confirm: { targetProjectId: 'target-project' }
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.landed).toEqual(landing)
  })

  // A package that claims evidence it cannot produce as a list is refused: importing half of it would
  // hand the reader a session missing rows it was told it had.
  it('refuses a package whose evidence member is not a list', async () => {
    const entries = Object.entries(unzipSync(packageBytes()))
    const broken = zipSync({
      ...Object.fromEntries(entries.filter(([name]) => name !== 'evidence/citations.json')),
      'evidence/citations.json': strToU8('{"not":"a list"}')
    })
    const harness = deps(broken)

    await expect(
      importSessionPackage(harness.deps, {
        packagePath: '/tmp/p.science',
        confirm: { targetProjectId: 'target-project' }
      })
    ).resolves.toEqual({ ok: false, reason: 'evidence-unreadable' })
    expect(harness.drafts).toEqual([])
    expect(harness.landed).toEqual([])
  })

  // The landing module refuses per row, but a port that throws must not turn into "nothing to report":
  // every carried row is then named as not landed.
  it('names every carried row when the landing port itself throws', async () => {
    const harness = deps(packageBytes(), async () => {
      throw new Error('store offline')
    })

    const result = await importSessionPackage(harness.deps, {
      packagePath: '/tmp/p.science',
      confirm: { targetProjectId: 'target-project' }
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.landed).toEqual({
      citations: 0,
      reviews: 0,
      reviewFindings: 0,
      verificationRecords: 0,
      skipped: [
        { kind: 'citations', reason: 'landing-failed' },
        { kind: 'review-findings', reason: 'landing-failed', id: 'finding-1' },
        { kind: 'verifications', reason: 'landing-failed', id: 'verify-1' }
      ]
    })
  })
})
