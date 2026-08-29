import { describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeEvent } from '../shared/acp'
import { createBoundedEventAdmission } from './event-admission'

const event = (kind: AcpRuntimeEvent['kind'], id: string): AcpRuntimeEvent =>
  ({ id, timestamp: 1, kind, level: 'info' }) as AcpRuntimeEvent

describe('createBoundedEventAdmission', () => {
  it('passes events within the per-window budget', () => {
    const broadcast = vi.fn()
    const admit = createBoundedEventAdmission(broadcast, { windowMs: 16, maxPerWindow: 5 })
    for (let i = 0; i < 5; i += 1) admit(event('thought', `t${i}`))
    expect(broadcast).toHaveBeenCalledTimes(5)
  })

  it('drops excess transient events inside a window', () => {
    const broadcast = vi.fn()
    const admit = createBoundedEventAdmission(broadcast, { windowMs: 16, maxPerWindow: 2 })
    for (let i = 0; i < 10; i += 1) admit(event('thought', `t${i}`))
    expect(broadcast).toHaveBeenCalledTimes(2)
  })

  it('always admits critical events even beyond the budget', () => {
    const broadcast = vi.fn()
    const admit = createBoundedEventAdmission(broadcast, { windowMs: 16, maxPerWindow: 1 })
    admit(event('thought', 't0'))
    admit(event('stop', 's0'))
    admit(event('error', 'e0'))
    admit(event('artifact', 'a0'))
    expect(broadcast).toHaveBeenCalledTimes(4)
  })

  it('resets the budget when the window elapses', () => {
    vi.useFakeTimers()
    try {
      const broadcast = vi.fn()
      let timerCallback: (() => void) | undefined
      const admit = createBoundedEventAdmission(broadcast, {
        windowMs: 16,
        maxPerWindow: 1,
        setTimer: (fn) => {
          timerCallback = fn
          return 1 as never
        },
        clearTimer: vi.fn()
      })
      admit(event('thought', 'a'))
      admit(event('thought', 'b')) // dropped (budget 1)
      expect(broadcast).toHaveBeenCalledTimes(1)
      // Window elapses → budget resets.
      timerCallback?.()
      admit(event('thought', 'c'))
      expect(broadcast).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens a fresh window when a later call arrives after the deadline', () => {
    let clock = 0
    const broadcast = vi.fn()
    const admit = createBoundedEventAdmission(broadcast, {
      windowMs: 16,
      maxPerWindow: 1,
      now: () => clock
    })
    admit(event('thought', 'a'))
    clock = 100
    admit(event('thought', 'b'))
    expect(broadcast).toHaveBeenCalledTimes(2)
  })
})
