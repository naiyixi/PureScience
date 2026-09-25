import { afterEach, describe, expect, it, vi } from 'vitest'

import { createStreamingTextBatcher } from './streaming-text-batcher'
import { STREAM_TEXT_FLUSH_MS } from './streamed-agent-text'

// A coalescing window that only ever lands under a real clock would make every test that drives streamed
// text wait on wall time. This pins the contract: the window is driven by whatever timer the environment
// installs, so a fake clock can advance it.
// Created at module load, exactly like the app's singleton: this is the shape that has to keep working
// when the clock is installed later.
const moduleScopedFlushes: string[] = []
const moduleScopedBatcher = createStreamingTextBatcher({
  flushMs: STREAM_TEXT_FLUSH_MS,
  onFlush: (_messageId, text) => {
    moduleScopedFlushes.push(text)
  }
})

describe('streaming text batcher under a fake clock', () => {
  it('flushes a batcher created before the fake clock was installed', () => {
    vi.useFakeTimers()
    moduleScopedFlushes.length = 0

    moduleScopedBatcher.append('stream-1', 'Hel')
    vi.advanceTimersByTime(STREAM_TEXT_FLUSH_MS)

    expect(moduleScopedFlushes).toEqual(['Hel'])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes when the fake clock advances by the window', () => {
    vi.useFakeTimers()
    const flushes: string[] = []
    const batcher = createStreamingTextBatcher({
      flushMs: STREAM_TEXT_FLUSH_MS,
      onFlush: (_messageId, text) => {
        flushes.push(text)
      }
    })

    batcher.append('stream-1', 'Hel')
    expect(flushes).toEqual([])

    vi.advanceTimersByTime(STREAM_TEXT_FLUSH_MS)

    expect(flushes).toEqual(['Hel'])

    batcher.append('stream-1', 'lo')
    vi.advanceTimersByTime(STREAM_TEXT_FLUSH_MS)

    expect(flushes).toEqual(['Hel', 'lo'])
  })

  it('flushes the next slice when every append is preceded by a settle, the way the event bridge drives it', () => {
    vi.useFakeTimers()
    const flushes: string[] = []
    const batcher = createStreamingTextBatcher({
      flushMs: STREAM_TEXT_FLUSH_MS,
      onFlush: (_messageId, text) => {
        flushes.push(text)
      }
    })

    batcher.settle('stream-1')
    batcher.append('stream-1', 'Hel')
    vi.advanceTimersByTime(STREAM_TEXT_FLUSH_MS)
    expect(flushes).toEqual(['Hel'])

    batcher.settle('stream-1')
    batcher.append('stream-1', 'lo')
    vi.advanceTimersByTime(STREAM_TEXT_FLUSH_MS)

    expect(flushes).toEqual(['Hel', 'lo'])
  })
})
