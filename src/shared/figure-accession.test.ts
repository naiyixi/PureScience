import { describe, expect, it } from 'vitest'

import {
  accessionLookupUrl,
  shapeAccessionLookup,
  shapeAlphafoldPrediction,
  shapePdbeSummary
} from './figure-accession'

// 夹具取自**真实响应**（本机直取，见 PRX009/U4-b 的读数）：PDBe `/summary/1crn` 与 AlphaFold
// `/prediction/P00533`。值原样，只裁掉这份用例不检查的长字段。
const PDBE_1CRN = {
  '1crn': [
    {
      title: 'WATER STRUCTURE OF A HYDROPHOBIC PROTEIN AT ATOMIC RESOLUTION',
      release_date: '19810728',
      experimental_method: ['X-ray diffraction'],
      experimental_method_class: ['x-ray'],
      entry_authors: ['Hendrickson W.A.']
    }
  ]
}

const ALPHAFOLD_P00533 = [
  {
    modelEntityId: 'AF-P00533-F1',
    toolUsed: 'AlphaFold Monomer v2.0 pipeline',
    modelCreatedDate: '2025-08-01T00:00:00Z',
    isUniProt: true,
    entityType: 'protein'
  }
]

describe('accessionLookupUrl', () => {
  it('names the endpoint each accession kind is answered by', () => {
    expect(accessionLookupUrl({ kind: 'pdb', id: '1CRN', where: 'in-figure-text' })).toBe(
      'https://www.ebi.ac.uk/pdbe/api/pdb/entry/summary/1crn'
    )
    expect(accessionLookupUrl({ kind: 'uniprot', id: 'P00533', where: 'caption' })).toBe(
      'https://alphafold.ebi.ac.uk/api/prediction/P00533'
    )
  })
})

describe('shapePdbeSummary', () => {
  it('shapes a real entry and leaves out what the service did not give', () => {
    const outcome = shapePdbeSummary(PDBE_1CRN, '1CRN')
    expect(outcome.state).toBe('resolved')
    if (outcome.state !== 'resolved') return
    const [record] = outcome.records
    expect(record).toEqual({
      id: '1crn', // 响应里没有 pdb_id ⇒ 用请求的 id（小写），不编一个
      basis: 'experimental',
      source: 'pdbe',
      title: 'WATER STRUCTURE OF A HYDROPHOBIC PROTEIN AT ATOMIC RESOLUTION',
      method: 'X-ray diffraction',
      date: '19810728'
    })
    // 这份响应里**没有** resolution —— 缺席就是缺席，不补 0、不补 null。
    expect('resolutionAngstroms' in record).toBe(false)
  })

  it('answers "not found" when the service returns an empty entry list', () => {
    expect(shapePdbeSummary({ '1crn': [] }, '1CRN')).toEqual({ state: 'not-found', id: '1CRN' })
  })

  it('answers "unavailable" — not "not found" — when the service did not answer JSON', () => {
    expect(shapePdbeSummary('<html>', '1CRN')).toEqual({
      state: 'unavailable',
      id: '1CRN',
      reason: 'the entry service did not answer JSON'
    })
  })
})

describe('shapeAlphafoldPrediction', () => {
  it('shapes a prediction and says it is predicted, not experimental', () => {
    const outcome = shapeAlphafoldPrediction(ALPHAFOLD_P00533, 'P00533')
    expect(outcome.state).toBe('resolved')
    if (outcome.state !== 'resolved') return
    expect(outcome.records[0]).toEqual({
      id: 'AF-P00533-F1',
      basis: 'predicted',
      source: 'alphafold-db',
      method: 'AlphaFold Monomer v2.0 pipeline',
      date: '2025-08-01T00:00:00Z'
    })
  })

  it('answers "not found" when the prediction list is empty and "unavailable" when it is not a list', () => {
    expect(shapeAlphafoldPrediction([], 'P00533')).toEqual({ state: 'not-found', id: 'P00533' })
    expect(shapeAlphafoldPrediction({ error: 'nope' }, 'P00533')).toEqual({
      state: 'unavailable',
      id: 'P00533',
      reason: 'the prediction service did not answer a list'
    })
  })
})

describe('shapeAccessionLookup', () => {
  it('routes each kind to its own shaper', () => {
    const pdb = shapeAccessionLookup({ kind: 'pdb', id: '1CRN', where: 'caption' }, PDBE_1CRN)
    const uniprot = shapeAccessionLookup(
      { kind: 'uniprot', id: 'P00533', where: 'caption' },
      ALPHAFOLD_P00533
    )
    expect(pdb.state).toBe('resolved')
    expect(uniprot.state).toBe('resolved')
    if (pdb.state !== 'resolved' || uniprot.state !== 'resolved') return
    expect(pdb.records[0].source).toBe('pdbe')
    expect(uniprot.records[0].source).toBe('alphafold-db')
  })
})
