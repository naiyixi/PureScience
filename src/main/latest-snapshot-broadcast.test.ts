import { describe, expect, it, vi } from 'vitest'

import { createLatestSnapshotBroadcast } from './latest-snapshot-broadcast'

const createHarness = (
  windowMs = 150
): {
  broadcast: (snapshot: string) => void
  sent: string[]
  advance: (ms: number) => void
} => {
  vi.useFakeTimers()
  const sent: string[] = []
  const broadcast = createLatestSnapshotBroadcast<string>((snapshot) => sent.push(snapshot), {
    windowMs
  })
  return {
    broadcast,
    sent,
    advance: (ms: number) => {
      vi.advanceTimersByTime(ms)
    }
  }
}

describe('latest snapshot broadcast', () => {
  it('sends an isolated change immediately', () => {
    const harness = createHarness()
    try {
      harness.broadcast('first')
      expect(harness.sent).toEqual(['first'])

      // Past the window, the next change is isolated again and keeps its prompt send.
      harness.advance(200)
      harness.broadcast('second')
      expect(harness.sent).toEqual(['first', 'second'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('collapses a burst inside one window to its newest snapshot', () => {
    const harness = createHarness()
    try {
      harness.broadcast('chunk-0')
      expect(harness.sent).toEqual(['chunk-0'])

      // 39 more changes inside the window: the renderer only needs the newest state.
      for (let index = 1; index < 40; index += 1) harness.broadcast(`chunk-${index}`)
      expect(harness.sent).toEqual(['chunk-0'])

      harness.advance(150)
      expect(harness.sent).toEqual(['chunk-0', 'chunk-39'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps at most one trailing send per window while changes keep arriving', () => {
    const harness = createHarness(100)
    try {
      harness.broadcast('a')
      for (let elapsed = 0; elapsed < 1000; elapsed += 10) {
        harness.advance(10)
        harness.broadcast(`t${elapsed}`)
      }
      // Nothing sends after the last change until its window closes, and then the newest state goes out.
      harness.advance(100)
      // One leading send plus one per elapsed window: a continuous stream stays bounded, and every send is
      // the newest state at that moment — never a stale one.
      expect(harness.sent.length).toBeLessThanOrEqual(12)
      expect(harness.sent[0]).toBe('a')
      expect(harness.sent.at(-1)).toBe('t990')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not send a stale snapshot after the newest one already went out', () => {
    const harness = createHarness(100)
    try {
      harness.broadcast('a')
      harness.broadcast('b')
      harness.broadcast('c')
      harness.advance(100)
      expect(harness.sent).toEqual(['a', 'c'])
    } finally {
      vi.useRealTimers()
    }
  })
})
