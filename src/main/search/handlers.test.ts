import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import { createSearchHandlers } from './handlers'

const session = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Sine plot',
    createdAt: 1_789_000_000_000,
    updatedAt: 1_789_000_060_000,
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: 'write replay_probe.csv',
        status: 'complete',
        eventIds: []
      },
      {
        id: 'message-2',
        role: 'agent',
        content: 'wrote sin(x) values to replay_probe.csv',
        status: 'complete',
        eventIds: []
      }
    ],
    ...overrides
  }) as unknown as PersistedChatSession

const harness = (
  overrides: Partial<Parameters<typeof createSearchHandlers>[0]> = {}
): {
  query: ReturnType<typeof createSearchHandlers>['query']
  listFiles: ReturnType<typeof vi.fn>
  listReferences: ReturnType<typeof vi.fn>
} => {
  const listFiles = vi.fn(async () => [
    { id: 'file-1', title: 'sin_probe.csv', relativePath: 'data/sin_probe.csv' }
  ])
  const listReferences = vi.fn(async () => [
    { id: 'ref-1', title: 'A study of sin', abstract: 'sin everywhere' }
  ])
  const handlers = createSearchHandlers({
    loadSessions: async () => [session()],
    listFiles,
    listReferences,
    ...overrides
  })

  return { query: handlers.query, listFiles, listReferences }
}

describe('createSearchHandlers', () => {
  it('maps persisted sessions and messages into the search contract', async () => {
    const { query } = harness()
    const response = await query({ query: 'sin', scopes: ['sessions', 'messages'] })

    const messages = response.hits.find((hit) => hit.scope === 'messages')
    expect(messages).toMatchObject({
      id: 'message-2',
      sessionId: 'session-1',
      messageIndex: 1,
      role: 'agent'
    })
    // Epoch-millisecond session timestamps become ISO-8601 in the contract.
    expect(messages?.timestamp).toBe(new Date(1_789_000_060_000).toISOString())
  })

  it('says a project-less query cannot reach files or literature', async () => {
    const { query, listFiles, listReferences } = harness()
    const response = await query({ query: 'sin' })

    expect(response.notes).toContain('no-project-scope')
    expect(listFiles).not.toHaveBeenCalled()
    expect(listReferences).not.toHaveBeenCalled()
  })

  it('reads files and literature only for a project, and only when asked', async () => {
    const { query, listFiles, listReferences } = harness()
    const response = await query({ query: 'sin', projectId: 'project-1', scopes: ['files'] })

    expect(listFiles).toHaveBeenCalledWith({ projectId: 'project-1' })
    expect(listReferences).not.toHaveBeenCalled()
    expect(response.notes).not.toContain('no-project-scope')
    expect(response.hits.map((hit) => hit.scope)).toEqual(['files'])
  })

  it('searches the literature library when asked', async () => {
    const { query } = harness()
    const response = await query({ query: 'sin', projectId: 'project-1', scopes: ['literature'] })

    expect(response.hits).toHaveLength(1)
    expect(response.hits[0]).toMatchObject({
      scope: 'literature',
      id: 'ref-1',
      projectId: 'project-1'
    })
  })

  it('reports the scan even when a scope found nothing', async () => {
    const { query } = harness()
    const response = await query({ query: 'absent', projectId: 'project-1' })

    expect(response.hits).toEqual([])
    expect(response.scan.messages).toBe(2)
    expect(response.scan.files).toBe(1)
    expect(response.scan.references).toBe(1)
  })
})
