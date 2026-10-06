import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { CELLGUIDE_TOOLS } from './cellguide'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => CELLGUIDE_TOOLS.find((t) => t.id === id)!

const jsonRes = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    headers: { get: () => null }
  }) as unknown as Response
const engine = (fetchImpl: typeof fetch): ParserEngine =>
  new ParserEngine({ fetchImpl, retries: 0 })

type ListCollection = {
  collection_id: string
  n_datasets: number
  tissues: string[]
  organisms: string[]
  assays: string[]
}
type ListOut = {
  total_collections: number
  total_matched: number
  returned: number
  truncated: boolean
  collections: ListCollection[]
}
type CollectionOut = {
  n_datasets: number
  cell_count_source: string
  datasets: Array<{
    cell_count: number
    primary_cell_count: number
    tissues: string[]
    sex: string[]
    collection_id: string
  }>
}

// Minimal shape of the /collections catalogue payload (dataset previews carry only
// assay/disease/organism/tissue/suspension_type).
const COLLECTIONS = [
  {
    collection_id: 'c1',
    name: 'Lung Atlas',
    description: 'human lung',
    visibility: 'PUBLIC',
    doi: '10.1/x',
    published_at: '2024-01-01',
    revised_at: '2024-02-01',
    datasets: [
      {
        dataset_id: 'd1',
        assay: [{ label: "10x 3' v3" }],
        disease: [{ label: 'normal' }],
        organism: [{ label: 'Homo sapiens' }],
        tissue: [{ label: 'lung' }]
      },
      {
        dataset_id: 'd2',
        assay: [{ label: 'Smart-seq2' }],
        disease: [],
        organism: [{ label: 'Homo sapiens' }],
        tissue: [{ label: 'lung' }, { label: 'blood' }]
      }
    ]
  },
  {
    collection_id: 'c2',
    name: 'Brain Study',
    description: 'mouse brain',
    visibility: 'PUBLIC',
    datasets: [
      { dataset_id: 'd3', tissue: [{ label: 'brain' }], organism: [{ label: 'Mus musculus' }] }
    ]
  }
]

// Full /collections/{id} record — datasets add cell_count/title/etc.
const COLLECTION_FULL = {
  collection_id: 'af893e86-8e9f-41f1-a474-ef05359b1fb7',
  name: 'X',
  doi: '10.1/y',
  visibility: 'PUBLIC',
  published_at: '2024-03-01',
  revised_at: '2024-04-01',
  consortia: ['CZI Cell Science'],
  contact_name: 'A Curator',
  description: 'full record',
  datasets: [
    {
      dataset_id: 'd1',
      title: 'D1',
      cell_count: 1000,
      primary_cell_count: 900,
      feature_count: 30000,
      mean_genes_per_cell: 2000,
      organism: [{ label: 'Homo sapiens' }],
      tissue: [{ label: 'lung' }],
      disease: [{ label: 'normal' }],
      assay: [{ label: '10x' }],
      suspension_type: ['cell'],
      sex: [{ label: 'male' }],
      self_reported_ethnicity: [{ label: 'Asian' }],
      development_stage: [{ label: 'adult' }],
      donor_id: ['donor1'],
      is_primary_data: true,
      explorer_url: 'https://cellxgene.cziscience.com/e/d1.cxg/'
    }
  ]
}

describe('discover_list_collections', () => {
  it('fetches the PUBLIC catalogue, filters client-side and reports scan/match counts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(COLLECTIONS))
    const out = (await engine(fetchImpl).call(
      tool('discover_list_collections'),
      { query: 'lung' },
      {}
    )) as ListOut

    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/collections?visibility=PUBLIC')
    expect(out.total_collections).toBe(2)
    expect(out.total_matched).toBe(1)
    expect(out.returned).toBe(1)
    expect(out.truncated).toBe(false)
    expect(out.collections[0].collection_id).toBe('c1')
    expect(out.collections[0].n_datasets).toBe(2)
    expect(out.collections[0].tissues).toEqual(['blood', 'lung'])
    expect(out.collections[0].organisms).toEqual(['Homo sapiens'])
    expect(out.collections[0].assays).toEqual(["10x 3' v3", 'Smart-seq2'])
  })

  it('pages the matched set and flags truncation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(COLLECTIONS))
    const out = (await engine(fetchImpl).call(
      tool('discover_list_collections'),
      { limit: 1 },
      {}
    )) as ListOut
    expect(out.total_matched).toBe(2)
    expect(out.returned).toBe(1)
    expect(out.truncated).toBe(true)
  })
})

describe('discover_get_collection', () => {
  it('accepts a URL and returns rich dataset fields with cell_count labelled service_declared', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes(COLLECTION_FULL))
    const out = (await engine(fetchImpl).call(
      tool('discover_get_collection'),
      {
        collection:
          'https://cellxgene.cziscience.com/collections/af893e86-8e9f-41f1-a474-ef05359b1fb7'
      },
      {}
    )) as CollectionOut

    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/collections/af893e86-8e9f-41f1-a474-ef05359b1fb7')
    expect(out.n_datasets).toBe(1)
    expect(out.cell_count_source).toBe('service_declared')
    expect(out.datasets[0].cell_count).toBe(1000)
    expect(out.datasets[0].primary_cell_count).toBe(900)
    expect(out.datasets[0].tissues).toEqual(['lung'])
    expect(out.datasets[0].sex).toEqual(['male'])
    expect(out.datasets[0].collection_id).toBe(COLLECTION_FULL.collection_id)
  })

  it('rejects a non-UUID/URL argument by name without any fetch', async () => {
    const fetchImpl = vi.fn()
    await expect(
      engine(fetchImpl).call(tool('discover_get_collection'), { collection: 'not-a-uuid' }, {})
    ).rejects.toThrow(/not a CELLxGENE Discover collection id or URL/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
