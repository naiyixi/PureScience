import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { STARTUP_STEPS, createStartupStepRecorder, formatStartupStepLine } from './startup-step'

describe('startup step marker', () => {
  it('names every step the window lifecycle records, and nothing else', () => {
    expect(STARTUP_STEPS).toEqual([
      'window-creation-start',
      'window-created',
      'tray-call-start',
      'tray-created',
      'tray-absent',
      'tray-failed'
    ])
  })

  it('writes one line per step with the step and the wall clock', () => {
    const write = vi.fn()
    const record = createStartupStepRecorder({ write, now: () => 1_764_000_000_000 })

    record('tray-call-start')

    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toBe(
      '[startup-step] tray-call-start at 2025-11-24T16:00:00.000Z\n'
    )
    expect(formatStartupStepLine('tray-call-start', 1_764_000_000_000)).toBe(
      '[startup-step] tray-call-start at 2025-11-24T16:00:00.000Z'
    )
  })

  it('never lets a marker that cannot be written break the caller', () => {
    const write = vi.fn(() => {
      throw new Error('EPIPE')
    })
    const record = createStartupStepRecorder({ write })

    expect(() => record('window-created')).not.toThrow()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('writes to descriptor 1 itself rather than through a stream', () => {
    // The whole point of the marker: a stream write only queues behind a blocked main thread. A unit test
    // cannot stop the event loop, so this reads the module's own source — as shipped, not as transformed —
    // and pins that the write is a synchronous descriptor write rather than `process.stdout`.
    const source = readFileSync(
      fileURLToPath(new URL('./startup-step.ts', import.meta.url)),
      'utf8'
    )
    expect(source).toContain('writeSync(1, text)')
    expect(source).not.toContain('process.stdout')
  })
})
