import { describe, expect, it } from 'vitest'

import { evaluateCapabilityGate } from './capability-gate'

const gated = {
  id: 'needs-matrix',
  requires: ['input:omics_file'] as const,
  produces: [] as const,
  failurePolicy: { missing_state: '先让用户上传表达矩阵，再开始。' }
}
const ungated = {
  id: 'plain-skill',
  requires: ['input:omics_file'] as const,
  produces: [] as const,
  failurePolicy: {}
}
const producer = {
  id: 'fetch-geo',
  requires: [] as const,
  produces: ['input:omics_file'] as const,
  failurePolicy: {}
}
const contracts = [
  { ...gated, requires: [...gated.requires], produces: [...gated.produces] },
  { ...ungated, requires: [...ungated.requires], produces: [...ungated.produces] },
  { ...producer, requires: [...producer.requires], produces: [...producer.produces] }
]

describe('evaluateCapabilityGate', () => {
  it('refuses a declared capability whose requirement is missing, naming a producer', () => {
    const refusal = evaluateCapabilityGate({
      referenced: ['needs-matrix'],
      contracts,
      facts: []
    })
    expect(refusal?.capability).toBe('needs-matrix')
    expect(refusal?.missing).toEqual([{ fact: 'input:omics_file', producers: ['fetch-geo'] }])
    expect(refusal?.message).toContain('无法开始「needs-matrix」')
    expect(refusal?.message).toContain('fetch-geo')
    // The policy is the author's own words, not a generic sentence invented here.
    expect(refusal?.message).toContain('先让用户上传表达矩阵')
  })

  it('never blocks a capability that declared no missing_state policy', () => {
    expect(evaluateCapabilityGate({ referenced: ['plain-skill'], contracts, facts: [] })).toBeNull()
  })

  it('never blocks a capability with no contract at all', () => {
    expect(
      evaluateCapabilityGate({ referenced: ['not-declared'], contracts, facts: [] })
    ).toBeNull()
  })

  it('stays quiet when the fact is already present', () => {
    expect(
      evaluateCapabilityGate({
        referenced: ['needs-matrix'],
        contracts,
        facts: ['input:omics_file']
      })
    ).toBeNull()
  })

  it('does nothing when the turn aimed at no capability', () => {
    expect(evaluateCapabilityGate({ referenced: [], contracts, facts: [] })).toBeNull()
  })

  it('says plainly when nothing in the install produces the fact', () => {
    const refusal = evaluateCapabilityGate({
      referenced: ['needs-matrix'],
      contracts: [contracts[0]!],
      facts: []
    })
    expect(refusal?.missing[0]?.producers).toEqual([])
    expect(refusal?.message).toContain('没有能力声明会生成它')
  })

  it('is deterministic across calls', () => {
    const run = (): unknown =>
      evaluateCapabilityGate({ referenced: ['needs-matrix'], contracts, facts: [] })
    expect(run()).toEqual(run())
  })
})
