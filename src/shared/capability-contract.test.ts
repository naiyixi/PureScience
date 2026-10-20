import { describe, expect, it } from 'vitest'

import {
  extractContract,
  parseContractField,
  rankCapabilities,
  type CapabilityContract
} from './capability-contract'

const valid = {
  id: 'single-cell-rna-qc',
  aliases: ['质控', 'scRNA QC'],
  requires: ['input:expression_matrix'],
  produces: ['data:cluster', 'data:marker_table'],
  prerequisites: [],
  failure_policy: { missing_state: 'Load a matrix first.' }
}

describe('parseContractField', () => {
  it('accepts a well-formed contract and keeps every field', () => {
    const { contract, errors } = parseContractField(JSON.stringify(valid), 'single-cell-rna-qc')
    expect(errors).toEqual([])
    expect(contract).toEqual({
      id: 'single-cell-rna-qc',
      aliases: ['质控', 'scRNA QC'],
      requires: ['input:expression_matrix'],
      produces: ['data:cluster', 'data:marker_table'],
      prerequisites: [],
      failurePolicy: { missing_state: 'Load a matrix first.' }
    })
  })

  it('names an id that disagrees with the skill directory', () => {
    const { contract, errors } = parseContractField(JSON.stringify(valid), 'other-skill')
    expect(contract).toBeNull()
    expect(errors).toEqual(['id_mismatch:single-cell-rna-qc!=other-skill'])
  })

  it('rejects a fact outside the closed domain list', () => {
    const { contract, errors } = parseContractField(
      JSON.stringify({ ...valid, produces: ['model:structure'] })
    )
    expect(contract).toBeNull()
    expect(errors).toEqual(['produces_invalid_fact:model:structure'])
  })

  it('rejects an unknown key rather than ignoring a typo', () => {
    const { contract, errors } = parseContractField(
      JSON.stringify({ ...valid, requires_state: ['input:x'] })
    )
    expect(contract).toBeNull()
    expect(errors).toEqual(['contract_unknown_key:requires_state'])
  })

  it('rejects duplicate aliases and duplicate facts', () => {
    const { errors } = parseContractField(
      JSON.stringify({
        ...valid,
        aliases: ['QC', 'qc'],
        produces: ['data:cluster', 'data:cluster']
      })
    )
    expect(errors).toContain('aliases_duplicate:qc')
    expect(errors).toContain('produces_duplicate:data:cluster')
  })

  it('rejects a capability that lists itself as its own prerequisite', () => {
    const { errors } = parseContractField(
      JSON.stringify({ ...valid, prerequisites: ['single-cell-rna-qc'] })
    )
    expect(errors).toEqual(['prerequisites_self:single-cell-rna-qc'])
  })

  it('rejects an unknown failure class instead of dropping it', () => {
    const { errors } = parseContractField(
      JSON.stringify({ ...valid, failure_policy: { state_lost: 'x' } })
    )
    expect(errors).toEqual(['failure_policy_unknown_class:state_lost'])
  })

  it('reports non-JSON and empty values by name', () => {
    expect(parseContractField('').errors).toEqual(['contract_empty'])
    expect(parseContractField('nope').errors).toEqual(['contract_not_json'])
    expect(parseContractField('[]').errors).toEqual(['contract_not_object'])
  })

  it('leaves arrays optional, so an entry-point capability needs no requires', () => {
    const { contract, errors } = parseContractField(
      JSON.stringify({ id: 'lit-review', produces: ['evidence:literature_set'] })
    )
    expect(errors).toEqual([])
    expect(contract?.requires).toEqual([])
    expect(contract?.aliases).toEqual([])
  })
})

describe('extractContract', () => {
  const markdown = `---\nname: demo\ndescription: "d"\ncontract: '{"id":"demo","aliases":["演示"],"requires":[],"produces":["artifact:table"]}'\n---\n\n# Demo\n`

  it('reads the quoted JSON contract out of frontmatter', () => {
    const { contract, errors } = extractContract(markdown, 'demo')
    expect(errors).toEqual([])
    expect(contract?.produces).toEqual(['artifact:table'])
  })

  it('treats a skill without a contract as undeclared, not broken', () => {
    const { contract, errors } = extractContract('---\nname: demo\ndescription: d\n---\n', 'demo')
    expect(contract).toBeNull()
    expect(errors).toEqual([])
  })
})

describe('rankCapabilities', () => {
  const contracts: CapabilityContract[] = [
    {
      id: 'single-cell-rna-qc',
      aliases: ['质控', 'scRNA QC'],
      requires: [],
      produces: [],
      prerequisites: [],
      failurePolicy: {}
    },
    {
      id: 'citation-integrity',
      aliases: ['引文核查'],
      requires: [],
      produces: [],
      prerequisites: [],
      failurePolicy: {}
    }
  ]

  it('matches a Chinese alias exactly', () => {
    expect(rankCapabilities('质控', contracts)).toEqual([
      { id: 'single-cell-rna-qc', score: 100, matched: ['质控'] }
    ])
  })

  it('matches a substring of a longer request', () => {
    const [top] = rankCapabilities('帮我做一下引文核查', contracts)
    expect(top).toMatchObject({ id: 'citation-integrity', score: 60 })
  })

  it('returns nothing for an empty request and keeps ordering deterministic', () => {
    expect(rankCapabilities('   ', contracts)).toEqual([])
    const both = [...contracts].reverse()
    expect(rankCapabilities('scRNA QC', both)).toEqual(rankCapabilities('scRNA QC', contracts))
  })
})
