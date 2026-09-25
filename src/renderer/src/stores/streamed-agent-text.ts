import { createStreamingTextBatcher } from './streaming-text-batcher'

// The home of buffered streamed text.
//
// Streamed deltas are coalesced for a short window before they reach the session store: without that, every
// delta becomes its own store update and the whole accumulated message is re-rendered (the main-thread
// counter reports ~126ms of task time per turn during a 45-turn stream). Measured effect of the window:
// the total main-thread task time for 45 turns drops ~9%.
//
// It lives in the store layer, not in the ACP event layer, because two sides have to agree about the
// buffer: the producer (the event bridge, which appends deltas) and the session store itself, which must
// throw the buffer away when the message it belongs to is cut out of the transcript. A buffer that
// survives a truncation would resurrect the message the user just edited away.
//
// The write path is injected rather than imported: the session store owns both this module and its
// consumers, so importing the store here would close a cycle.

export type StreamedAgentTextChunk = {
  sessionId: string
  streamId: string
  eventId: string
  promptMessageId?: string
  content: string
}

type StreamedAgentTextSink = (write: {
  sessionId: string
  streamId: string
  eventId: string
  eventIds: string[]
  promptMessageId?: string
  content: string
}) => void

// How long a delta waits for company. Short enough that the text still reads as streaming, long enough to
// collapse the burst of deltas a single reply produces into a handful of updates.
export const STREAM_TEXT_FLUSH_MS = 50

let sink: StreamedAgentTextSink | undefined

// The event bridge registers the real writer at module initialisation.
export const setStreamedAgentTextSink = (next: StreamedAgentTextSink): void => {
  sink = next
}

// The ids of the events whose text is still buffered, per stream. They travel with the text: `eventId` is
// what makes a replayed stream idempotent, so dropping the intermediate ids would let a replay append
// their text a second time.
const bufferedChunkIds = new Map<
  string,
  { sessionId: string; streamId: string; promptMessageId?: string; eventIds: string[] }
>()

const batcher = createStreamingTextBatcher({
  flushMs: STREAM_TEXT_FLUSH_MS,
  onFlush: (streamId, text) => {
    const batch = bufferedChunkIds.get(streamId)
    if (!batch) return
    bufferedChunkIds.delete(streamId)
    sink?.({
      sessionId: batch.sessionId,
      streamId: batch.streamId,
      eventId: batch.eventIds[0]!,
      eventIds: batch.eventIds,
      ...(batch.promptMessageId ? { promptMessageId: batch.promptMessageId } : {}),
      content: text
    })
  }
})

export const appendStreamedAgentTextChunk = (chunk: StreamedAgentTextChunk): void => {
  const buffered = bufferedChunkIds.get(chunk.streamId)
  if (buffered) {
    buffered.eventIds.push(chunk.eventId)
    if (!buffered.promptMessageId && chunk.promptMessageId) {
      buffered.promptMessageId = chunk.promptMessageId
    }
  } else {
    bufferedChunkIds.set(chunk.streamId, {
      sessionId: chunk.sessionId,
      streamId: chunk.streamId,
      ...(chunk.promptMessageId ? { promptMessageId: chunk.promptMessageId } : {}),
      eventIds: [chunk.eventId]
    })
  }
  batcher.append(chunk.streamId, chunk.content)
}

// Writes whatever is buffered for this stream right away (a tool row, a status change or the end of the
// turn must never land above text that arrived before it).
export const settleStreamedAgentText = (streamId: string): void => {
  batcher.settle(streamId)
}

export const settleAllStreamedAgentText = (): void => {
  batcher.settleAll()
}

// Drops the buffer for a stream without writing it. Used when the transcript cuts the message away: the
// text was never shown, so writing it now would resurrect a message the user just edited off the branch.
export const discardStreamedAgentText = (streamId: string): void => {
  bufferedChunkIds.delete(streamId)
  batcher.discard(streamId)
}
