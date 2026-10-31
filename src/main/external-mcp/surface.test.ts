import { describe, expect, it } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  DEFAULT_MESSAGE_LIMIT,
  EXTERNAL_MCP_TOOLS,
  MAX_MESSAGE_LIMIT,
  externalMcpCommandNames,
  externalMcpToolById,
  externalMcpToolIds,
  projectRow,
  sessionExcerpt,
  sessionRow
} from './surface'

const session = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    title: 'A conversation',
    status: 'idle',
    cwd: '/tmp/workspace',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    messages: [
      { id: 'm1', role: 'user', status: 'complete', content: 'one' },
      { id: 'm2', role: 'agent', status: 'complete', content: 'two' },
      { id: 'm3', role: 'user', status: 'complete', content: 'three' }
    ],
    ...overrides
  }) as PersistedChatSession

describe('external MCP surface', () => {
  it('declares every tool completely, so tools/list never advertises a blank field', () => {
    expect(EXTERNAL_MCP_TOOLS.length).toBeGreaterThan(0)
    for (const tool of EXTERNAL_MCP_TOOLS) {
      expect(tool.id).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(tool.title.length).toBeGreaterThan(0)
      // An outside model reads only this text, so it has to say what the tool returns, not just its name.
      expect(tool.description.length).toBeGreaterThan(40)
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.additionalProperties).toBe(false)
      // The risk is a two-value contract, and the dispatch path branches on it. A value outside the union
      // would fall through to the read path, so it is checked here rather than trusted.
      expect(['read', 'write']).toContain(tool.risk)
      expect(tool.command).toMatch(/^[a-z][a-z0-9-]*:[a-z0-9:-]+$/)
    }
  })

  it('keeps the write set explicit, so a write cannot appear by adding a table row', () => {
    // Widening this set is meant to be a decision that also wires a planner and an approval argument; the
    // suite fails here first if a row is marked `write` without that decision.
    expect(
      EXTERNAL_MCP_TOOLS.filter((tool) => tool.risk === 'write').map((tool) => tool.id)
    ).toEqual(['archive_session'])
  })

  it('keeps the tool ids and the reachable command list unique and derived from the table', () => {
    expect(new Set(externalMcpToolIds).size).toBe(externalMcpToolIds.length)
    // Derived, not typed twice: the set is exactly the commands the table names, sorted.
    expect(externalMcpCommandNames).toEqual(
      [...new Set(EXTERNAL_MCP_TOOLS.map((tool) => tool.command))].sort()
    )
    expect(externalMcpCommandNames.length).toBeGreaterThan(0)
  })

  it('resolves tools by id and refuses to invent one', () => {
    expect(externalMcpToolById(externalMcpToolIds[0]!)?.id).toBe(externalMcpToolIds[0])
    expect(externalMcpToolById('delete_everything')).toBeUndefined()
    // Exact match only: a prefix must not resolve to the tool it resembles.
    expect(externalMcpToolById('list_project')).toBeUndefined()
  })

  it('declares required fields for the tools that cannot work without an argument', () => {
    const required = Object.fromEntries(
      EXTERNAL_MCP_TOOLS.map((tool) => [tool.id, tool.inputSchema.required ?? []])
    ) as Record<string, readonly string[]>
    expect(required.read_session).toEqual(['sessionId'])
    expect(required.list_project_files).toEqual(['project'])
    // Listing needs nothing, so an outside client can always start from a call that cannot be wrong.
    expect(required.list_projects).toEqual([])
    expect(required.list_sessions).toEqual([])
  })
})

describe('external MCP projections', () => {
  it('projects a project row without inventing a description', () => {
    expect(projectRow({ id: 'p1', name: 'Library' })).toEqual({ id: 'p1', name: 'Library' })
    expect(projectRow({ id: 'p1', name: 'Library', description: 'notes' })).toEqual({
      id: 'p1',
      name: 'Library',
      description: 'notes'
    })
  })

  it('projects a session row with an ISO timestamp and a real message count', () => {
    expect(sessionRow(session())).toEqual({
      id: 'session-1',
      projectId: 'project-1',
      title: 'A conversation',
      status: 'idle',
      updatedAt: '2023-11-14T22:15:00.000Z',
      messageCount: 3
    })
    // A row without a timestamp says so by absence; it never prints "Invalid Date".
    const withoutTimestamp = sessionRow({ id: 's2', projectId: 'p1', title: 't', status: 'idle' })
    expect(withoutTimestamp).toEqual({
      id: 's2',
      projectId: 'p1',
      title: 't',
      status: 'idle',
      messageCount: 0
    })
    expect('updatedAt' in withoutTimestamp).toBe(false)
  })

  it('says when a conversation is archived, so the write that archived it is observable', () => {
    // The write tool's effect has to be readable through the read tier; otherwise a client archives a
    // conversation and its next list looks identical.
    const archived = sessionRow({
      id: 's4',
      projectId: 'p1',
      title: 't',
      status: 'done',
      messageCount: 2,
      archivedAt: 1_700_000_900_000
    })
    expect(archived.archived).toBe('2023-11-14T22:28:20.000Z')
    // Live conversations say nothing, and an unusable value is absence rather than a wrong timestamp.
    expect(
      'archived' in sessionRow({ id: 's5', projectId: 'p1', title: 't', status: 'idle' })
    ).toBe(false)
    expect(
      'archived' in
        sessionRow({
          id: 's6',
          projectId: 'p1',
          title: 't',
          status: 'idle',
          archivedAt: Number.NaN
        })
    ).toBe(false)
  })

  it('does not let a count-only row claim the messages it does not carry', () => {
    // The catalog projection carries `messageCount` and no `messages`; the row must report the count the
    // command gave it rather than 0 from an empty array.
    expect(
      sessionRow({ id: 's3', projectId: 'p1', title: 't', status: 'done', messageCount: 42 })
        .messageCount
    ).toBe(42)
  })

  it('returns the most recent messages in conversation order and says when it truncated', () => {
    const excerpt = sessionExcerpt(session(), 2)
    expect(excerpt.messages.map((message) => message.content)).toEqual(['two', 'three'])
    expect(excerpt.messageCount).toBe(3)
    expect(excerpt.messagesReturned).toBe(2)
    expect(excerpt.truncated).toBe(true)
  })

  it('is explicit about a whole conversation, and about an empty one', () => {
    const whole = sessionExcerpt(session(), undefined)
    expect(whole.messagesReturned).toBe(3)
    expect(whole.truncated).toBe(false)

    const empty = sessionExcerpt(session({ messages: [] }), undefined)
    expect(empty.messages).toEqual([])
    expect(empty.messageCount).toBe(0)
    // "No messages" and "everything was returned" are different facts; both must be readable.
    expect(empty.truncated).toBe(false)
  })

  it('clamps a limit instead of rejecting it, and defaults to the declared one', () => {
    const huge = sessionExcerpt(session(), 10_000)
    expect(MAX_MESSAGE_LIMIT).toBeGreaterThan(DEFAULT_MESSAGE_LIMIT)
    expect(huge.messagesReturned).toBe(Math.min(MAX_MESSAGE_LIMIT, 3))

    const bogus = sessionExcerpt(session(), Number.NaN)
    expect(bogus.messagesReturned).toBe(Math.min(DEFAULT_MESSAGE_LIMIT, 3))
    expect(bogus.truncated).toBe(false)

    const zero = sessionExcerpt(session(), 0)
    expect(zero.messagesReturned).toBe(1)
    expect(zero.truncated).toBe(true)
  })
})
