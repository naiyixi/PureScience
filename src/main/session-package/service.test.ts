import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { strFromU8, unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { SessionPackageManifest } from '../../shared/session-package'
import { exportSessionPackage, type SessionPackagePorts } from './service'

let work: string
let destination: string

const session = (): PersistedChatSession =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Mpro 模拟',
    cwd: '/tmp/work',
    status: 'idle',
    messages: [
      { id: 'm1', role: 'user', text: '模拟一下分子对接' },
      { id: 'm2', role: 'agent', text: '完成' }
    ],
    artifacts: [{ id: 'a1', name: 'figA.png' }]
  }) as unknown as PersistedChatSession

const ports = (overrides: Partial<SessionPackagePorts> = {}): SessionPackagePorts => ({
  loadSession: async () => ({ status: 'found', session: session() }),
  listReviews: async () => [{ id: 'review-1', outcome: 'pass', checks: [{ id: 'check-1' }] }],
  listEvidence: async () => [{ id: 'evidence-1', role: 'agent', fingerprint: 'sha256:abc' }],
  listCitations: async () => [{ id: 'cite-1', gbt: '张某. 文献题名[J]. 期刊, 2024.' }],
  listFiles: async () => ({
    files: [{ path: 'files/figures/figA.png', contents: new TextEncoder().encode('PNG-A') }],
    unreadable: []
  }),
  countFiles: async () => 1,
  readEnvironment: async () => ({ python: '3.11.15' }),
  readReproductionOutputs: async () => [
    { path: 'reproduction/figA.png', contents: new TextEncoder().encode('REPRO-A') }
  ],
  appVersion: '1.59.0',
  now: () => new Date('2026-09-15T12:00:00.000Z'),
  ...overrides
})

beforeEach(async () => {
  work = join(tmpdir(), `ps-package-svc-${process.pid}-${Date.now()}`)
  destination = join(work, 'session-1.science')
})

afterEach(async () => {
  await rm(work, { recursive: true, force: true })
})

describe('exportSessionPackage', () => {
  it('writes a package a reader can open, carrying the session and its evidence', async () => {
    const result = await exportSessionPackage(ports(), {
      projectId: 'project-1',
      sessionId: 'session-1',
      mode: 'essential',
      destinationPath: destination
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path).toBe(destination)
    expect(result.bytes).toBe((await stat(destination)).size)

    const entries = unzipSync(new Uint8Array(await readFile(destination)))
    const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as SessionPackageManifest
    expect(manifest.session).toEqual({
      id: 'session-1',
      title: 'Mpro 模拟',
      projectId: 'project-1'
    })
    expect(manifest.mode).toBe('essential')
    expect(manifest.exportedAt).toBe('2026-09-15T12:00:00.000Z')
    expect(manifest.assertion).toEqual({ origin: 'source-party', locallyVerified: false })
    expect(manifest.counts).toMatchObject({
      messages: 2,
      citations: 1,
      reviewFindings: 1,
      verificationRecords: 1
    })

    const conversation = JSON.parse(strFromU8(entries['conversation.json'])) as {
      messages: { id: string }[]
      artifacts: { id: string }[]
    }
    expect(conversation.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(conversation.artifacts.map((artifact) => artifact.id)).toEqual(['a1'])
    expect(JSON.parse(strFromU8(entries['evidence/citations.json']))).toEqual([
      { id: 'cite-1', gbt: '张某. 文献题名[J]. 期刊, 2024.' }
    ])
    expect(JSON.parse(strFromU8(entries['evidence/verifications.json']))).toEqual([
      { id: 'evidence-1', role: 'agent', fingerprint: 'sha256:abc' }
    ])
    // Essential mode says by name that the files stayed behind.
    expect(manifest.notes).toContain('files-not-requested:1')
    expect(entries['files/figures/figA.png']).toBeUndefined()
  })

  it('carries the session files, the environment and the reproduction outputs in full mode', async () => {
    const result = await exportSessionPackage(ports(), {
      projectId: 'project-1',
      sessionId: 'session-1',
      mode: 'full',
      destinationPath: destination
    })

    expect(result.ok).toBe(true)
    const entries = unzipSync(new Uint8Array(await readFile(destination)))
    expect(strFromU8(entries['files/figures/figA.png'])).toBe('PNG-A')
    expect(strFromU8(entries['reproduction/figA.png'])).toBe('REPRO-A')
    expect(JSON.parse(strFromU8(entries['environment.json']))).toEqual({ python: '3.11.15' })
  })

  it('refuses a session it cannot read, and leaves no package behind', async () => {
    const missing = await exportSessionPackage(
      ports({ loadSession: async () => ({ status: 'missing' }) }),
      {
        projectId: 'project-1',
        sessionId: 'session-1',
        mode: 'essential',
        destinationPath: destination
      }
    )
    expect(missing).toEqual({ ok: false, error: 'session-not-found' })

    const unreadable = await exportSessionPackage(
      ports({ loadSession: async () => ({ status: 'unreadable' }) }),
      {
        projectId: 'project-1',
        sessionId: 'session-1',
        mode: 'essential',
        destinationPath: destination
      }
    )
    expect(unreadable).toEqual({ ok: false, error: 'session-unreadable' })

    // Neither refusal may leave a file that looks like a finished package.
    await expect(stat(destination)).rejects.toThrow()
  })

  it('reports a write failure by name and cleans up its partial file', async () => {
    // A file where the destination's folder must be makes mkdir fail with ENOTDIR, the way a full disk
    // or a revoked permission would stop the write.
    const blocker = join(work, 'blocker')
    await mkdir(work, { recursive: true })
    await writeFile(blocker, 'not a directory')
    const result = await exportSessionPackage(ports(), {
      projectId: 'project-1',
      sessionId: 'session-1',
      mode: 'essential',
      destinationPath: join(blocker, 'session-1.science')
    })

    expect(result).toEqual({ ok: false, error: 'write-failed' })
    await expect(stat(join(blocker, 'session-1.science.partial'))).rejects.toThrow()
  })

  it('asks the stores once per export and never for a mode that does not need them', async () => {
    const listFiles = vi.fn(async () => ({ files: [], unreadable: [] }))
    await exportSessionPackage(ports({ listFiles }), {
      projectId: 'project-1',
      sessionId: 'session-1',
      mode: 'essential',
      destinationPath: destination
    })
    expect(listFiles).not.toHaveBeenCalled()
  })
})
