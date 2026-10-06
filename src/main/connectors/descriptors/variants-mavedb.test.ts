import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { VARIANTS_MAVEDB_TOOLS } from './variants-mavedb'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => VARIANTS_MAVEDB_TOOLS.find((t) => t.id === id)!

const jsonRes = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    headers: { get: () => null }
  }) as unknown as Response
const engine = (fetchImpl: typeof fetch): ParserEngine =>
  new ParserEngine({ fetchImpl, retries: 0 })

type ScoreSetRow = {
  mavedb_url: string
  num_variants: number
  target_genes: Array<{ accession: string; external_identifiers: Array<{ id: string }> }>
}
type MavedbOut = {
  mode: string
  num_score_sets: number
  n_returned: number
  truncated: boolean
  scores_included: boolean
  score_sets: ScoreSetRow[]
}

const SHORT_SCORE_SET = {
  urn: 'urn:mavedb:00000239-0-1',
  title: '2HBB_con combined scores',
  shortDescription: 'Model combined scores.',
  publishedDate: '2023-07-04',
  numVariants: 1014,
  private: false,
  targetGenes: [
    {
      name: 'HBB',
      category: 'protein_coding',
      targetAccession: { accession: 'ENST00000335295.4', gene: 'HBB' },
      externalIdentifiers: [
        {
          identifier: {
            dbName: 'Ensembl',
            identifier: 'ENSG00000244734',
            url: 'http://www.ensembl.org/id/ENSG00000244734'
          }
        }
      ]
    }
  ],
  primaryPublicationIdentifiers: [
    { dbName: 'PubMed', identifier: '29269382', title: 'A framework.' }
  ],
  license: {
    shortName: 'CC0',
    longName: 'CC0 (Public domain)',
    link: 'https://creativecommons.org/publicdomain/zero/1.0/'
  }
}

describe('mavedb_search_score_sets — search mode', () => {
  it('POSTs the ScoreSetsSearch body and reports numScoreSets as the total', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonRes({ scoreSets: [SHORT_SCORE_SET], numScoreSets: 2819 }))
    const out = (await engine(fetchImpl).call(
      tool('mavedb_search_score_sets'),
      { targets: ['BRCA1'], limit: 5 },
      {}
    )) as MavedbOut

    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://api.mavedb.org/api/v1/score-sets/search')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      offset: 0,
      limit: 5,
      targets: ['BRCA1']
    })
    expect(out.mode).toBe('search')
    expect(out.num_score_sets).toBe(2819)
    expect(out.n_returned).toBe(1)
    expect(out.truncated).toBe(true)
    expect(out.scores_included).toBe(false)
    expect(out.score_sets[0].mavedb_url).toBe(
      'https://www.mavedb.org/#/score-set/urn:mavedb:00000239-0-1/'
    )
    expect(out.score_sets[0].target_genes[0].accession).toBe('ENST00000335295.4')
    expect(out.score_sets[0].target_genes[0].external_identifiers[0].id).toBe('ENSG00000244734')
    expect(out.score_sets[0].num_variants).toBe(1014)
  })
})

describe('mavedb_search_score_sets — urns mode', () => {
  it('GETs the exact URNs (comma-joined) and returns full records', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([SHORT_SCORE_SET]))
    const out = (await engine(fetchImpl).call(
      tool('mavedb_search_score_sets'),
      { urns: ['urn:mavedb:00000001-a-1', 'urn:mavedb:00000239-0-1'] },
      {}
    )) as MavedbOut

    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toBe(
      'https://api.mavedb.org/api/v1/score-sets/?urns=urn%3Amavedb%3A00000001-a-1,urn%3Amavedb%3A00000239-0-1'
    )
    expect(out.mode).toBe('urns')
    expect(out.num_score_sets).toBe(1)
    expect(out.truncated).toBe(false)
  })

  it('rejects an empty urns result by name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([]))
    await expect(
      engine(fetchImpl).call(
        tool('mavedb_search_score_sets'),
        { urns: ['urn:mavedb:00000001-a-1'] },
        {}
      )
    ).rejects.toThrow(/no MaveDB score set found/)
  })
})

describe('mavedb_search_score_sets — guards', () => {
  it('refuses to return the whole catalogue when no filter is given', async () => {
    const fetchImpl = vi.fn()
    await expect(engine(fetchImpl).call(tool('mavedb_search_score_sets'), {}, {})).rejects.toThrow(
      /refusing to return the entire catalogue/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
