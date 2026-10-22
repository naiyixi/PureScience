import { describe, expect, it } from 'vitest'

import { renderCapabilityGaps } from './capability-preflight-prompt'

const matrix = { id: 'needs-matrix', requires: ['input:omics_file'], produces: ['data:summary'] }
const summary = { id: 'makes-summary', requires: [], produces: ['data:summary'] }
const report = { id: 'needs-summary', requires: ['data:summary'], produces: ['review:final'] }
const contracts = [matrix, summary, report]

describe('renderCapabilityGaps', () => {
  it('says nothing when every selected capability is ready', () => {
    const block = renderCapabilityGaps({
      selected: ['needs-matrix'],
      contracts,
      facts: ['input:omics_file']
    })
    expect(block).toBeNull()
  })

  it('names the missing fact and the capability that would establish it', () => {
    const block = renderCapabilityGaps({ selected: ['needs-summary'], contracts, facts: [] })
    expect(block).toContain('<purescience_capability_gaps>')
    expect(block).toContain('needs-summary 需要 summary（data:summary）')
    // Producers are listed in declaration order, so the output is stable across runs.
    expect(block).toContain('先运行 needs-matrix 或 makes-summary')
  })

  it('says plainly when nothing in the install produces the fact', () => {
    const block = renderCapabilityGaps({ selected: ['needs-matrix'], contracts, facts: [] })
    expect(block).toContain('没有能力声明会生成它')
  })

  it('does not mention capabilities that were not selected', () => {
    const block = renderCapabilityGaps({ selected: ['needs-summary'], contracts, facts: [] })
    expect(block).not.toContain('needs-matrix 需要')
  })

  it('is deterministic for the same input', () => {
    const first = renderCapabilityGaps({ selected: ['needs-summary'], contracts, facts: [] })
    const second = renderCapabilityGaps({ selected: ['needs-summary'], contracts, facts: [] })
    expect(first).toEqual(second)
  })

  it('caps the block and counts what it left out', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      id: `skill-${index}`,
      requires: ['input:omics_file'] as const,
      produces: []
    }))
    const block = renderCapabilityGaps({
      selected: many.map((entry) => entry.id),
      contracts: many.map((entry) => ({ ...entry, requires: [...entry.requires] })),
      facts: [],
      maxLines: 3
    })
    expect(block?.split('\n').filter((line) => line.startsWith('- ')).length).toBe(3)
    expect(block).toContain('另有 17 条未列出')
  })
})
