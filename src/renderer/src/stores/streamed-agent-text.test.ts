import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  appendStreamedAgentTextChunk,
  discardStreamedAgentText,
  setStreamedAgentTextSink,
  settleStreamedAgentText,
  STREAM_TEXT_FLUSH_MS
} from './streamed-agent-text'

// Rebuilds the shape the event bridge produces: two deltas of the same reply, each preceded by a settle
// (the bridge settles before it closes an activity group), with the reply's text landing in two writes.
// This is the layer that failed in the wiring, so it gets to fail here first — and to prove its own rules.
describe('buffered streamed agent text', () => {
  const writes: { streamId: string; eventIds: string[]; content: string }[] = []

  let previousSink: ReturnType<typeof setStreamedAgentTextSink>

  beforeEach(() => {
    vi.useFakeTimers()
    writes.length = 0
    previousSink = setStreamedAgentTextSink((write) => {
      writes.push({ streamId: write.streamId, eventIds: write.eventIds, content: write.content })
    })
  })

  afterEach(() => {
    if (previousSink) setStreamedAgentTextSink(previousSink)
    vi.useRealTimers()
  })

  it('writes each window of a reply separately', () => {
    settleStreamedAgentText('assistant-message-1')
    appendStreamedAgentTextChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'Hel'
    })
    vi.advanceTimersByTime(STREAM_TEXT_FLUSH_MS)
    expect(writes.map((write) => write.content)).toEqual(['Hel'])

    settleStreamedAgentText('assistant-message-1')
    appendStreamedAgentTextChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-2',
      content: 'lo'
    })
    vi.advanceTimersByTime(STREAM_TEXT_FLUSH_MS)

    expect(writes.map((write) => write.content)).toEqual(['Hel', 'lo'])
    expect(writes.map((write) => write.eventIds)).toEqual([['event-1'], ['event-2']])
  })

  it('keeps every event id of a window so a replay stays idempotent', () => {
    appendStreamedAgentTextChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'a'
    })
    appendStreamedAgentTextChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-2',
      content: 'b'
    })
    vi.advanceTimersByTime(STREAM_TEXT_FLUSH_MS)

    expect(writes).toEqual([
      { streamId: 'assistant-message-1', eventIds: ['event-1', 'event-2'], content: 'ab' }
    ])
  })

  it('drops the buffer of a stream the transcript cut away', () => {
    appendStreamedAgentTextChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: 'gone'
    })
    discardStreamedAgentText('assistant-message-1')
    vi.advanceTimersByTime(STREAM_TEXT_FLUSH_MS)

    expect(writes).toEqual([])
  })
})
