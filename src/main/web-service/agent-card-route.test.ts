import { describe, expect, it } from 'vitest'

import { AGENT_CARD_SCHEMA, buildAgentCardPayload } from './agent-card-route'

const base = { appName: 'PureScience', appVersion: '2.19.0', platform: 'darwin' }

describe('buildAgentCardPayload', () => {
  it('states what this build offers', () => {
    const card = buildAgentCardPayload({ ...base, capabilityNames: ['memory', 'plan'] })

    expect(card).toEqual({
      schema: AGENT_CARD_SCHEMA,
      name: 'PureScience',
      version: '2.19.0',
      platform: 'darwin',
      capabilities: ['memory', 'plan'],
      interop: { a2a: 'unverified', acp: 'primary' }
    })
  })

  it('falls back to the session capability contract, not a second list', () => {
    const card = buildAgentCardPayload(base)

    // The card must describe the same capabilities the session owner attaches; a copy would drift.
    expect(card.capabilities).toContain('memory')
    expect(card.capabilities).toContain('notebook')
    expect(card.capabilities.length).toBeGreaterThanOrEqual(14)
  })

  it('never claims A2A compatibility before an interop test exists', () => {
    const card = buildAgentCardPayload(base)

    // §4: 「任何『兼容 A2A』的说法在实测之前都不成立」—— so the field is machine-readable, not a comment.
    expect(card.interop.a2a).toBe('unverified')
    expect(card.interop.acp).toBe('primary')
  })
})
