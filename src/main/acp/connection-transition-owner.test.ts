import { describe, expect, it, vi } from 'vitest'

import { AcpConnectionTransitionOwner } from './connection-transition-owner'

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

describe('AcpConnectionTransitionOwner', () => {
  it('coalesces blocked provider and skills intents into one planned reconnect', async () => {
    let reconnectBlocked = true
    const disconnect = vi.fn(async () => undefined)
    const publishIdle = vi.fn()
    const owner = new AcpConnectionTransitionOwner({
      blockers: () => ({ reconnect: reconnectBlocked, retirement: reconnectBlocked }),
      connectionGeneration: () => 1,
      disconnect,
      onRetired: vi.fn(),
      publishIdle,
      recoverFailedDeferredDisconnect: vi.fn(),
      reportFailure: vi.fn()
    })

    await owner.requestProviderReconnect()
    owner.requestSkillsReload()

    expect(owner.barrier).toBeDefined()
    expect(disconnect).not.toHaveBeenCalled()

    reconnectBlocked = false
    owner.activityChanged()
    await vi.waitFor(() => expect(owner.barrier).toBeUndefined(), {
      timeout: COORDINATION_WINDOW_MS
    })

    expect(disconnect).toHaveBeenCalledOnce()
    expect(publishIdle).toHaveBeenCalledOnce()
    expect(owner.providerReconnectPending).toBe(false)
  })

  it('lets retirement win over queued reconnect intents and retires once', async () => {
    let blocked = true
    const disconnect = vi.fn(async () => undefined)
    const onRetired = vi.fn()
    const publishIdle = vi.fn()
    const owner = new AcpConnectionTransitionOwner({
      blockers: () => ({ reconnect: blocked, retirement: blocked }),
      connectionGeneration: () => 1,
      disconnect,
      onRetired,
      publishIdle,
      recoverFailedDeferredDisconnect: vi.fn(),
      reportFailure: vi.fn()
    })

    await owner.requestProviderReconnect()
    owner.requestSkillsReload()
    await owner.requestRetirement()
    await owner.requestRetirement()
    expect(disconnect).not.toHaveBeenCalled()

    blocked = false
    owner.activityChanged()
    await vi.waitFor(() => expect(onRetired).toHaveBeenCalledOnce(), {
      timeout: COORDINATION_WINDOW_MS
    })

    expect(disconnect).toHaveBeenCalledOnce()
    expect(publishIdle).not.toHaveBeenCalled()
    expect(owner.barrier).toBeUndefined()
    await owner.requestRetirement()
    expect(onRetired).toHaveBeenCalledOnce()
  })

  it('does not let stale teardown release a newer reconnect barrier', async () => {
    let blocked = true
    let releaseTeardown!: () => void
    const teardownGate = new Promise<void>((resolve) => {
      releaseTeardown = resolve
    })
    const disconnect = vi.fn(async () => undefined)
    const owner = new AcpConnectionTransitionOwner({
      blockers: () => ({ reconnect: blocked, retirement: blocked }),
      connectionGeneration: () => 1,
      disconnect,
      onRetired: vi.fn(),
      publishIdle: vi.fn(),
      recoverFailedDeferredDisconnect: vi.fn(),
      reportFailure: vi.fn()
    })

    await owner.requestProviderReconnect()
    const staleTeardown = owner.settleTeardown(() => teardownGate)
    await owner.requestProviderReconnect()

    releaseTeardown()
    await staleTeardown
    expect(owner.barrier).toBeDefined()

    blocked = false
    owner.activityChanged()
    await vi.waitFor(() => expect(owner.barrier).toBeUndefined(), {
      timeout: COORDINATION_WINDOW_MS
    })
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('recovers a failed deferred disconnect and always releases its barrier', async () => {
    let blocked = true
    const disconnectFailure = new Error('disconnect failed')
    const recoverFailedDeferredDisconnect = vi.fn(async () => undefined)
    const reportFailure = vi.fn()
    const owner = new AcpConnectionTransitionOwner({
      blockers: () => ({ reconnect: blocked, retirement: blocked }),
      connectionGeneration: () => 1,
      disconnect: vi.fn(async () => {
        throw disconnectFailure
      }),
      onRetired: vi.fn(),
      publishIdle: vi.fn(),
      recoverFailedDeferredDisconnect,
      reportFailure
    })

    await owner.requestProviderReconnect()
    blocked = false
    owner.activityChanged()
    await vi.waitFor(() => expect(owner.barrier).toBeUndefined(), {
      timeout: COORDINATION_WINDOW_MS
    })

    expect(recoverFailedDeferredDisconnect).toHaveBeenCalledOnce()
    expect(recoverFailedDeferredDisconnect).toHaveBeenCalledWith(disconnectFailure)
    expect(reportFailure).toHaveBeenCalledWith(
      'deferred reconnect disconnect failed',
      disconnectFailure
    )
  })
})
