import { describe, expect, it, vi } from 'vitest'

import { createWebCallerContext } from '../caller-context'
import { invokeWithIpcRejectionDiagnostics } from './ipc-rejection'
import { sharedLoopHeldWindows } from './loop-held-windows'

// The marker only earns its place if the *default* path can produce it: an injected seam would prove the log
// line carries a field it is handed, while production kept calling every span "loop free". So this case drives
// the shared registry far enough to drop windows — which is what a thrashing machine does on its own — and then
// reads the slow-handler line with nothing passed in.
//
// It lives in its own file because the registry is process-wide: the other wiring cases measure spans near
// 1 000-3 000 ms, and this one fills the ring to make the dropped boundary real.
describe('dropped stall windows, through the default wiring', () => {
  it('says a span predates the retained windows instead of calling it loop free', async () => {
    // The ring keeps 64 windows and takes stalls of 200 ms or more. Sixty-five of them drops exactly the first.
    for (let index = 0; index < 65; index += 1) {
      const start = 1_000_000 + index * 400
      sharedLoopHeldWindows.record(start, start + 200)
    }
    const droppedThrough = 1_000_200
    // Asserted, not assumed: if the ring's capacity or floor changes, this case must fail here rather than pass
    // for a reason that has nothing to do with the marker.
    expect(sharedLoopHeldWindows.coverageStartMs()).toBe(droppedThrough)

    const warn = vi.fn()
    const now = vi
      .fn()
      .mockReturnValueOnce(droppedThrough - 500)
      .mockReturnValueOnce(droppedThrough + 1_500)
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

    const payload = warn.mock.calls[0]?.[1] as Record<string, unknown> | undefined
    expect(warn).toHaveBeenCalledWith(
      'ipc handler was slow',
      expect.objectContaining({ durationMs: 2_000 })
    )
    // The named answer, and no split: "not measured" may not masquerade as "held 0 ms".
    expect(payload?.heldUnmeasured).toBe('windows-dropped')
    expect(payload ?? {}).not.toHaveProperty('heldMs')
  })
})
