import { describe, expect, it } from 'vitest'

import type { CapabilityContract } from './capability-contract'
import { factsForSession } from './capability-session-facts'

const literature: CapabilityContract = {
  id: 'literature-review',
  aliases: ['文献综述'],
  requires: [],
  produces: ['evidence:literature_set'],
  prerequisites: [],
  failurePolicy: {}
}

const grading: CapabilityContract = {
  id: 'evidence-grading',
  aliases: ['证据分级'],
  requires: ['evidence:literature_set'],
  produces: ['review:evidence_grade'],
  prerequisites: [],
  failurePolicy: {}
}

const contracts = [literature, grading]

describe('factsForSession', () => {
  it('turns an attachment name into the input fact it unambiguously establishes', () => {
    const result = factsForSession({ attachments: [{ name: 'pbmc.h5ad' }] }, contracts)
    expect(result.facts).toEqual(['input:omics_file'])
    expect(result.sources['input:omics_file']).toEqual(['file:pbmc.h5ad'])
    expect(result.problems).toEqual([])
  })

  it('expands a capability the session ran into the facts it declared producing', () => {
    const result = factsForSession({ usedCapabilities: ['literature-review'] }, contracts)
    expect(result.facts).toEqual(['evidence:literature_set'])
    expect(result.sources['evidence:literature_set']).toEqual(['capability:literature-review'])
  })

  it('names an unknown capability instead of quietly establishing nothing', () => {
    const result = factsForSession({ usedCapabilities: ['not-installed'] }, contracts)
    expect(result.facts).toEqual([])
    expect(result.problems).toEqual(['unknown_capability:not-installed'])
  })

  it('maps artifact extensions to artifact facts, and leaves ambiguous files alone', () => {
    const result = factsForSession(
      {
        artifacts: [
          { path: 'out/ic50.png' },
          { path: 'out/table.csv' },
          { path: 'out/notes.md' },
          { path: 'out/unknown.xyz' }
        ]
      },
      contracts
    )
    expect(result.facts).toEqual(['artifact:figure', 'artifact:table'])
    expect(result.sources['artifact:figure']).toEqual(['artifact:out/ic50.png'])
    expect(result.sources['artifact:table']).toEqual(['artifact:out/table.csv'])
  })

  it('keeps evidence from all three sources on the same fact', () => {
    const result = factsForSession(
      {
        attachments: [{ name: 'matrix.h5ad' }],
        usedCapabilities: ['literature-review', 'evidence-grading']
      },
      contracts
    )
    expect(result.facts).toEqual([
      'input:omics_file',
      'evidence:literature_set',
      'review:evidence_grade'
    ])
    expect(result.problems).toEqual([])
  })

  it('is empty and problem-free for a session with nothing recorded', () => {
    expect(factsForSession({}, contracts)).toEqual({ facts: [], sources: {}, problems: [] })
  })
})
