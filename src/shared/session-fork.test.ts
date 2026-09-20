import { describe, expect, it } from 'vitest'

import { buildSessionFork, planSessionFork, SESSION_FORK_NOT_CARRIED } from './session-fork'
import type { PersistedChatSession } from './session-persistence'

// The shared fork functions are what the renderer calls directly (the main-process service adds only
// I/O), so they are tested here on their own rather than only through that service.

const source = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession =>
  ({
    id: 'session-source',
    projectId: 'project-1',
    title: 'Deep learning for protein design',
    description: 'A short description',
    cwd: '/workspace',
    status: 'idle',
    messages: [
      { id: 'm1', role: 'user', content: 'ask', status: 'complete', eventIds: ['e1'] },
      {
        id: 'm2',
        role: 'agent',
        content: 'answer',
        status: 'complete',
        eventIds: ['e2'],
        responseToMessageId: 'm1',
        artifactIds: ['a1', 'a2'],
        uploads: [{ id: 'u1', name: 'input.csv' }]
      }
    ],
    activities: [{ id: 'activity-1' }],
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides
  }) as unknown as PersistedChatSession

const ids = (): (() => string) => {
  let n = 0
  return () => `fresh-${++n}`
}

describe('shared fork planning', () => {
  it('counts what the copy would hold, including bytes when known', () => {
    const manifest = planSessionFork(source(), 2_048)
    expect(manifest.counts).toEqual({
      messages: 2,
      agentReplies: 1,
      uploads: 1,
      artifactReferences: 2
    })
    expect(manifest.bytes).toBe(2_048)
    expect(manifest.notCarried).toEqual([...SESSION_FORK_NOT_CARRIED])
    expect(manifest.source).toMatchObject({ sessionId: 'session-source', projectId: 'project-1' })
  })

  it('omits bytes rather than inventing a zero size', () => {
    expect(planSessionFork(source()).bytes).toBeUndefined()
  })
})

describe('shared fork construction', () => {
  it('gives the copy its own ids and remaps reply links onto them', () => {
    const { session } = buildSessionFork(source(), { newId: ids(), now: () => 9_000 })
    expect(session.id).toBe('fresh-1')
    expect(session.messages.map((message) => message.id)).toEqual(['fresh-2', 'fresh-3'])
    expect(session.messages[1].responseToMessageId).toBe('fresh-2')
    expect(session.messages[1].artifactIds).toEqual(['a1', 'a2'])
    expect(session.forkedFrom).toMatchObject({ sessionId: 'session-source', at: 9_000 })
  })

  it('keeps the source untouched and the copy run-free', () => {
    const original = source()
    const before = JSON.stringify(original)
    const { session } = buildSessionFork(original, { newId: ids(), now: () => 9_000 })
    expect(JSON.stringify(original)).toBe(before)
    expect(session.activities).toEqual([])
    expect(session.status).toBe('idle')
    expect(session.messages.every((message) => message.eventIds.length === 0)).toBe(true)
    expect((session as { activeRun?: unknown }).activeRun).toBeUndefined()
  })

  it('cuts at a requested turn inclusively while the manifest still describes the whole source', () => {
    const { session, manifest } = buildSessionFork(source(), {
      newId: ids(),
      now: () => 9_000,
      sourceMessageId: 'm1'
    })
    expect(session.messages).toHaveLength(1)
    expect(session.forkedFrom?.sourceMessageId).toBe('m1')
    expect(manifest.counts.messages).toBe(2)
  })

  it('copies everything when the requested turn is not in the source', () => {
    const { session } = buildSessionFork(source(), {
      newId: ids(),
      now: () => 9_000,
      sourceMessageId: 'message-that-is-gone'
    })
    expect(session.messages).toHaveLength(2)
    // The provenance still records what was asked for, so a caller can explain the difference.
    expect(session.forkedFrom?.sourceMessageId).toBe('message-that-is-gone')
  })

  it('makes a copy of an imported session writable, and says the posture was left behind', () => {
    const imported = source({
      importedFrom: { sessionId: 'external', projectId: 'external' }
    } as Partial<PersistedChatSession>)
    const manifest = planSessionFork(imported)
    expect(manifest.notCarried).toContain('import-posture')

    const { session } = buildSessionFork(imported, { newId: ids(), now: () => 9_000 })
    // The copy does not claim imported history: it is a new, writable session with a lineage.
    expect((session as unknown as Record<string, unknown>).importedFrom).toBeUndefined()
    expect(session.forkedFrom).toMatchObject({ sessionId: 'session-source' })
    // The source keeps its posture untouched.
    expect((imported as unknown as Record<string, unknown>).importedFrom).toBeDefined()
  })

  it('does not name an import posture the source never had', () => {
    expect(planSessionFork(source()).notCarried).not.toContain('import-posture')
  })
})
