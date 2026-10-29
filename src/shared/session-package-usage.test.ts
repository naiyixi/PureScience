import { describe, expect, it } from 'vitest'

import {
  compareSessionPackageUsage,
  deriveSessionPackageUsage,
  type SessionPackageUsage
} from './session-package-usage'

const conversation = (): {
  messages: Array<Record<string, unknown>>
  activities: Array<Record<string, unknown>>
} => ({
  messages: [
    { role: 'user', text: '模拟一下分子对接' },
    {
      role: 'agent',
      text: '好的',
      turnUsage: { inputTokens: 1200, outputTokens: 300, cacheTokens: 0 }
    },
    { role: 'user', text: '再跑一次' },
    {
      role: 'agent',
      text: '完成',
      turnUsage: { inputTokens: 800, outputTokens: 200, cacheTokens: 40 }
    }
  ],
  activities: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]
})

describe('deriveSessionPackageUsage', () => {
  it('counts user turns, tool rows and the token totals the transcript records', () => {
    expect(deriveSessionPackageUsage(conversation())).toEqual({
      turns: 2,
      toolCalls: 3,
      inputTokens: 2000,
      outputTokens: 500,
      turnsWithoutUsage: 0
    })
  })

  it('names a turn that recorded nothing instead of counting it as free', () => {
    const doc = conversation()
    // A third answer that carries neither a usage record nor the explicit unavailable marker.
    doc.messages.push({ role: 'agent', text: '补充' })

    expect(deriveSessionPackageUsage(doc)).toEqual({
      turns: 2,
      toolCalls: 3,
      inputTokens: 2000,
      outputTokens: 500,
      // Two turns recorded usage; this one did not — the token totals are a floor, and the reader can see it.
      turnsWithoutUsage: 1
    })
  })

  it('does not count an explicitly unavailable turn as missing', () => {
    const doc = conversation()
    doc.messages.push({ role: 'agent', text: '未记录', turnUsageUnavailable: true })

    expect(deriveSessionPackageUsage(doc)?.turnsWithoutUsage).toBe(0)
  })

  it('treats a half-readable usage record as unrecorded rather than summing a partial value', () => {
    const doc = conversation()
    doc.messages.push({ role: 'agent', text: '半个记录', turnUsage: { inputTokens: 10 } })

    const usage = deriveSessionPackageUsage(doc)
    expect(usage?.turnsWithoutUsage).toBe(1)
    expect(usage?.inputTokens).toBe(2000)
  })

  it('returns null for a document that is not a transcript', () => {
    expect(deriveSessionPackageUsage(null)).toBeNull()
    expect(deriveSessionPackageUsage({ messages: 'nope' })).toBeNull()
    expect(deriveSessionPackageUsage({ messages: [], activities: 'nope' })).toBeNull()
  })
})

describe('compareSessionPackageUsage', () => {
  const declared: SessionPackageUsage = {
    turns: 2,
    toolCalls: 3,
    inputTokens: 2000,
    outputTokens: 500,
    turnsWithoutUsage: 0
  }

  it('matches only when every field agrees', () => {
    expect(compareSessionPackageUsage(declared, deriveSessionPackageUsage(conversation()))).toEqual({
      state: 'match'
    })
  })

  it('names the fields that disagree', () => {
    const comparison = compareSessionPackageUsage(
      { ...declared, inputTokens: 1999, toolCalls: 4 },
      deriveSessionPackageUsage(conversation())
    )

    expect(comparison).toEqual({ state: 'mismatch', fields: ['toolCalls', 'inputTokens'] })
  })

  it('reports an absent summary as not-recorded — never as agreement', () => {
    expect(compareSessionPackageUsage(undefined, deriveSessionPackageUsage(conversation()))).toEqual({
      state: 'not-recorded'
    })
  })

  it('reports a summary it cannot verify as underivable — never as agreement', () => {
    expect(compareSessionPackageUsage(declared, null)).toEqual({ state: 'underivable' })
    // A summary with a field missing or unreadable is not a summary this build can check.
    expect(compareSessionPackageUsage({ turns: 2 }, deriveSessionPackageUsage(conversation()))).toEqual({
      state: 'underivable'
    })
    expect(
      compareSessionPackageUsage(
        { ...declared, inputTokens: -1 },
        deriveSessionPackageUsage(conversation())
      )
    ).toEqual({ state: 'underivable' })
  })
})
