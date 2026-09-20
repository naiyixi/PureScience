import { describe, expect, it } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import { SessionForkError, SessionForkService } from './fork'

const source = (): PersistedChatSession =>
  ({
    id: 'session-source',
    projectId: 'project-1',
    title: 'Deep learning for protein design',
    description: 'A short description',
    cwd: '/workspace',
    status: 'idle',
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: 'do the thing',
        status: 'complete',
        eventIds: ['event-a']
      },
      {
        id: 'message-2',
        role: 'agent',
        content: 'done',
        status: 'complete',
        eventIds: ['event-b'],
        responseToMessageId: 'message-1',
        artifactIds: ['artifact-1', 'artifact-2'],
        uploads: [{ id: 'upload-1', name: 'input.csv' }]
      },
      {
        id: 'message-3',
        role: 'agent',
        content: 'and again',
        status: 'complete',
        eventIds: ['event-c'],
        artifactIds: ['artifact-2']
      }
    ],
    createdAt: 1_000,
    updatedAt: 2_000
  }) as unknown as PersistedChatSession

const createService = (
  document: PersistedChatSession | undefined
): {
  service: SessionForkService
  saved: PersistedChatSession[]
} => {
  const saved: PersistedChatSession[] = []
  let sequence = 0
  const service = new SessionForkService({
    load: async () => document,
    save: async (session) => {
      saved.push(session)
    },
    sizeBytes: async () => 4096,
    newId: () => `new-${++sequence}`,
    now: () => 9_000
  })
  return { service, saved }
}

describe('fork planning measures before anything is copied', () => {
  it('reports what a copy would hold and what it would not', async () => {
    const { service, saved } = createService(source())
    const manifest = await service.planFork('project-1', 'session-source')
    expect(manifest?.counts).toEqual({
      messages: 3,
      agentReplies: 2,
      uploads: 1,
      artifactReferences: 2
    })
    expect(manifest?.bytes).toBe(4096)
    expect(manifest?.notCarried).toContain('event-ids')
    expect(manifest?.notCarried).toContain('artifact-versions')
    // Planning is read-only.
    expect(saved).toHaveLength(0)
  })

  it('returns nothing for a session that is gone rather than a copy of nothing', async () => {
    const { service } = createService(undefined)
    expect(await service.planFork('project-1', 'missing')).toBeUndefined()
    await expect(service.forkSession('project-1', 'missing')).rejects.toBeInstanceOf(
      SessionForkError
    )
  })
})

describe('forking inherits the evidence chain, never the identity', () => {
  it('gives the copy fresh message ids, remaps reply links and keeps provenance on the copy', async () => {
    const original = source()
    const { service, saved } = createService(original)
    const { session } = await service.forkSession('project-1', 'session-source')

    expect(session.id).not.toBe(original.id)
    expect(session.messages.map((message) => message.id)).toEqual(['new-1', 'new-2', 'new-3'])
    // The reply link follows the copy's own ids instead of dangling at the source's.
    expect(session.messages[1].responseToMessageId).toBe('new-1')
    expect(session.messages[1].artifactIds).toEqual(['artifact-1', 'artifact-2'])
    expect(session.messages[2].artifactIds).toEqual(['artifact-2'])
    expect(session.messages[1].uploads?.map((upload) => upload.id)).toEqual(['upload-1'])
    expect(session.forkedFrom).toEqual({
      sessionId: 'session-source',
      projectId: 'project-1',
      at: 9_000
    })
    // A copy has not run: no activity log, no active run, idle status.
    expect(session.activities).toEqual([])
    expect(session.status).toBe('idle')
    expect((session as { activeRun?: unknown }).activeRun).toBeUndefined()
    expect(saved).toHaveLength(1)
  })

  it('never writes to the source document', async () => {
    const original = source()
    const before = JSON.stringify(original)
    const { service } = createService(original)
    await service.forkSession('project-1', 'session-source')
    expect(JSON.stringify(original)).toBe(before)
    expect(original.messages.map((message) => message.id)).toEqual([
      'message-1',
      'message-2',
      'message-3'
    ])
    expect(original.forkedFrom).toBeUndefined()
    expect((original as { eventIds?: unknown }).eventIds).toBeUndefined()
  })

  it('cuts history at the requested turn, inclusively, and records which turn', async () => {
    const { service } = createService(source())
    const { session, manifest } = await service.forkSession('project-1', 'session-source', {
      sourceMessageId: 'message-2'
    })
    expect(session.messages).toHaveLength(2)
    expect(session.forkedFrom?.sourceMessageId).toBe('message-2')
    // The manifest still describes the whole source, so the caller knows what was left behind.
    expect(manifest.counts.messages).toBe(3)
  })

  it('drops the source activity links, and says so in the manifest', async () => {
    const { service } = createService(source())
    const { session, manifest } = await service.forkSession('project-1', 'session-source')
    expect(session.messages.every((message) => message.eventIds.length === 0)).toBe(true)
    expect(manifest.notCarried).toContain('event-ids')
  })
})
