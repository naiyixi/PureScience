import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWebCallerContext } from '../caller-context'
import { startEventLoopStallWatchdog } from './event-loop-stall-watchdog'
import type { HostStallSampler } from './host-stall-sampler'
import { invokeWithIpcRejectionDiagnostics } from './ipc-rejection'
import { heldSplitFields, sharedLoopHeldWindows } from './loop-held-windows'

// The producer (the stall watchdog) and the consumer (the slow-handler line) meet through the shared registry,
// not through a composition-root seam. That default path is what needs a case: an injected instance on both
// sides would prove only that the two halves work when someone hands one to the other — and the failure mode
// this guards is precisely "both halves fine, nothing connected", where every handler keeps reporting its full
// wall duration as if it were our work.
//
// It lives in its own file because the registry is process-wide: sharing a file with the watchdog's other
// cases would let their windows (driven on the same fake clock) answer for this one.
const quietHostSampler = (): HostStallSampler => ({
  read: async () => ({ status: 'no-in-stall-samples' }),
  snapshot: async () => undefined,
  stop: () => undefined
})

const clock = (): {
  now: () => number
  cpuUsage: () => NodeJS.CpuUsage
  advance: (ms: number) => void
} => {
  let current = 1_000
  return {
    now: (): number => current,
    cpuUsage: (): NodeJS.CpuUsage => ({ user: 0, system: 0 }),
    advance: (ms: number): void => {
      current += ms
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('stall watchdog to slow-handler line (default wiring)', () => {
  it('lets the slow-handler line read the held part of its duration with nothing passed between them', async () => {
    vi.useFakeTimers()
    const time = clock()
    const watchdog = startEventLoopStallWatchdog({
      log: { warn: (): void => undefined },
      tickMs: 100,
      thresholdMs: 500,
      now: time.now,
      cpuUsage: time.cpuUsage,
      machine: () => ({}),
      createPresampler: () => undefined,
      createHostSampler: quietHostSampler
    })

    // On time, then 2 s late: the remembered part is the 1.9 s past the schedule.
    time.advance(100)
    vi.advanceTimersByTime(100)
    time.advance(2_000)
    vi.advanceTimersByTime(100)
    const endOfWindow = time.now()
    watchdog.stop()

    expect(sharedLoopHeldWindows.heldMsWithin(endOfWindow - 1_900, endOfWindow)).toBe(1_900)

    const warn = vi.fn()
    const now = vi.fn().mockReturnValueOnce(1_300).mockReturnValueOnce(3_000)
    await invokeWithIpcRejectionDiagnostics({
      channel: 'runtime:get-enablement',
      callerContext: createWebCallerContext('client-1', {
        location: 'local',
        principalKind: 'human',
        actionOrigin: 'human'
      }),
      invoke: async () => 'ok',
      log: { warn },
      now
    })
    // 1 700 ms of wall time, all of it inside the blocked window: the line says so instead of reporting a
    // 1.7 s handler that did nothing for 1.7 s.
    expect(warn).toHaveBeenCalledWith(
      'ipc handler was slow',
      expect.objectContaining({ durationMs: 1_700, heldMs: 1_700, ownMs: 0 })
    )
  })

  // The second consumer family: timers that measure with `Date.now()`. They reach the same ring through the
  // wall-clock bridge, and the case that matters is that the bridge's *default* source is the shared
  // registry — with an injected instance this would pass while production printed nothing.
  it('lets a wall-clock timer read the same ring without being handed a source', () => {
    sharedLoopHeldWindows.record(49_000, 50_500)

    // A 2 000 ms window ending at wall 3 000, with the paired reading taken at that instant.
    const fields = heldSplitFields(1_000, 2_000, { pair: { wallMs: 3_000, perfMs: 50_000 } })
    // [48 000, 50 000] meets the recorded [49 000, 50 500] for exactly 1 000 ms.
    expect(fields).toEqual({ heldMs: 1_000, ownMs: 1_000 })
    // And a window that missed the ring says nothing at all, rather than 0.
    expect(heldSplitFields(1_000, 2_000, { pair: { wallMs: 3_000, perfMs: 80_000 } })).toEqual({})
  })
})
