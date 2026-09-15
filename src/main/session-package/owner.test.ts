import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import { createSessionPackageOwner, type SessionPackageOwnerDeps } from './owner'

let work: string

const session = (artifacts: { id: string; path: string; name?: string }[]): PersistedChatSession =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    title: '黑色星期五 —— 当 III 期临床失败',
    cwd: '/tmp/work',
    status: 'idle',
    messages: [{ id: 'm1', role: 'user', text: '清点证据' }],
    artifacts
  }) as unknown as PersistedChatSession

const deps = (overrides: Partial<SessionPackageOwnerDeps> = {}): SessionPackageOwnerDeps => ({
  loadSession: async () => ({
    status: 'found',
    session: session([{ id: 'a1', path: 'figures/figA.png', name: 'figA.png' }])
  }),
  listReviews: async () => [{ id: 'review-1' }],
  listEvidence: async () => [{ id: 'evidence-1', fingerprint: 'sha256:abc' }],
  listReferences: async () => [{ id: 'ref-1', gbt: '张某. 文献题名[J]. 期刊, 2024.' }],
  files: {
    countFiles: async () => 1,
    listFiles: async () => ({
      files: [{ path: 'files/figA.png', contents: new TextEncoder().encode('PNG-A') }],
      unreadable: []
    })
  },
  appVersion: '1.59.0',
  now: () => new Date('2026-09-15T12:00:00.000Z'),
  ...overrides
})

beforeEach(async () => {
  work = join(tmpdir(), `ps-package-owner-${process.pid}-${Date.now()}`)
  await mkdir(work, { recursive: true })
})

afterEach(async () => {
  await rm(work, { recursive: true, force: true })
})

describe('session package owner', () => {
  it('asks the app for a destination and names a cancelled dialog', async () => {
    const showSaveDialog = vi.fn(async (_suggested: string) => null)
    const owner = createSessionPackageOwner(deps({ showSaveDialog }))

    const cancelled = await owner.exportPackage({
      projectId: 'project-1',
      sessionId: 'session-1',
      mode: 'essential'
    })
    expect(cancelled).toEqual({ ok: false, error: 'cancelled' })
    expect(showSaveDialog).toHaveBeenCalledTimes(1)
    // The suggested name must be safe to write even when the title is not.
    expect(showSaveDialog.mock.calls[0][0]).toMatch(/\.science$/)
    expect(showSaveDialog.mock.calls[0][0]).not.toMatch(/[\n\\/:*?"<>|]/)
  })

  it('refuses without a dialog when no destination was given', async () => {
    const owner = createSessionPackageOwner(deps())
    expect(
      await owner.exportPackage({
        projectId: 'project-1',
        sessionId: 'session-1',
        mode: 'essential'
      })
    ).toEqual({
      ok: false,
      error: 'no-destination'
    })
  })

  it('refuses a session it cannot read before asking for a destination', async () => {
    const showSaveDialog = vi.fn(async () => join(work, 'never.science'))
    const owner = createSessionPackageOwner(
      deps({ loadSession: async () => ({ status: 'missing' }), showSaveDialog })
    )

    expect(
      await owner.exportPackage({
        projectId: 'project-1',
        sessionId: 'session-1',
        mode: 'essential'
      })
    ).toEqual({ ok: false, error: 'session-not-found' })
    expect(showSaveDialog).not.toHaveBeenCalled()
  })
})
