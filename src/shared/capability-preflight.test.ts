import { describe, expect, it } from 'vitest'

import type { CapabilityContract } from './capability-contract'
import { indexProducers, preflightCapability } from './capability-preflight'

const qc: CapabilityContract = {
  id: 'single-cell-rna-qc',
  aliases: ['质控'],
  requires: ['input:expression_matrix'],
  produces: ['data:cluster', 'data:marker_table'],
  prerequisites: [],
  failurePolicy: { missing_state: 'Load a matrix first.' }
}

const annotation: CapabilityContract = {
  id: 'cell-type-annotation',
  aliases: ['注释'],
  requires: ['data:cluster'],
  produces: ['data:annotation'],
  prerequisites: [],
  failurePolicy: {}
}

const contracts = [qc, annotation]
const producers = indexProducers(contracts)

describe('indexProducers', () => {
  it('maps each produced fact to its producers, sorted', () => {
    expect(producers.get('data:cluster')).toEqual(['single-cell-rna-qc'])
    expect(producers.get('input:expression_matrix')).toBeUndefined()
  })
})

describe('preflightCapability', () => {
  it('is ready when every requirement is held', () => {
    const result = preflightCapability(qc, ['input:expression_matrix'], producers)
    expect(result).toMatchObject({ status: 'ready', reason: 'all_requirements_met', missing: [] })
    expect(result.failure).toBeUndefined()
  })

  it('reports the missing fact together with the capability that establishes it', () => {
    const result = preflightCapability(annotation, [], producers)
    expect(result).toMatchObject({
      capabilityId: 'cell-type-annotation',
      status: 'missing_state',
      reason: 'missing_requirements'
    })
    expect(result.missing).toEqual([{ fact: 'data:cluster', producers: ['single-cell-rna-qc'] }])
    expect(result.suggested).toEqual(['single-cell-rna-qc'])
  })

  it('never suggests the capability itself as its own prerequisite', () => {
    const selfRequiring: CapabilityContract = {
      ...annotation,
      id: 'cell-type-annotation',
      produces: ['data:cluster', 'data:annotation']
    }
    const index = indexProducers([selfRequiring])
    const result = preflightCapability(selfRequiring, [], index)
    expect(result.missing[0]?.producers).toEqual([])
    expect(result.suggested).toEqual([])
  })

  it('honours a declared repair for missing_state, and says so when none is declared', () => {
    expect(preflightCapability(qc, [], producers).failure).toEqual({
      class: 'missing_state',
      repair: 'Load a matrix first.'
    })
    expect(preflightCapability(annotation, [], producers).failure).toEqual({
      class: 'missing_state',
      repair: null
    })
  })

  it('reports an undeclared capability as undeclared, never as ready', () => {
    const result = preflightCapability(null, ['input:expression_matrix'], producers)
    expect(result).toMatchObject({ status: 'undeclared', reason: 'no_contract', missing: [] })
  })

  it('orders suggestions by the order the gaps were declared, deduped', () => {
    const twoGaps: CapabilityContract = {
      ...annotation,
      requires: ['data:annotation', 'data:cluster'],
      produces: []
    }
    const producerA: CapabilityContract = { ...qc, id: 'a-producer', produces: ['data:annotation'] }
    const index = indexProducers([producerA, qc])
    const result = preflightCapability(twoGaps, [], index)
    expect(result.suggested).toEqual(['a-producer', 'single-cell-rna-qc'])
  })

  it('accepts any iterable of held facts', () => {
    const result = preflightCapability(qc, new Set(['input:expression_matrix']), producers)
    expect(result.status).toBe('ready')
  })
})
