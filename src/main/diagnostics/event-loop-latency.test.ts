import { describe, expect, it } from 'vitest'

import { readEventLoopLatency, resetEventLoopLatency } from './event-loop-latency'

describe('event loop latency', () => {
  it('reports a numeric window and keeps reporting after a reset', async () => {
    // The point of this module is to tell a blocked event loop from an awaiting call, so it has to survive a
    // reset (each measured operation resets it) and never report NaN — an empty histogram yields NaN for the
    // percentiles, which would silently poison the diagnostic that carries it.
    resetEventLoopLatency()
    await new Promise((resolve) => setTimeout(resolve, 60))

    const window = readEventLoopLatency()
    expect(Number.isFinite(window.maxMs)).toBe(true)
    expect(Number.isFinite(window.meanMs)).toBe(true)
    expect(Number.isFinite(window.p99Ms)).toBe(true)
    expect(window.maxMs).toBeGreaterThanOrEqual(0)
    expect(window.meanMs).toBeLessThanOrEqual(window.maxMs)

    resetEventLoopLatency()
    const afterReset = readEventLoopLatency()
    expect(Number.isFinite(afterReset.maxMs)).toBe(true)
    expect(afterReset.maxMs).toBeLessThanOrEqual(window.maxMs + 200)
  })
})
