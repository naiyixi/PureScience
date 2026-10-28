import { describe, expect, it, vi } from 'vitest'

import { createWebCallerContext } from '../caller-context'
import { invokeWithIpcRejectionDiagnostics } from './ipc-rejection'

// Two CPU samples per call, injected so the attribution fields are deterministic: the claim under test is
// which window the share is computed over, not how busy this machine was while the suite ran.
const cpuPair = (cpuMs: number): (() => { user: number; system: number }) => {
  let calls = 0
  return () => (calls++ === 0 ? { user: 0, system: 0 } : { user: cpuMs * 1000, system: 0 })
}

describe('invokeWithIpcRejectionDiagnostics', () => {
  it('reports a slow successful handler with its duration, and says nothing about a fast one', async () => {
    // This adapter is the only place an Electron IPC cost can be seen in main: the renderer's session and
    // file calls never reach the application-command router. It still carries no arguments or results.
    const warn = vi.fn()
    const callerContext = createWebCallerContext('client-1', {
      location: 'local',
      principalKind: 'human',
      actionOrigin: 'human'
    })

    const fastNow = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_005)
    await invokeWithIpcRejectionDiagnostics({
      channel: 'sessions:list-catalog',
      callerContext,
      invoke: async () => 'ok',
      log: { warn },
      now: fastNow
    })
    expect(warn).not.toHaveBeenCalled()

    const slowNow = vi.fn().mockReturnValueOnce(2_000).mockReturnValueOnce(2_180)
    await invokeWithIpcRejectionDiagnostics({
      channel: 'sessions:read-document',
      callerContext,
      invoke: async () => 'document',
      log: { warn },
      now: slowNow,
      cpuUsage: cpuPair(90)
    })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('ipc handler was slow', {
      channel: 'sessions:read-document',
      surface: 'web',
      location: 'local',
      durationMs: 180,
      // Half the window spent on the CPU: neither "our work" nor "we were suspended", so no verdict is
      // printed — the band stays unresolved on purpose (see `cpu-attribution`).
      cpuMs: 90,
      cpuShare: 0.5,
      attribution: 'inconclusive'
    })

    // A synchronous handler is measured the same way.
    warn.mockClear()
    const syncNow = vi.fn().mockReturnValueOnce(3_000).mockReturnValueOnce(3_400)
    const syncResult = invokeWithIpcRejectionDiagnostics({
      channel: 'preview:load',
      callerContext,
      invoke: () => 'sync-value',
      log: { warn },
      now: syncNow
    })
    expect(syncResult).toBe('sync-value')
    expect(warn).toHaveBeenCalledWith(
      'ipc handler was slow',
      expect.objectContaining({ durationMs: 400 })
    )
  })

  it('hands the same measurement to the bundle sink, and nothing at all for a fast call', async () => {
    // The line answers whoever is reading that launch; the bundle answers the same question hours later, from
    // a .tar.gz. Both must describe one measurement, or a maintainer finds two answers for the same call.
    const warn = vi.fn()
    const sink = vi.fn()
    const callerContext = createWebCallerContext('client-2', {
      location: 'remote',
      principalKind: 'human',
      actionOrigin: 'human'
    })

    const fastNow = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_010)
    await invokeWithIpcRejectionDiagnostics({
      channel: 'sessions:list-catalog',
      callerContext,
      invoke: async () => 'ok',
      log: { warn },
      now: fastNow,
      slowOperationSink: sink
    })
    expect(sink).not.toHaveBeenCalled()

    const slowNow = vi.fn().mockReturnValueOnce(2_000).mockReturnValueOnce(2_500)
    await invokeWithIpcRejectionDiagnostics({
      channel: 'sessions:read-document',
      callerContext,
      invoke: async () => 'document',
      log: { warn },
      now: slowNow,
      cpuUsage: cpuPair(250),
      heldMs: () => 400,
      slowOperationSink: sink
    })
    expect(sink).toHaveBeenCalledOnce()
    expect(sink).toHaveBeenCalledWith({
      kind: 'ipc',
      name: 'sessions:read-document',
      surface: 'web',
      location: 'remote',
      durationMs: 500,
      cpuMs: 250,
      cpuShare: 0.5,
      attribution: 'inconclusive',
      heldMs: 400,
      ownMs: 100
    })
    expect(warn).toHaveBeenCalledWith(
      'ipc handler was slow',
      expect.objectContaining({ durationMs: 500, heldMs: 400, ownMs: 100 })
    )
  })

  it('does not let a sink that throws replace the handler result', async () => {
    const callerContext = createWebCallerContext('client-3', { location: 'local' })
    const sink = vi.fn(() => {
      throw new Error('sink exploded')
    })
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(900)
    const result = await invokeWithIpcRejectionDiagnostics({
      channel: 'sessions:read-document',
      callerContext,
      invoke: async () => 'document',
      log: { warn: vi.fn() },
      now,
      slowOperationSink: sink
    })
    expect(result).toBe('document')
    expect(sink).toHaveBeenCalledOnce()
  })

  it('splits a slow handler into the part we ran and the part the process was not running', async () => {
    // The settings-mount burst: five channels starting together, all finishing within seconds of each other,
    // each 93-100 % inside one 15-23 s window where the loop never ran. The wall duration alone read as five
    // slow handlers; the split is what makes the line say which part was ours.
    const warn = vi.fn()
    const callerContext = createWebCallerContext('client-1', {
      location: 'local',
      principalKind: 'human',
      actionOrigin: 'human'
    })
    const now = vi.fn().mockReturnValueOnce(10_000).mockReturnValueOnce(31_700)
    await invokeWithIpcRejectionDiagnostics({
      channel: 'runtime:get-enablement',
      callerContext,
      invoke: async () => 'ok',
      log: { warn },
      now,
      heldMs: () => 20_300,
      cpuUsage: cpuPair(300)
    })
    expect(warn).toHaveBeenCalledWith('ipc handler was slow', {
      channel: 'runtime:get-enablement',
      surface: 'web',
      location: 'local',
      durationMs: 21_700,
      // 0.014 of the window on the CPU: the process was not running, and the line now says so twice — once
      // from the held registry and once from what the process itself consumed.
      cpuMs: 300,
      cpuShare: 0.014,
      attribution: 'no-cpu-in-process',
      heldMs: 20_300,
      ownMs: 1_400
    })

    // A held reading larger than the duration cannot make ownMs negative.
    warn.mockClear()
    const short = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(2_000)
    await invokeWithIpcRejectionDiagnostics({
      channel: 'runtime:survey',
      callerContext,
      invoke: async () => 'ok',
      log: { warn },
      now: short,
      heldMs: () => 9_999
    })
    expect(warn).toHaveBeenCalledWith(
      'ipc handler was slow',
      expect.objectContaining({ durationMs: 2_000, heldMs: 2_000, ownMs: 0 })
    )

    // No held time: the line is exactly what it was before the split existed, so an ordinary slow handler is
    // not labelled as somebody else's problem.
    warn.mockClear()
    const plain = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(600)
    await invokeWithIpcRejectionDiagnostics({
      channel: 'sessions:read-document',
      callerContext,
      invoke: async () => 'ok',
      log: { warn },
      now: plain,
      heldMs: () => 0,
      // No held window at all, and the CPU share says the time was ours: this is the shape that must stay
      // quiet about the low band while still carrying the number.
      cpuUsage: cpuPair(540)
    })
    expect(warn).toHaveBeenCalledWith('ipc handler was slow', {
      channel: 'sessions:read-document',
      surface: 'web',
      location: 'local',
      durationMs: 600,
      cpuMs: 540,
      cpuShare: 0.9,
      attribution: 'cpu-bound-in-process'
    })

    // A broken held source degrades to the plain duration rather than dropping the line.
    warn.mockClear()
    const broken = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(600)
    await invokeWithIpcRejectionDiagnostics({
      channel: 'sessions:list-catalog',
      callerContext,
      invoke: async () => 'ok',
      log: { warn },
      now: broken,
      // Zero CPU over the window and the held registry cannot answer: the line carries the measurement
      // (`no-cpu-in-process`) and claims nothing about why — the held split is the only thing that could.
      cpuUsage: cpuPair(0),
      heldMs: () => {
        throw new Error('registry unavailable')
      }
    })
    expect(warn).toHaveBeenCalledWith('ipc handler was slow', {
      channel: 'sessions:list-catalog',
      surface: 'web',
      location: 'local',
      durationMs: 600,
      cpuMs: 0,
      cpuShare: 0,
      attribution: 'no-cpu-in-process'
    })
  })

  it('records only allowlisted caller metadata for a rejection and rethrows the same value', async () => {
    const warn = vi.fn()
    const secretError = Object.assign(new Error('secret provider failure'), {
      code: 'EACCES',
      data: { token: 'secret-token' }
    })
    const invoke = vi.fn(async (_payload: unknown) => {
      void _payload
      throw secretError
    })
    const now = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(34)

    const rejected = invokeWithIpcRejectionDiagnostics({
      channel: 'projects:list',
      callerContext: createWebCallerContext('secret-client-id', {
        location: 'remote',
        principalKind: 'automation',
        actionOrigin: 'agent-session'
      }),
      invoke: () => invoke({ path: '/private/research.txt', token: 'secret-token' }),
      log: { warn },
      now
    })

    await expect(rejected).rejects.toBe(secretError)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('ipc handler rejected', {
      channel: 'projects:list',
      surface: 'web',
      location: 'remote',
      principalKind: 'automation',
      actionOrigin: 'agent-session',
      durationMs: 24,
      errorCategory: 'permission'
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-client-id')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-token')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/private/research.txt')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret provider failure')
  })

  it('preserves successful synchronous values without writing diagnostics', () => {
    const warn = vi.fn()
    const result = { secretResult: true }

    expect(
      invokeWithIpcRejectionDiagnostics({
        channel: 'projects:list',
        callerContext: createWebCallerContext('client-a'),
        invoke: () => result,
        log: { warn }
      })
    ).toBe(result)
    expect(warn).not.toHaveBeenCalled()
  })

  it('records rejected custom thenables without changing the rejection value', async () => {
    const warn = vi.fn()
    const rejection = new Error('private thenable failure')
    const thenable = {
      then: (_onFulfilled: unknown, onRejected: (reason: unknown) => unknown): void => {
        onRejected(rejection)
      }
    }

    const result = invokeWithIpcRejectionDiagnostics({
      channel: 'projects:list',
      callerContext: createWebCallerContext('client-a'),
      invoke: () => thenable,
      log: { warn }
    })

    await expect(Promise.resolve(result)).rejects.toBe(rejection)
    expect(warn).toHaveBeenCalledWith(
      'ipc handler rejected',
      expect.objectContaining({ channel: 'projects:list', errorCategory: 'error' })
    )
  })

  it('reads a side-effectful then getter once and preserves its original rejection', async () => {
    const warn = vi.fn()
    const rejection = new Error('original private rejection')
    const replacement = new Error('second getter must not win')
    let reads = 0
    const thenable = Object.defineProperty({}, 'then', {
      get: () => {
        reads += 1
        if (reads > 1) throw replacement
        return (_resolve: unknown, reject: (reason: unknown) => void): void => reject(rejection)
      }
    })

    const result = invokeWithIpcRejectionDiagnostics({
      channel: 'projects:list',
      callerContext: createWebCallerContext('client-a'),
      invoke: () => thenable,
      log: { warn }
    })

    await expect(Promise.resolve(result)).rejects.toBe(rejection)
    expect(reads).toBe(1)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('does not let diagnostic sink or clock failures change a synchronous rejection', () => {
    const rejection = new TypeError('private detail')

    expect(() =>
      invokeWithIpcRejectionDiagnostics({
        channel: 'projects:list',
        callerContext: createWebCallerContext('client-a'),
        invoke: () => {
          throw rejection
        },
        log: {
          warn: () => {
            throw new Error('sink unavailable')
          }
        },
        now: () => {
          throw new Error('clock unavailable')
        }
      })
    ).toThrow(rejection)
  })
})
