// Owns one text coalescer per streaming message so the session store's write path can hand deltas over
// without thinking about lifetimes.
//
// Why this exists: `streaming-text-coalescer.ts` guarantees the per-message semantics (nothing lost, one
// flush per window, explicit flush on demand). This module adds the bookkeeping around it — which message
// is currently streaming, when a message's batch has to land for good, and how to drop everything when the
// window moves to another session. Keeping that bookkeeping out of the store keeps the store change small
// and this part unit-testable.

import { createTextCoalescer, type TextCoalescer } from './streaming-text-coalescer'

export type StreamingTextBatcherOptions = {
  flushMs: number
  // Receives the accumulated text for one message. Called once per window, plus once per final flush.
  onFlush: (messageId: string, text: string) => void
  schedule?: (callback: () => void, delayMs: number) => number
  cancel?: (handle: number) => void
}

export type StreamingTextBatcher = {
  // Buffers a delta for a message. Text keeps arriving in order; nothing is written until the window ends.
  append: (messageId: string, delta: string) => void
  // Lands whatever is buffered for a message immediately — used when its turn completes or is cancelled,
  // so the final text is on screen before the status flips.
  settle: (messageId: string) => void
  // Lands everything (e.g. before switching sessions) and forgets the batches.
  settleAll: () => void
  // Forgets a message's batch without writing it — for a message that was discarded or replaced.
  discard: (messageId: string) => void
  pendingText: (messageId: string) => string
}

export const createStreamingTextBatcher = ({
  flushMs,
  onFlush,
  schedule,
  cancel
}: StreamingTextBatcherOptions): StreamingTextBatcher => {
  const coalescers = new Map<string, TextCoalescer>()

  const forMessage = (messageId: string): TextCoalescer => {
    const existing = coalescers.get(messageId)
    if (existing) return existing
    const created = createTextCoalescer({
      flushMs,
      onFlush: (text) => onFlush(messageId, text),
      ...(schedule ? { schedule } : {}),
      ...(cancel ? { cancel } : {})
    })
    coalescers.set(messageId, created)
    return created
  }

  return {
    append: (messageId, delta) => forMessage(messageId).push(delta),
    settle: (messageId) => {
      const coalescer = coalescers.get(messageId)
      if (!coalescer) return
      coalescer.flushNow()
      coalescers.delete(messageId)
    },
    settleAll: () => {
      for (const [messageId, coalescer] of [...coalescers]) {
        coalescer.flushNow()
        coalescers.delete(messageId)
      }
    },
    discard: (messageId) => {
      coalescers.delete(messageId)
    },
    pendingText: (messageId) => coalescers.get(messageId)?.pending() ?? ''
  }
}
