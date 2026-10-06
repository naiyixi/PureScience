import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { GENES_MONARCH_TOOLS } from './genes-monarch'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => GENES_MONARCH_TOOLS.find((t) => t.id === id)!

const jsonRes = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    headers: { get: () => null }
  }) as unknown as Response
const engine = (fetchImpl: typeof fetch): ParserEngine =>
  new ParserEngine({ fetchImpl, retries: 0 })

type AssocOut = {
  total: number
  n_returned: number
  truncated: boolean
  associations: Array<{
    subject_label: string
    has_evidence: string[]
    primary_knowledge_source: string
  }>
}

// Shape captured live from /v3/api/association (DiseaseToPhenotypicFeatureAssociation).
const ASSOC = {
  limit: 5,
  offset: 0,
  total: 181,
  items: [
    {
      id: 'uuid:8d8eb79e',
      category: 'biolink:DiseaseToPhenotypicFeatureAssociation',
      predicate: 'biolink:has_phenotype',
      subject: 'MONDO:0007947',
      subject_label: 'Marfan syndrome',
      object: 'HP:0000768',
      object_label: 'Pectus carinatum',
      publications: ['PMID:123'],
      has_evidence: ['ECO:0000304'],
      frequency_qualifier: 'HP:0040281',
      frequency_qualifier_label: 'Very frequent',
      onset_qualifier: null,
      negated: false,
      primary_knowledge_source: 'infores:orphanet',
      aggregator_knowledge_source: ['infores:monarchinitiative', 'infores:hpo-annotations'],
      knowledge_level: 'knowledge_assertion',
      evidence_count: 3
    }
  ],
  facet_fields: []
}

describe('monarch_phenotype_associations', () => {
  it('query by subject, encodes the CURIEs and reports total vs returned', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(ASSOC))
    const out = (await engine(fetchImpl).call(
      tool('monarch_phenotype_associations'),
      { subject: 'MONDO:0007947', limit: 5 },
      {}
    )) as AssocOut

    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('category=biolink%3ADiseaseToPhenotypicFeatureAssociation')
    expect(url).toContain('subject=MONDO%3A0007947')
    expect(url).toContain('limit=5')
    expect(out.total).toBe(181)
    expect(out.n_returned).toBe(1)
    expect(out.truncated).toBe(true)
    expect(out.associations[0].subject_label).toBe('Marfan syndrome')
    expect(out.associations[0].has_evidence).toEqual(['ECO:0000304'])
    expect(out.associations[0].primary_knowledge_source).toBe('infores:orphanet')
  })

  it('allows querying by object alone (a phenotype CURIE)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ ...ASSOC, total: 0, items: [] }))
    const out = (await engine(fetchImpl).call(
      tool('monarch_phenotype_associations'),
      { object: 'HP:0000768', category: 'biolink:GeneToPhenotypicFeatureAssociation' },
      {}
    )) as AssocOut
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('object=HP%3A0000768')
    expect(out.truncated).toBe(false)
  })

  it('requires at least one of subject/object', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(tool('monarch_phenotype_associations'), {}, {})
    ).rejects.toThrow(/at least one of subject/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an unknown category by name without a fetch', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(
        tool('monarch_phenotype_associations'),
        { subject: 'MONDO:0007947', category: 'biolink:GeneToDiseaseAssociation' },
        {}
      )
    ).rejects.toThrow(/unknown phenotype association category/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
