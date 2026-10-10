import { describe, expect, it, vi } from 'vitest'

import { createProcessFailureCapture, type ProcessFailureCaptureOptions } from './crash-diagnostics'

type CapturedRecord = Record<string, unknown>

const recordsOf = (log: { error: ReturnType<typeof vi.fn> }): CapturedRecord[] =>
  log.error.mock.calls.map((call) => call[1] as CapturedRecord)

const setupCapture = (
  overrides: Partial<Omit<ProcessFailureCaptureOptions, 'log'>> = {}
): {
  log: { error: ReturnType<typeof vi.fn> }
  capture: ReturnType<typeof createProcessFailureCapture>
  advance: (ms: number) => void
} => {
  const log = { error: vi.fn() }
  let clock = 1_000_000
  const capture = createProcessFailureCapture({ log, now: () => clock, ...overrides })
  return { log, capture, advance: (ms: number) => (clock += ms) }
}

describe('process failure capture: what a record must carry', () => {
  it('replaces the category-only record with a redacted message, a stack frame and a count', () => {
    const { log, capture } = setupCapture()
    const error = new Error('request to https://api.example.com/v1/messages failed')
    error.name = 'RequestError'
    error.stack = [
      'RequestError: request failed',
      '    at sendPrompt (/Users/researcher/.purescience/src/main/acp/client.ts:412:19)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)'
    ].join('\n')

    capture(error, 'uncaughtException')

    expect(log.error).toHaveBeenCalledTimes(1)
    const [message, fields] = log.error.mock.calls[0] as [string, CapturedRecord]
    // The message name and the category vocabulary stay exactly what they were.
    expect(message).toBe('uncaughtException')
    expect(fields).toMatchObject({
      errorName: 'RequestError',
      errorCategory: 'request',
      occurrences: 1,
      windowMs: 60_000
    })
    // No URL, no absolute path and no user name may leave the process.
    expect(String(fields.message)).toContain('<url>')
    expect(String(fields.message)).not.toContain('api.example.com')
    expect(String(fields.frame)).toBe('sendPrompt (client.ts:412:19)')
    expect(String(fields.frame)).not.toContain('/Users/')
  })

  it('redacts identifiers and opaque tokens, and bounds the message', () => {
    const { log, capture } = setupCapture({ maxMessageChars: 60 })
    const error = new Error(
      `save failed for 3f9a1c2e-7b4d-4a6f-9d21-2c8e5b0a7712 at ${'a'.repeat(64)} contact research@example.org`
    )

    capture(error, 'uncaughtException')

    const fields = recordsOf(log)[0]
    expect(String(fields.message)).toContain('<id>')
    expect(String(fields.message)).toContain('<token>')
    expect(String(fields.message)).toContain('<email>')
    expect(String(fields.message).length).toBeLessThanOrEqual(61)
  })

  it('reports a missing message honestly instead of guessing one', () => {
    const { log, capture } = setupCapture()

    capture({ code: 'ECONNRESET' }, 'unhandledRejection')

    expect(recordsOf(log)[0]).toMatchObject({
      errorCategory: 'network',
      message: '(no message)',
      frame: 'unavailable'
    })
  })

  it('does not invent a category for a bare string rejection', () => {
    const { log, capture } = setupCapture()

    capture('ECONNREFUSED while resolving host', 'unhandledRejection')

    // The message name still says which channel raised it; the category is honestly just "a string"
    // rather than a guess that it was a network error.
    expect(log.error.mock.calls[0][0]).toBe('unhandledRejection')
    expect(recordsOf(log)[0]).toMatchObject({
      errorCategory: 'string',
      errorName: 'Unknown',
      message: 'ECONNREFUSED while resolving host',
      frame: 'unavailable'
    })
  })
})

describe('process failure capture: folding and backoff', () => {
  it('writes one record per window and folds the repeats into a count', () => {
    const { log, capture, advance } = setupCapture({ windowMs: 60_000 })
    const failure = new Error('fetch failed')

    for (let index = 0; index < 604; index += 1) {
      capture(failure, 'uncaughtException')
      if (index % 100 === 0) advance(100)
    }

    // 604 events inside one window: the first is written, the rest are counted rather than written.
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(capture.pending()).toBe(603)

    advance(60_000)
    capture(failure, 'uncaughtException')

    const records = recordsOf(log)
    expect(records).toHaveLength(2)
    expect(records[0].occurrences).toBe(1)
    // The folded record carries the whole burst and the span it covered.
    expect(records[1].occurrences).toBe(604)
    expect(records[1].firstAt).not.toBe(records[1].lastAt)
  })

  it('doubles the window after each written record so a sustained storm keeps shrinking', () => {
    const { log, capture, advance } = setupCapture({ windowMs: 1_000, backoffFactor: 2 })
    const failure = new Error('connection reset')

    capture(failure, 'uncaughtException') // writes; window 1 is 1 s
    advance(1_000)
    capture(failure, 'uncaughtException') // closes window 1 ⇒ window 2 is 2 s
    advance(2_000)
    capture(failure, 'uncaughtException') // closes window 2 ⇒ window 3 is 4 s
    advance(1_000)
    capture(failure, 'uncaughtException') // still inside window 3

    const records = recordsOf(log)
    expect(records.map((record) => record.windowMs)).toEqual([1_000, 1_000, 2_000])
    expect(records.map((record) => record.occurrences)).toEqual([1, 1, 2])
    expect(capture.pending()).toBe(2)
  })

  it('caps the backoff window', () => {
    const { log, capture, advance } = setupCapture({
      windowMs: 1_000,
      backoffFactor: 4,
      maxWindowMs: 4_000
    })
    const failure = new Error('timeout')

    capture(failure, 'uncaughtException')
    advance(1_000)
    capture(failure, 'uncaughtException')
    advance(4_000)
    capture(failure, 'uncaughtException')
    advance(4_000)
    capture(failure, 'uncaughtException')

    const windows = recordsOf(log).map((record) => Number(record.windowMs))
    expect(windows).toEqual([1_000, 1_000, 4_000, 4_000])
    expect(Math.max(...windows)).toBe(4_000)
  })

  it('flushes folded occurrences exactly once', () => {
    const { log, capture } = setupCapture()
    const failure = new Error('fetch failed')

    capture(failure, 'uncaughtException')
    capture(failure, 'uncaughtException')
    capture(failure, 'uncaughtException')

    expect(capture.flush()).toBe(1)
    expect(capture.pending()).toBe(0)
    expect(capture.flush()).toBe(0)
    expect(recordsOf(log).at(-1)).toMatchObject({ occurrences: 3 })
  })

  it('keeps distinct signatures apart', () => {
    const { log, capture } = setupCapture()

    capture(new Error('first failure'), 'uncaughtException')
    capture(new Error('second failure'), 'uncaughtException')

    expect(log.error).toHaveBeenCalledTimes(2)
    expect(recordsOf(log).map((record) => record.message)).toEqual([
      'first failure',
      'second failure'
    ])
  })
})
