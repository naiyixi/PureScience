import { describe, expect, it } from 'vitest'

import { DelegationRegistry } from './delegation-registry'

describe('DelegationRegistry', () => {
  it('defaults every session to enabled', () => {
    const registry = new DelegationRegistry()
    expect(registry.isEnabled('session-a')).toBe(true)
    expect(registry.isEnabled('session-b')).toBe(true)
  })

  it('disables only the session that opted out', () => {
    const registry = new DelegationRegistry()
    registry.setEnabled('session-a', false)
    expect(registry.isEnabled('session-a')).toBe(false)
    expect(registry.isEnabled('session-b')).toBe(true)
  })

  it('re-enables a session and clears state on delete', () => {
    const registry = new DelegationRegistry()
    registry.setEnabled('session-a', false)
    registry.setEnabled('session-a', true)
    expect(registry.isEnabled('session-a')).toBe(true)
    registry.setEnabled('session-a', false)
    registry.clear('session-a')
    expect(registry.isEnabled('session-a')).toBe(true)
  })
})
