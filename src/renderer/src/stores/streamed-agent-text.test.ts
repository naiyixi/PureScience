import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  appendStreamedAgentTextChunk,
  discardStreamedAgentText,
  resetDeliveryNumberingForTest,
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
    resetDeliveryNumberingForTest()
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
    expect(writes.map((write) => write.eventIds)).toEqual([['event-1~0'], ['event-2~0']])
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
      { streamId: 'assistant-message-1', eventIds: ['event-1~0', 'event-2~0'], content: 'ab' }
    ])
  })

  // Discarding the buffer happens when the view leaves the transcript, not only when a message is cut away,
  // so the delivery numbering must survive it: resetting made the next delivery of the same event reuse
  // `~0` and the store dropped it as a replay (4147 characters of an answer persisted as 1419).
  it('keeps counting deliveries after a discard so the next one is not read as a replay', () => {
    appendStreamedAgentTextChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: '第一段'
    })
    vi.advanceTimersByTime(STREAM_TEXT_FLUSH_MS)
    discardStreamedAgentText('assistant-message-1')
    appendStreamedAgentTextChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: '，第二段'
    })
    settleStreamedAgentText('assistant-message-1')

    expect(writes.map((write) => write.content)).toEqual(['第一段', '，第二段'])
    expect(writes.map((write) => write.eventIds)).toEqual([['event-1~0'], ['event-1~1']])
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

  // One ACP event can outlive a flush window. Its second delivery carries the same event id, so the id has
  // to be numbered — otherwise the session store reads it as a replay and the continuation is lost.
  it('numbers repeated deliveries of one event so the store cannot read them as replays', () => {
    appendStreamedAgentTextChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: '第一段'
    })
    vi.advanceTimersByTime(STREAM_TEXT_FLUSH_MS)
    appendStreamedAgentTextChunk({
      sessionId: 'session-1',
      streamId: 'assistant-message-1',
      eventId: 'event-1',
      content: '，第二段'
    })
    settleStreamedAgentText('assistant-message-1')

    expect(writes.map((write) => write.content)).toEqual(['第一段', '，第二段'])
    expect(writes.map((write) => write.eventIds)).toEqual([['event-1~0'], ['event-1~1']])
  })
})
