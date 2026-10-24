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
} => {
  const log = makeLogger()
  let clock = 1_000
  const recorder = createComposeStepRecorder({
    log,
    now: () => clock,
    slowMs: options.slowMs ?? 250,
    summarySize: options.summarySize ?? 6
  })
  return { log, recorder, advance: (ms: number) => (clock += ms) }
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
      durationMs: 1_800
    })
  })

  it('records a failure with its category and rethrows', async () => {
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
