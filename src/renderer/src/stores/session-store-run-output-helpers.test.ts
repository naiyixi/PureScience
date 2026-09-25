import { describe, expect, it } from 'vitest'

import type { ChatMessage, ChatSession } from './session-store-persistence-owner'
import { projectAgentMessageChunk } from './session-store-run-output-helpers'

const createMessage = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'message-1',
  role: 'agent',
  content: '',
  status: 'streaming',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const createSession = (overrides: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Session',
    cwd: '/workspace',
    status: 'running',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }) as ChatSession

describe('agent message chunk projection', () => {
  it('appends a single event the way it always has', () => {
    const session = createSession({
      messages: [createMessage({ content: 'Hello ', streamId: 'stream-1' })]
    })

    const { session: next } = projectAgentMessageChunk(session, {
      sessionId: 'session-1',
      streamId: 'stream-1',
      eventId: 'event-1',
      content: 'world'
    })

    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]!.content).toBe('Hello world')
    expect(next.messages[0]!.eventIds).toEqual(['event-1'])
  })

  it('records every event id a coalesced batch carries', () => {
    const session = createSession({ messages: [createMessage({ streamId: 'stream-1' })] })

    const { session: next } = projectAgentMessageChunk(session, {
      sessionId: 'session-1',
      streamId: 'stream-1',
      eventId: 'event-1',
      eventIds: ['event-1', 'event-2', 'event-3'],
      content: 'one two three'
    })

    // The text lands once, but none of the ids may be lost: a replayed stream is deduplicated by them.
    expect(next.messages[0]!.content).toBe('one two three')
    expect(next.messages[0]!.eventIds).toEqual(['event-1', 'event-2', 'event-3'])
  })

  it('does not append the text again when a whole batch was already applied', () => {
    const session = createSession({
      messages: [
        createMessage({
          streamId: 'stream-1',
          content: 'one two three',
          eventIds: ['event-1', 'event-2']
        })
      ]
    })

    const { session: next, result } = projectAgentMessageChunk(session, {
      sessionId: 'session-1',
      streamId: 'stream-1',
      eventId: 'event-1',
      eventIds: ['event-1', 'event-2'],
      content: 'one two three'
    })

    expect(next.messages[0]!.content).toBe('one two three')
    expect(result).toEqual({ sessionId: 'session-1', messageId: 'message-1' })
  })

  it('treats a missing eventIds list as the single event id', () => {
    const session = createSession({
      messages: [createMessage({ streamId: 'stream-1', content: 'x', eventIds: ['event-1'] })]
    })

    const { session: next } = projectAgentMessageChunk(session, {
      sessionId: 'session-1',
      streamId: 'stream-1',
      eventId: 'event-1',
      content: 'x'
    })

    expect(next.messages[0]!.content).toBe('x')
    expect(next.messages[0]!.eventIds).toEqual(['event-1'])
  })

  it('creates the message once for a batch and seeds it with all ids', () => {
    const session = createSession()

    const { session: next } = projectAgentMessageChunk(session, {
      sessionId: 'session-1',
      streamId: 'stream-9',
      eventId: 'event-1',
      eventIds: ['event-1', 'event-2'],
      content: 'first words'
    })

    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]!.content).toBe('first words')
    expect(next.messages[0]!.eventIds).toEqual(['event-1', 'event-2'])
    expect(next.messages[0]!.streamId).toBe('stream-9')
  })
})
