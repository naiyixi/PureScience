import { describe, expect, it, vi } from 'vitest'

import { createComposeStepRecorder } from './compose-steps'

type LogMethod = (message: string, metadata: Record<string, unknown>) => void

const makeLogger = (): {
  info: ReturnType<typeof vi.fn<LogMethod>>
  warn: ReturnType<typeof vi.fn<LogMethod>>
  error: ReturnType<typeof vi.fn<LogMethod>>
} => ({
  info: vi.fn<LogMethod>(),
  warn: vi.fn<LogMethod>(),
  error: vi.fn<LogMethod>()
})

const setup = (
  options: { slowMs?: number; summarySize?: number } = {}
): {
  log: ReturnType<typeof makeLogger>
  recorder: ReturnType<typeof createComposeStepRecorder>
  advance: (ms: number) => void
  advanceWallOnly: (ms: number) => void
  advanceWithCpu: (wallMs: number, cpuMs: number) => void
} => {
  const log = makeLogger()
  let clock = 1_000
  let cpu = { user: 0, system: 0 }
  const recorder = createComposeStepRecorder({
    log,
    now: () => clock,
    cpuUsage: () => cpu,
    slowMs: options.slowMs ?? 250,
    summarySize: options.summarySize ?? 6
  })
  return {
    log,
    recorder,
    // A step that spends 80 % of its window on CPU — the shape an in-process block has.
    advance: (ms: number) => {
      clock += ms
      cpu = { user: cpu.user + ms * 800, system: cpu.system }
    },
    // Wall time without CPU: what a suspended laptop (or a descheduled process) looks like.
    advanceWallOnly: (ms: number) => {
      clock += ms
    },
    advanceWithCpu: (wallMs: number, cpuMs: number) => {
      clock += wallMs
      cpu = { user: cpu.user + cpuMs * 1000, system: cpu.system }
    }
  }
}

describe('compose step recorder', () => {
  it('returns the step value and stays silent for a fast step', async () => {
    const { log, recorder } = setup()

    const value = await recorder.step('read-stored-settings', () => Promise.resolve('settings'))

    expect(value).toBe('settings')
    // A healthy startup must not pay a line per step: only the summary is written by the caller.
    expect(log.warn).not.toHaveBeenCalled()
    expect(log.info).not.toHaveBeenCalled()
    expect(recorder.steps()).toEqual([
      { name: 'read-stored-settings', durationMs: 0, outcome: 'ok' }
    ])
  })

  it('names the step that was slow', async () => {
    const { log, recorder, advance } = setup({ slowMs: 250 })

    await recorder.step('restore-notification-inbox', () => {
      advance(1_800)
      return Promise.resolve(undefined)
    })

    expect(log.warn).toHaveBeenCalledWith('compose step slow', {
      step: 'restore-notification-inbox',
      durationMs: 1_800,
      cpuMs: 1_440,
      cpuShare: 0.8,
      attribution: 'cpu-bound-in-process'
    })
  })

  it('names a step whose wall time was not work instead of reporting it as cost', async () => {
    // Real record (2026-10-25, packaged build): `compose step slow { step: 'permission-grant-registry',
    // durationMs: 22763287 }` whose own CPU share was 0 — a suspended laptop, read as six hours of work.
    const { log, recorder, advanceWallOnly } = setup({ slowMs: 250 })

    await recorder.step('permission-grant-registry', () => {
      advanceWallOnly(22_763_287)
      return Promise.resolve(undefined)
    })
    recorder.logSummary()

    expect(log.warn).toHaveBeenCalledWith('compose step slow', {
      step: 'permission-grant-registry',
      durationMs: 22_763_287,
      cpuMs: 0,
      cpuShare: 0,
      attribution: 'no-cpu-in-process'
    })
    const fields = log.info.mock.calls[0][1] as Record<string, unknown>
    expect(String(fields.slowest)).toContain('permission-grant-registry=22763287ms(no-cpu)')
  })

  it('keeps the bare number when the share is inside the unresolved band', async () => {
    const { log, recorder, advanceWithCpu } = setup({ slowMs: 250 })

    await recorder.step('open-project-db', () => {
      // 1 000 ms of wall time with 300 ms of CPU: neither ours-in-full nor descheduled.
      advanceWithCpu(1_000, 300)
      return Promise.resolve(undefined)
    })
    recorder.logSummary()

    expect(log.warn).toHaveBeenCalledWith('compose step slow', {
      step: 'open-project-db',
      durationMs: 1_000,
      cpuMs: 300,
      cpuShare: 0.3,
      attribution: 'inconclusive'
    })
    const fields = log.info.mock.calls[0][1] as Record<string, unknown>
    expect(String(fields.slowest)).toContain('open-project-db=1000ms')
    expect(String(fields.slowest)).not.toContain('(no-cpu)')
  })

  it('reports a failure with its category and rethrows', async () => {
    const { log, recorder } = setup()

    await expect(
      recorder.step('hydrate-child-proxy-runtime', () => {
        throw Object.assign(new Error('keychain unavailable'), { code: 'ENOKEY' })
      })
    ).rejects.toThrow('keychain unavailable')

    expect(log.error).toHaveBeenCalledWith(
      'compose step failed',
      expect.objectContaining({ step: 'hydrate-child-proxy-runtime', errorCategory: 'system' })
    )
    expect(recorder.steps()[0]).toMatchObject({ outcome: 'failed' })
  })

  it('summarizes the slowest steps in one line, with the window total', async () => {
    const { log, recorder, advance } = setup({ summarySize: 2 })

    await recorder.step('settings-service', () => Promise.resolve(undefined))
    await recorder.step('read-stored-settings', () => {
      advance(9_000)
      return Promise.resolve(undefined)
    })
    await recorder.step('restore-notification-inbox', () => {
      advance(500)
      return Promise.resolve(undefined)
    })
    recorder.logSummary()

    expect(log.info).toHaveBeenCalledTimes(1)
    const [message, fields] = log.info.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('compose runtime steps')
    expect(fields).toMatchObject({ totalMs: 9_500, stepCount: 3 })
    // Slowest first, and only the configured number of entries.
    expect(String(fields.slowest)).toBe(
      'read-stored-settings=9000ms restore-notification-inbox=500ms'
    )
  })

  it('marks a failed step inside the summary without losing the others', async () => {
    const { log, recorder } = setup()

    await recorder.step('settings-service', () => Promise.resolve(undefined))
    await expect(
      recorder.step('restore-notification-inbox', () => Promise.reject(new Error('db locked')))
    ).rejects.toThrow('db locked')
    recorder.logSummary()

    const fields = log.info.mock.calls[0][1] as Record<string, unknown>
    expect(String(fields.slowest)).toContain('restore-notification-inbox=0ms(failed)')
    expect(fields.stepCount).toBe(2)
  })

  it('reports a zero total when no step ever ran', () => {
    const { recorder } = setup()

    expect(recorder.totalMs()).toBe(0)
    expect(recorder.steps()).toEqual([])
  })

  it('uses caller-supplied line names while the defaults stay as they were', async () => {
    const log = makeLogger()
    let clock = 0
    const recorder = createComposeStepRecorder({
      log,
      // Each reading advances the clock, so every step takes 20 ms without any real waiting.
      now: () => (clock += 20),
      slowMs: 10,
      messages: {
        slow: 'preflight step slow',
        failed: 'preflight step failed',
        summary: 'preflight steps'
      }
    })

    await recorder.step('probe-claude', () => Promise.resolve(true))
    await expect(
      recorder.step('probe-codex', () => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom')
    recorder.logSummary()

    expect(log.warn.mock.calls[0][0]).toBe('preflight step slow')
    expect(log.warn.mock.calls[0][1]).toMatchObject({ step: 'probe-claude' })
    expect(log.error.mock.calls[0][0]).toBe('preflight step failed')
    expect(log.error.mock.calls[0][1]).toMatchObject({ step: 'probe-codex' })
    expect(log.info.mock.calls[0][0]).toBe('preflight steps')
  })
})
