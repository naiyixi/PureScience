import { describe, expect, it } from 'vitest'
import { summarizeSessionCatalog, summarizeSessionCatalogEntry } from './session-catalog-summary'
import type { PersistedChatMessage, PersistedChatSession } from './session-persistence'

const message = (
  id: string,
  role: PersistedChatMessage['role'],
  content: string
): PersistedChatMessage => ({ id, role, content, createdAt: 1 }) as PersistedChatMessage

const session = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    title: 'A titled session',
    cwd: '/tmp/workspace',
    status: 'active',
    permissionProfile: 'ask',
    pinned: true,
    archivedAt: undefined,
    createdAt: 10,
    updatedAt: 20,
    messages: [
      message('m1', 'user', 'hello'),
      message('m2', 'agent', 'the first answer'),
      message('m3', 'agent', 'the last answer')
    ],
    conversationGraph: { messages: [message('m2', 'agent', 'graph copy')], edges: [] },
    activities: [{ id: 'a1', eventIds: ['e1'], kind: 'tool' }],
    activityGroups: [{ id: 'g1' }],
    ...overrides
  }) as unknown as PersistedChatSession

describe('the session catalog summary', () => {
  it('carries the session identity and drops the four heavy fields', () => {
    const summary = summarizeSessionCatalogEntry(session())

    expect(summary.id).toBe('session-1')
    expect(summary.title).toBe('A titled session')
    expect(summary.permissionProfile).toBe('ask')
    expect(summary.pinned).toBe(true)
    expect(summary.updatedAt).toBe(20)

    // The whole point of the projection: these four are what the list does not need.
    expect('messages' in summary).toBe(false)
    expect('conversationGraph' in summary).toBe(false)
    expect('activities' in summary).toBe(false)
    expect('activityGroups' in summary).toBe(false)
  })

  it('reports the message count and the last agent message', () => {
    const summary = summarizeSessionCatalogEntry(session())

    expect(summary.messageCount).toBe(3)
    // The Task API reads exactly this field for a task's output; taking the last message regardless of
    // role would report the user's own prompt back as the result.
    expect(summary.lastAgentMessage).toBe('the last answer')
  })

  it('omits the last agent message when no agent message exists, rather than inventing an empty one', () => {
    const summary = summarizeSessionCatalogEntry(
      session({ messages: [message('m1', 'user', 'only a prompt')] })
    )

    expect(summary.messageCount).toBe(1)
    expect('lastAgentMessage' in summary).toBe(false)
  })

  it('survives a session with no messages at all', () => {
    const summary = summarizeSessionCatalogEntry(
      session({ messages: undefined as unknown as never })
    )

    expect(summary.messageCount).toBe(0)
    expect('lastAgentMessage' in summary).toBe(false)
  })

  it('does not mutate the session it projects', () => {
    const original = session()
    const before = JSON.stringify(original)

    summarizeSessionCatalogEntry(original)

    expect(JSON.stringify(original)).toBe(before)
  })

  it('projects a whole catalog in order', () => {
    const summaries = summarizeSessionCatalog([
      session({ id: 'session-a' }),
      session({ id: 'session-b' })
    ])

    expect(summaries.map((entry) => entry.id)).toEqual(['session-a', 'session-b'])
  })
})
