import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import { createSessionIndex } from './session-index'

const session = (id: string): PersistedChatSession => ({
  id,
  projectId: 'project-a',
  title: id,
  messages: [],
  activities: [],
  cwd: '/tmp',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1
})

describe('session index', () => {
  it('reads once and answers the following queries from what it has', async () => {
    const revision = 0
    const loadAll = vi.fn(async () => [session('session-1')])
    const index = createSessionIndex({ loadAll, revision: () => revision, now: () => 1_000 })

    expect((await index.getSessions()).map((entry) => entry.id)).toEqual(['session-1'])
    expect((await index.getSessions()).map((entry) => entry.id)).toEqual(['session-1'])
    expect((await index.getSessions()).length).toBe(1)

    // The corpus is read once, not once per query: this is the whole point.
    expect(loadAll).toHaveBeenCalledTimes(1)
    expect(index.stats()).toEqual({ reads: 1, hits: 2, sessions: 1 })
  })

  it('re-reads as soon as a session is written', async () => {
    let revision = 0
    const loadAll = vi.fn(async () => [session(`session-${revision}`)])
    const index = createSessionIndex({ loadAll, revision: () => revision, now: () => 1_000 })

    expect((await index.getSessions())[0].id).toBe('session-0')
    revision += 1
    expect((await index.getSessions())[0].id).toBe('session-1')
    revision += 1
    expect((await index.getSessions())[0].id).toBe('session-2')

    expect(loadAll).toHaveBeenCalledTimes(3)
    expect(index.stats().hits).toBe(0)
  })

  it('re-reads once the safety window passes, so a write from elsewhere is not missed forever', async () => {
    let clock = 1_000
    const loadAll = vi.fn(async () => [session('session-1')])
    // The revision never moves here: this stands for a session written by another process on the same
    // data root, which this process has no way of being told about.
    const index = createSessionIndex({
      loadAll,
      revision: () => 0,
      now: () => clock,
      ttlMs: 5_000
    })

    await index.getSessions()
    clock += 4_999
    await index.getSessions()
    expect(loadAll).toHaveBeenCalledTimes(1)

    clock += 2
    await index.getSessions()
    expect(loadAll).toHaveBeenCalledTimes(2)
  })

  it('shares one read between queries that arrive while it is still reading', async () => {
    let release: ((sessions: PersistedChatSession[]) => void) | undefined
    const loadAll = vi.fn(
      () =>
        new Promise<PersistedChatSession[]>((resolve) => {
          release = resolve
        })
    )
    const index = createSessionIndex({ loadAll, revision: () => 0, now: () => 1_000 })

    const first = index.getSessions()
    const second = index.getSessions()
    release?.([session('session-1')])

    expect((await first)[0].id).toBe('session-1')
    expect((await second)[0].id).toBe('session-1')
    // A burst of keystrokes must not each start their own scan of the corpus.
    expect(loadAll).toHaveBeenCalledTimes(1)
  })

  it('forgets what it had when asked to', async () => {
    let revision = 0
    const loadAll = vi.fn(async () => [session(`session-${revision}`)])
    const index = createSessionIndex({ loadAll, revision: () => revision, now: () => 1_000 })

    await index.getSessions()
    revision += 1
    index.invalidate()
    await index.getSessions()
    expect(loadAll).toHaveBeenCalledTimes(2)
    expect(index.stats()).toEqual({ reads: 2, hits: 0, sessions: 1 })
  })
})
