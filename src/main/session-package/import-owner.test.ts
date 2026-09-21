import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import { createSessionFile, normalizeSessionFile } from '../../shared/session-persistence'
import { SESSION_PACKAGE_IMPORT_POSTURE } from '../../shared/session-package-import'
import { createSessionPackage } from './export'
import { importSessionPackage, type ImportedSessionDraft } from './import-session'
import {
  createSessionPackageImportOwner,
  importRecordPath,
  readSessionPackageImportRecord
} from './import-owner'

let root: string

const record = {
  importedAt: '2026-09-16T09:00:00.000Z',
  importedFrom: {
    sessionId: 'source-session',
    projectId: 'source-project',
    appVersion: '1.59.0',
    exportedAt: '2026-09-15T00:00:00.000Z'
  },
  posture: SESSION_PACKAGE_IMPORT_POSTURE,
  assertion: { origin: 'source-party' as const, locallyVerified: false as const },
  notes: []
}

const draft: ImportedSessionDraft = {
  sessionId: 'imported-session',
  projectId: 'target-project',
  title: 'Mpro 模拟（导入）',
  conversation: { messages: [{ id: 'm1', role: 'user', text: '来自他机' }] },
  createdAt: 1_790_000_000_000,
  updatedAt: 1_790_000_000_500,
  record
}

beforeEach(async () => {
  root = join(tmpdir(), `ps-import-owner-${process.pid}-${Date.now()}`)
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('session package import owner', () => {
  // The app's own message shape (a package carries these verbatim), not a hand-made `{ id, text }`.
  const appMessage = {
    id: 'm1',
    role: 'user' as const,
    content: '来自他机',
    status: 'complete' as const,
    createdAt: 1_789_999_999_000,
    updatedAt: 1_789_999_999_000
  }
  const realisticDraft: ImportedSessionDraft = {
    ...draft,
    conversation: { messages: [appMessage] }
  }

  it('writes a document the app can read back: it survives its own session-file validation', async () => {
    // The defect this pins: the importer wrote a session with no container timestamps, the app
    // materialized a conversation graph whose frames carried none, and the next read quarantined the
    // whole session as corrupt (a `.invalid-<ts>` file beside the record) — so an import "succeeded"
    // into a session nobody could open.
    const saved: PersistedChatSession[] = []
    const owner = createSessionPackageImportOwner({
      configRoot: root,
      saveSession: async (session: PersistedChatSession): Promise<void> => {
        saved.push(session)
      },
      workspaceFor: (sessionId: string): string => `/data/workspaces/${sessionId}`
    })

    await owner.saveImportedSession(realisticDraft)

    const written = saved[0]
    expect(written).toBeDefined()
    // Exactly what the repository does on the way to disk, then what every read does on the way back.
    const onDisk = createSessionFile(written)
    const restored = normalizeSessionFile(onDisk)
    expect(restored).toBeDefined()
    expect(restored?.id).toBe('imported-session')
    expect(restored?.messages.map((message) => message.id)).toEqual(['m1'])
    // The graph the app builds from it keeps its frame and branch, which is what the validator drops.
    expect(restored?.conversationGraph?.frames).toHaveLength(1)
    expect(restored?.conversationGraph?.branches).toHaveLength(1)
    expect(restored?.createdAt).toBe(realisticDraft.createdAt)
  })

  it('shows the timestamps are load-bearing: without them the same document is refused', async () => {
    const saved: PersistedChatSession[] = []
    const owner = createSessionPackageImportOwner({
      configRoot: root,
      saveSession: async (session: PersistedChatSession): Promise<void> => {
        saved.push(session)
      },
      workspaceFor: (sessionId: string): string => `/data/workspaces/${sessionId}`
    })

    // A caller that drops the container timestamps reproduces the quarantine the guard above prevents.
    await owner.saveImportedSession({
      ...realisticDraft,
      createdAt: undefined as unknown as number,
      updatedAt: undefined as unknown as number
    })

    expect(normalizeSessionFile(createSessionFile(saved[0]))).toBeUndefined()
  })

  it('writes the session, then the record that keeps it read-only', async () => {
    const saved: PersistedChatSession[] = []
    const owner = createSessionPackageImportOwner({
      configRoot: root,
      saveSession: async (session: PersistedChatSession): Promise<void> => {
        saved.push(session)
      },
      workspaceFor: (sessionId: string): string => `/data/workspaces/${sessionId}`
    })

    await owner.saveImportedSession(draft)

    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      id: 'imported-session',
      projectId: 'target-project',
      title: 'Mpro 模拟（导入）',
      cwd: '/data/workspaces/imported-session',
      status: 'idle'
    })
    expect(saved[0].messages).toHaveLength(1)

    const written = await readSessionPackageImportRecord(root, 'target-project', 'imported-session')
    expect(written).toEqual(record)
    // The record on disk carries the posture and the sender's claim, not just the ids.
    expect(written?.posture.readOnly).toBe(true)
    expect(written?.assertion).toEqual({ origin: 'source-party', locallyVerified: false })
  })

  it('treats a session with no record as an ordinary session, not an imported one', async () => {
    const owner = createSessionPackageImportOwner({
      configRoot: root,
      saveSession: async (): Promise<void> => {},
      workspaceFor: (): string => '/data/ws'
    })
    await owner.saveImportedSession(draft)

    await expect(
      readSessionPackageImportRecord(root, 'target-project', 'never-imported')
    ).resolves.toBeUndefined()
    // A corrupt record is also "no record": it must not be read as a posture.
    await writeFile(
      importRecordPath(root, 'target-project', 'imported-session'),
      '{not json',
      'utf8'
    )
    await expect(
      readSessionPackageImportRecord(root, 'target-project', 'imported-session')
    ).resolves.toBeUndefined()
  })

  it('leaves no record behind when the session write fails', async () => {
    const owner = createSessionPackageImportOwner({
      configRoot: root,
      saveSession: async (): Promise<void> => {
        throw new Error('disk full')
      },
      workspaceFor: (): string => '/data/ws'
    })

    await expect(owner.saveImportedSession(draft)).rejects.toThrow('disk full')
    await expect(
      readSessionPackageImportRecord(root, 'target-project', 'imported-session')
    ).resolves.toBeUndefined()
  })

  it('binds the ports the importer needs, so a real import lands both files', async () => {
    const saved: PersistedChatSession[] = []
    const owner = createSessionPackageImportOwner({
      configRoot: root,
      saveSession: async (session: PersistedChatSession): Promise<void> => {
        saved.push(session)
      },
      workspaceFor: (sessionId: string): string => `/data/workspaces/${sessionId}`
    })

    const result = await importSessionPackage(
      owner.ports(async () => packageBytes),
      {
        packagePath: '/tmp/p.science',
        confirm: { targetProjectId: 'target-project' }
      }
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(saved).toHaveLength(1)
    const written = await readSessionPackageImportRecord(root, 'target-project', result.sessionId)
    expect(written?.posture.executeAllowed).toBe(false)
    expect(written?.importedFrom.projectId).toBe('source-project')
  })
})

// A real package, produced by the exporter this build ships.
const packageBytes: Uint8Array = createSessionPackage(
  {
    session: { id: 'source-session', title: 'Mpro 模拟（导入）', projectId: 'source-project' },
    appVersion: '1.59.0',
    exportedAt: '2026-09-15T00:00:00.000Z',
    conversation: { messages: [{ id: 'm1', role: 'user', text: '来自他机' }] },
    citations: [],
    reviewFindings: [],
    verificationRecords: []
  },
  'essential'
).archive
