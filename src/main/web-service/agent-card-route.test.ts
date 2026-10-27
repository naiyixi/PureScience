import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
      interop: { a2a: 'verified', acp: 'primary' }
    })
  })

  it('falls back to the session capability contract, not a second list', () => {
    const card = buildAgentCardPayload(base)

    // The card must describe the same capabilities the session owner attaches; a copy would drift.
    expect(card.capabilities).toContain('memory')
    expect(card.capabilities).toContain('notebook')
    expect(card.capabilities.length).toBeGreaterThanOrEqual(14)
  })

  it('only claims A2A compatibility while a recorded interop reading exists', () => {
    const card = buildAgentCardPayload(base)
    expect(card.interop.acp).toBe('primary')

    if (card.interop.a2a === 'unverified') {
      // Either state is allowed, but not silently: a claim either has its reading on disk or it does not
      // claim anything. §4: 「任何『兼容 A2A』的说法在实测之前都不成立」.
      expect(card.interop.a2a).toBe('unverified')
      return
    }

    // 'verified' is only acceptable when the reading that earned it is in the tree, and that reading has
    // to contain the round-trip result rather than a promise to run it later.
    const evidence = readFileSync(
      resolve(__dirname, '../../../docs/evidence/2026-10-27-a2a-interop-probe.md'),
      'utf8'
    )
    expect(evidence).toContain('ROUNDTRIP')
    expect(evidence).toContain('message/send')
  })
})
