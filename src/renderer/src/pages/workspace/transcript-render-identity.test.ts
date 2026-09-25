import { describe, expect, it } from 'vitest'

import type { ChatMessage, ChatSession } from '@/stores/session-store'
import {
  carriesSameSessionListStructure,
  carriesSameTranscriptStructure
} from './transcript-render-identity'

const createMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'message-1',
  role: 'agent',
  content: 'Answer',
  status: 'complete',
  eventIds: ['event-1'],
  createdAt: 1_710_000_000_000,
  updatedAt: 1_710_000_000_000,
  ...overrides
})

const settledMessages = (): ChatMessage[] => [
  createMessage({ id: 'prompt-1', role: 'user', content: 'Question' }),
  createMessage({ id: 'reply-1', content: 'First answer' }),
  createMessage({ id: 'prompt-2', role: 'user', content: 'Follow-up' }),
  createMessage({
    id: 'reply-2',
    content: 'partial',
    status: 'streaming',
    streamId: 'stream-1',
    eventIds: []
  })
]

const createSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: 'session-1',
  projectId: 'project-a',
  title: 'Session',
  cwd: '/workspace',
  status: 'running',
  messages: settledMessages(),
  createdAt: 1_710_000_000_000,
  updatedAt: 1_710_000_000_000,
  ...overrides
})

// The shape `projectAgentMessageChunk` applies per chunk: a new session, a new messages array, and one
// replaced message. Settled messages keep their instance.
const appendChunk = (session: ChatSession, text: string, eventId: string): ChatSession => ({
  ...session,
  updatedAt: session.updatedAt + 1,
  messages: session.messages.map((message) =>
    message.id === 'reply-2'
      ? {
          ...message,
          content: `${message.content}${text}`,
          eventIds: [...message.eventIds, eventId],
          updatedAt: session.updatedAt + 1
        }
      : message
  )
})

describe('carriesSameTranscriptStructure', () => {
  it('accepts the same instance and rejects a missing side', () => {
    const session = createSession()

    expect(carriesSameTranscriptStructure(session, session)).toBe(true)
    expect(carriesSameTranscriptStructure(session, undefined)).toBe(false)
    expect(carriesSameTranscriptStructure(undefined, session)).toBe(false)
    expect(carriesSameTranscriptStructure(undefined, undefined)).toBe(true)
  })

  it('sees a streamed chunk as structurally identical', () => {
    const session = createSession()

    expect(carriesSameTranscriptStructure(session, appendChunk(session, ' more', 'event-2'))).toBe(
      true
    )
  })

  it('keeps accepting chunks once the transcript has grown', () => {
    const session = createSession()
    const afterFirst = appendChunk(session, ' more', 'event-2')
    const afterSecond = appendChunk(afterFirst, ' text', 'event-3')

    expect(carriesSameTranscriptStructure(afterFirst, afterSecond)).toBe(true)
  })

  it('treats a settled message text change as structure', () => {
    const session = createSession()
    const edited = {
      ...session,
      messages: session.messages.map((message) =>
        message.id === 'reply-1' ? { ...message, content: 'Rewritten answer' } : message
      )
    }

    expect(carriesSameTranscriptStructure(session, edited)).toBe(false)
  })

  it('treats a user message text change as structure', () => {
    const session = createSession()
    const edited = {
      ...session,
      messages: session.messages.map((message) =>
        message.id === 'prompt-1' ? { ...message, content: 'Edited question' } : message
      )
    }

    expect(carriesSameTranscriptStructure(session, edited)).toBe(false)
  })

  it('rejects a streaming message that left the streaming status', () => {
    const session = createSession()
    const finished = {
      ...session,
      messages: session.messages.map((message) =>
        message.id === 'reply-2' ? { ...message, status: 'complete' as const } : message
      )
    }

    expect(carriesSameTranscriptStructure(session, finished)).toBe(false)
  })

  it('rejects any other field change on the streaming message', () => {
    const session = createSession()
    const withImage = {
      ...session,
      messages: session.messages.map((message): ChatMessage =>
        message.id === 'reply-2'
          ? {
              ...message,
              images: [
                {
                  id: 'image-1',
                  mimeType: 'image/png',
                  byteLength: 12,
                  data: 'AAAA'
                }
              ]
            }
          : message
      )
    }

    expect(carriesSameTranscriptStructure(session, withImage)).toBe(false)
  })

  it('rejects added, removed or reordered messages', () => {
    const session = createSession()

    expect(
      carriesSameTranscriptStructure(session, {
        ...session,
        messages: [...session.messages, createMessage({ id: 'reply-3', content: 'New turn' })]
      })
    ).toBe(false)
    expect(
      carriesSameTranscriptStructure(session, {
        ...session,
        messages: session.messages.slice(0, 3)
      })
    ).toBe(false)
    expect(
      carriesSameTranscriptStructure(session, {
        ...session,
        messages: [session.messages[1], session.messages[0], ...session.messages.slice(2)]
      })
    ).toBe(false)
  })

  it('ignores the reviewer-activity gate and the session timestamp', () => {
    const session = createSession()

    expect(
      carriesSameTranscriptStructure(session, {
        ...session,
        branchSwitchBlocked: true,
        updatedAt: session.updatedAt + 5_000
      })
    ).toBe(true)
  })

  it('rejects a change to any rendered session field', () => {
    const session = createSession()

    expect(carriesSameTranscriptStructure(session, { ...session, status: 'idle' })).toBe(false)
    expect(carriesSameTranscriptStructure(session, { ...session, title: 'Renamed' })).toBe(false)
    expect(carriesSameTranscriptStructure(session, { ...session, error: 'boom' })).toBe(false)
    expect(carriesSameTranscriptStructure(session, { ...session, interrupted: true })).toBe(false)
  })

  it('rejects a new session field it does not know about', () => {
    const session = createSession()
    const withUnknownField = { ...session, futureFlag: true } as ChatSession

    expect(carriesSameTranscriptStructure(session, withUnknownField)).toBe(false)
  })
})

describe('carriesSameSessionListStructure', () => {
  it('accepts the same list and two empty lists', () => {
    const sessions = [createSession()]

    expect(carriesSameSessionListStructure(sessions, sessions)).toBe(true)
    expect(carriesSameSessionListStructure([], [])).toBe(true)
  })

  it('accepts a list where only the streamed text moved', () => {
    const session = createSession()
    const other = createSession({ id: 'session-2', title: 'Idle session' })

    expect(
      carriesSameSessionListStructure(
        [session, other],
        [appendChunk(session, ' more', 'event-2'), other]
      )
    ).toBe(true)
  })

  it('rejects a list that grew, shrank or reordered', () => {
    const first = createSession()
    const second = createSession({ id: 'session-2' })

    expect(carriesSameSessionListStructure([first], [first, second])).toBe(false)
    expect(carriesSameSessionListStructure([first, second], [first])).toBe(false)
    expect(carriesSameSessionListStructure([first, second], [second, first])).toBe(false)
  })

  it('rejects a structural change anywhere in the list', () => {
    const session = createSession()
    const other = createSession({ id: 'session-2' })

    expect(
      carriesSameSessionListStructure(
        [session, other],
        [session, { ...other, status: 'waiting-permission' }]
      )
    ).toBe(false)
    expect(
      carriesSameSessionListStructure(
        [session, other],
        [session, { ...other, title: 'Renamed while streaming' }]
      )
    ).toBe(false)
  })
})
