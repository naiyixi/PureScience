import { describe, expect, it, vi } from 'vitest'

import { createDeferredSnapshotBroadcast } from './latest-snapshot-broadcast'

// The broadcast is driven the way the coordinator drives it: a request carries the build, and only the
// newest request inside a window is built and delivered.
const createHarness = (
  windowMs = 150
): {
  request: (build: () => string) => void
  sent: string[]
  builds: () => number
  advance: (ms: number) => void
} => {
  vi.useFakeTimers()
  const sent: string[] = []
  let builds = 0
  const request = createDeferredSnapshotBroadcast<string>((snapshot) => sent.push(snapshot), {
    windowMs
  })
  return {
    request: (build: () => string) => {
      request(() => {
        builds += 1
        return build()
      })
    },
    sent,
    builds: () => builds,
    advance: (ms: number) => {
      vi.advanceTimersByTime(ms)
    }
  }
}

describe('deferred snapshot broadcast', () => {
  it('sends an isolated change immediately', () => {
    const harness = createHarness()
    try {
      harness.request(() => 'first')
      expect(harness.sent).toEqual(['first'])
      // The isolated change was delivered at once, so its build happened at once.
      expect(harness.builds()).toBe(1)

      // Past the window, the next change is isolated again and keeps its prompt send.
      harness.advance(200)
      harness.request(() => 'second')
      expect(harness.sent).toEqual(['first', 'second'])
      expect(harness.builds()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('collapses a burst inside one window to its newest snapshot', () => {
    const harness = createHarness()
    try {
      harness.request(() => 'chunk-0')
      expect(harness.sent).toEqual(['chunk-0'])

      // 39 more changes inside the window: the renderer only needs the newest state.
      for (let index = 1; index < 40; index += 1) harness.request(() => `chunk-${index}`)
      expect(harness.sent).toEqual(['chunk-0'])
      // None of the 39 collapsed requests was built.
      expect(harness.builds()).toBe(1)

      harness.advance(150)
      expect(harness.sent).toEqual(['chunk-0', 'chunk-39'])
      // 40 requests cost 2 builds; building per request would have cost 40.
      expect(harness.builds()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps at most one trailing send per window while changes keep arriving', () => {
    const harness = createHarness(100)
    try {
      harness.request(() => 'a')
      for (let elapsed = 0; elapsed < 1000; elapsed += 10) {
        harness.advance(10)
        harness.request(() => `t${elapsed}`)
      }
      // Nothing sends after the last change until its window closes, and then the newest state goes out.
      harness.advance(100)
      // One leading send plus one per elapsed window: a continuous stream stays bounded, and every send is
      // the newest state at that moment — never a stale one.
      expect(harness.sent.length).toBeLessThanOrEqual(12)
      expect(harness.sent[0]).toBe('a')
      expect(harness.sent.at(-1)).toBe('t990')
      // A bounded number of sends is also a bounded number of builds.
      expect(harness.builds()).toBe(harness.sent.length)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not send a stale snapshot after the newest one already went out', () => {
    const harness = createHarness(100)
    try {
      harness.request(() => 'a')
      harness.request(() => 'b')
      harness.request(() => 'c')
      harness.advance(100)
      expect(harness.sent).toEqual(['a', 'c'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('builds at the delivery moment, so a builder reading live state sees the newest state', () => {
    const harness = createHarness(100)
    try {
      let authoritative = 'a'
      harness.request(() => authoritative)
      authoritative = 'b'
      harness.request(() => authoritative)
      // Nothing was built for the collapsed request yet.
      expect(harness.builds()).toBe(1)
      authoritative = 'c'
      harness.advance(100)
      expect(harness.sent).toEqual(['a', 'c'])
      expect(harness.builds()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never builds a request that a newer one replaced before the window closed', () => {
    const harness = createHarness(100)
    try {
      const built: string[] = []
      harness.request(() => {
        built.push('a')
        return 'a'
      })
      harness.request(() => {
        built.push('b')
        return 'b'
      })
      harness.request(() => {
        built.push('c')
        return 'c'
      })
      harness.advance(100)
      // `b` was replaced inside the window and is never built, so its builder never runs.
      expect(built).toEqual(['a', 'c'])
    } finally {
      vi.useRealTimers()
    }
  })
})
