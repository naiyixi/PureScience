import { describe, expect, it } from 'vitest'

import { createStreamingTextBatcher } from './streaming-text-batcher'

type BatcherHarness = {
  batcher: ReturnType<typeof createStreamingTextBatcher>
  flushes: { messageId: string; text: string }[]
  scheduled: { callback: () => void; delayMs: number }[]
}

const createHarness = (flushMs = 50): BatcherHarness => {
  const flushes: { messageId: string; text: string }[] = []
  const scheduled: { callback: () => void; delayMs: number }[] = []
  const batcher = createStreamingTextBatcher({
    flushMs,
    onFlush: (messageId, text) => flushes.push({ messageId, text }),
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs })
      return scheduled.length
    },
    cancel: () => undefined
  })
  return { batcher, flushes, scheduled }
}

describe('streaming text batcher', () => {
  it('keeps each message in its own window', () => {
    const { batcher, flushes, scheduled } = createHarness()

    batcher.append('message-1', 'first ')
    batcher.append('message-2', 'second ')
    batcher.append('message-1', 'message')

    // One window per message, not one shared window for the transcript.
    expect(scheduled).toHaveLength(2)
    scheduled.forEach((entry) => entry.callback())
    expect(flushes).toEqual([
      { messageId: 'message-1', text: 'first message' },
      { messageId: 'message-2', text: 'second ' }
    ])
  })

  it('settles a message so its final text lands before the status changes', () => {
    const { batcher, flushes } = createHarness()

    batcher.append('message-1', 'partial')
    batcher.settle('message-1')

    expect(flushes).toEqual([{ messageId: 'message-1', text: 'partial' }])
    expect(batcher.pendingText('message-1')).toBe('')
  })

  it('starts a new window for a message after it was settled', () => {
    const { batcher, flushes, scheduled } = createHarness()

    batcher.append('message-1', 'a')
    batcher.settle('message-1')
    batcher.append('message-1', 'b')
    scheduled.at(-1)!.callback()

    expect(flushes).toEqual([
      { messageId: 'message-1', text: 'a' },
      { messageId: 'message-1', text: 'b' }
    ])
  })

  it('settles every in-flight message and forgets them', () => {
    const { batcher, flushes } = createHarness()

    batcher.append('message-1', 'one')
    batcher.append('message-2', 'two')
    batcher.settleAll()

    expect(flushes).toEqual([
      { messageId: 'message-1', text: 'one' },
      { messageId: 'message-2', text: 'two' }
    ])
    expect(batcher.pendingText('message-1')).toBe('')
    expect(batcher.pendingText('message-2')).toBe('')
  })

  it('drops a discarded message without writing it', () => {
    const { batcher, flushes } = createHarness()

    batcher.append('message-1', 'never mind')
    batcher.discard('message-1')
    batcher.settle('message-1')

    expect(flushes).toEqual([])
  })

  it('writes nothing for a message that never streamed', () => {
    const { batcher, flushes } = createHarness()

    batcher.settle('message-unknown')

    expect(flushes).toEqual([])
  })
})
