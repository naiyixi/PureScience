import { readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { strFromU8, unzipSync } from 'fflate'
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
  readArtifact: async () => ({ content: 'PNG-A', encoding: 'utf8', size: 5, truncated: false }),
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
  it('never lets a truncated preview pass as the whole file', async () => {
    const destination = join(work, 'out.science')
    const owner = createSessionPackageOwner(
      deps({
        loadSession: async () => ({
          status: 'found',
          session: session([
            { id: 'a1', path: 'figures/figA.png', name: 'figA.png' },
            { id: 'a2', path: 'figures/figB.png', name: 'figB.png' }
          ])
        }),
        // A bounded preview: the bytes stop early, so they must not be shipped as the artifact.
        readArtifact: async ({ path }) =>
          path.includes('figA')
            ? { content: 'PNG-A', encoding: 'utf8', size: 5, truncated: false }
            : { content: 'PN', encoding: 'utf8', size: 900, truncated: true }
      })
    )

    const result = await owner.exportPackage({
      projectId: 'project-1',
      sessionId: 'session-1',
      mode: 'full',
      destinationPath: destination
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const entries = unzipSync(new Uint8Array(await readFile(destination)))
    expect(strFromU8(entries['files/figA.png'])).toBe('PNG-A')
    expect(entries['files/figB.png']).toBeUndefined()
    expect(result.notes).toContain('artifact-unreadable:files/figB.png')
  })

  it('names an artifact whose read throws instead of dropping it', async () => {
    const destination = join(work, 'out.science')
    const owner = createSessionPackageOwner(
      deps({
        readArtifact: async () => {
          throw new Error('artifact file is outside artifact storage')
        }
      })
    )

    const result = await owner.exportPackage({
      projectId: 'project-1',
      sessionId: 'session-1',
      mode: 'full',
      destinationPath: destination
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.notes).toContain('artifact-unreadable:files/figA.png')
  })

  it('counts the files for an essential package without reading a single one', async () => {
    const destination = join(work, 'out.science')
    const readArtifact = vi.fn(async () => ({
      content: 'PNG-A',
      encoding: 'utf8' as const,
      size: 5,
      truncated: false
    }))
    const owner = createSessionPackageOwner(
      deps({
        readArtifact,
        loadSession: async () => ({
          status: 'found',
          session: session([
            { id: 'a1', path: 'figures/figA.png', name: 'figA.png' },
            { id: 'a2', path: 'figures/figB.png', name: 'figB.png' }
          ])
        })
      })
    )

    const result = await owner.exportPackage({
      projectId: 'project-1',
      sessionId: 'session-1',
      mode: 'essential',
      destinationPath: destination
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(readArtifact).not.toHaveBeenCalled()
    expect(result.notes).toContain('files-not-requested:2')
  })

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
