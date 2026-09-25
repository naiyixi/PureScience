import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/stores/session-store'
import { resolveMessageContent, selectLiveMessageContent } from './message-content-subscription'

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

const createState = (
  sessions: { id: string; messages: ChatMessage[] }[]
): {
  sessions: { id: string; messages: ChatMessage[] }[]
} => ({ sessions })

describe('selectLiveMessageContent', () => {
  it('returns the text the store holds for the message', () => {
    const state = createState([
      { id: 'session-1', messages: [createMessage({ content: 'streamed so far' })] }
    ])

    expect(selectLiveMessageContent(state, 'session-1', 'message-1')).toBe('streamed so far')
  })

  it('returns undefined for an anonymous surface, an unknown session or an unknown message', () => {
    const state = createState([{ id: 'session-1', messages: [createMessage()] }])

    expect(selectLiveMessageContent(state, undefined, 'message-1')).toBeUndefined()
    expect(selectLiveMessageContent(state, 'session-2', 'message-1')).toBeUndefined()
    expect(selectLiveMessageContent(state, 'session-1', 'message-2')).toBeUndefined()
  })

  it('returns an empty string when the store holds the message with no text yet', () => {
    const state = createState([{ id: 'session-1', messages: [createMessage({ content: '' })] }])

    expect(selectLiveMessageContent(state, 'session-1', 'message-1')).toBe('')
  })
})

describe('resolveMessageContent', () => {
  it('uses the store text when it continues what the message was rendered with', () => {
    expect(resolveMessageContent('partial more', 'partial')).toBe('partial more')
    expect(resolveMessageContent('partial', 'partial')).toBe('partial')
  })

  it('keeps the rendered text when the store holds another generation of the message', () => {
    // An isolated surface rendering a snapshot, a session reloaded after this render, or a run that
    // rewrote its own text: none of these are this message's streamed continuation.
    expect(resolveMessageContent('Prompt', 'Analyze the sample')).toBe('Analyze the sample')
    expect(resolveMessageContent('', 'Analyze the sample')).toBe('Analyze the sample')
    expect(resolveMessageContent('partial', 'partial more')).toBe('partial more')
  })

  it('keeps the rendered text when the store does not hold the message at all', () => {
    expect(resolveMessageContent(undefined, 'Analyze the sample')).toBe('Analyze the sample')
  })

  it('treats two empty strings as the same value', () => {
    expect(resolveMessageContent('', '')).toBe('')
  })
})
