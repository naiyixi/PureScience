import { describe, expect, it, vi } from 'vitest'

import { waitForInitialConnectorRefresh, wireConnectorReload } from './connector-reload'

/**
 * How long a coordination wait may take.
 *
 * Every `vi.waitFor` in this file is a *coordination* wait: it waits for the side effect of work that
 * is already in flight (a spy being called, a process dying, a worker reporting that it started, a
 * rendered node reaching its final text), never for something that may never happen. The only thing
 * the window has to cover is how long a loaded machine takes to schedule that continuation -- so the
 * default 1s is a quiet-machine budget, not a correctness budget. Measured on this repository: under
 * load a coordinated wait took up to 704ms (34 samples, p90 = 361ms), and a site elsewhere in the
 * suite failed at ~1.1s under load average ~70 while passing on a quiet machine.
 *
 * 30s matches the window this repository already uses for load-sensitive waits, and it stays well below
 * vitest's 60s per-test timeout, so an assertion that is genuinely stuck still fails as a failure
 * instead of hanging.
 */
const COORDINATION_WINDOW_MS = 30_000

// Exercises the settle rule used by SettingsWorkflows (not a reimplementation): the skills
// reload must run on BOTH settle paths, so if the source ever regressed `.finally` to `.then` these
// tests would fail.
describe('wireConnectorReload', () => {
  it('reloads skills after a successful connector doc re-sync', async () => {
    const reload = vi.fn()
    const refresh = vi.fn().mockResolvedValue(undefined)

    await wireConnectorReload(refresh, reload)

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('still reloads skills when the connector doc re-sync rejects', async () => {
    const reload = vi.fn()
    const refresh = vi.fn().mockRejectedValue(new Error('sync failed'))

    // The composed promise rejects (the caller `void`s it), but the reload in .finally must have run —
    // the behavior a `.then` chain would drop, which is why the source uses `.finally`.
    await expect(wireConnectorReload(refresh, reload)).rejects.toThrow('sync failed')
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('waitForInitialConnectorRefresh', () => {
  it('does not reload when the initial connector docs are ready within the barrier', async () => {
    let finishRefresh: (() => void) | undefined
    const refresh = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    let settled = false
    const reload = vi.fn()

    const barrier = waitForInitialConnectorRefresh(refresh, { onLateSettled: reload }).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    finishRefresh?.()

    await barrier
    expect(settled).toBe(true)
    expect(reload).not.toHaveBeenCalled()
  })

  it('settles after a bounded wait when connector discovery hangs', async () => {
    vi.useFakeTimers()
    try {
      const refresh = new Promise<void>(() => undefined)
      let settled = false

      const barrier = waitForInitialConnectorRefresh(refresh, { timeoutMs: 100 }).then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(100)

      await barrier
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['resolves', false],
    ['rejects', true]
  ] as const)('reloads once when a timed-out refresh later %s', async (_label, rejects) => {
    vi.useFakeTimers()
    try {
      let finishRefresh: (() => void) | undefined
      let failRefresh: ((error: Error) => void) | undefined
      const refresh = new Promise<void>((resolve, reject) => {
        finishRefresh = resolve
        failRefresh = reject
      })
      const reload = vi.fn()
      const barrier = waitForInitialConnectorRefresh(refresh, {
        timeoutMs: 100,
        onLateSettled: reload
      })

      await vi.advanceTimersByTimeAsync(100)
      await barrier
      expect(reload).not.toHaveBeenCalled()

      if (rejects) failRefresh?.(new Error('sync failed'))
      else finishRefresh?.()
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce(), {
        timeout: COORDINATION_WINDOW_MS
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
