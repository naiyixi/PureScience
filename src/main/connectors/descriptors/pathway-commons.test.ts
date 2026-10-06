import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { PATHWAY_COMMONS_TOOLS } from './pathway-commons'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => PATHWAY_COMMONS_TOOLS.find((t) => t.id === id)!

const okJson = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

// Drives the tool through a real ParserEngine with a queue of mocked responses and returns the
// parsed output plus every requested URL.
const run = async (
  args: Record<string, unknown>,
  responses: Response[]
): Promise<{ out: Record<string, unknown>; urls: string[] }> => {
  const fetchImpl = vi.fn()
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r)
  const out = (await new ParserEngine({ fetchImpl }).call(
    tool('search_pathway_commons'),
    args,
    {}
  )) as Record<string, unknown>
  return { out, urls: fetchImpl.mock.calls.map((c) => c[0] as string) }
}

const PC = 'https://www.pathwaycommons.org/pc2'

// Live /search envelope (trimmed to one hit), matching the real 2026-10 response.
const ENVELOPE = {
  numHits: 151,
  maxHitsPerPage: 100,
  pageNo: 0,
  comment: "Search 'TP53' in Pathway; ds: [Reactome]; org.: [9606]",
  version: '14',
  providers: ['Reactome'],
  empty: false,
  searchHit: [
    {
      uri: 'http://bioregistry.io/reactome:R-HSA-9723905',
      biopaxClass: 'Pathway',
      name: 'Loss of function of TP53 in cancer due to loss of tetramerization ability',
      dataSource: ['pc14:reactome'],
      organism: ['http://bioregistry.io/ncbitaxon:9606'],
      numParticipants: 1302,
      numProcesses: 1,
      pathway: ['http://bioregistry.io/reactome:R-HSA-1643685']
    }
  ]
}

describe('genes / search_pathway_commons', () => {
  it('sends q/type/organism/datasource/limit/page and translates service ids', async () => {
    const { out, urls } = await run(
      { query: 'TP53', type: 'Pathway', organism: '9606', datasource: 'Reactome', limit: 2 },
      [okJson(ENVELOPE)]
    )
    expect(urls[0]).toBe(
      `${PC}/search?q=TP53&type=Pathway&format=json&limit=2&page=0&organism=9606&datasource=Reactome`
    )
    expect(out).toEqual({
      query: 'TP53',
      type: 'Pathway',
      page: 0,
      filters: { type: 'Pathway', organism: '9606', datasource: 'Reactome' },
      resource_version: '14',
      service_comment: "Search 'TP53' in Pathway; ds: [Reactome]; org.: [9606]",
      total: 151,
      n_returned: 1,
      max_hits_per_page: 100,
      truncated: true,
      empty: false,
      hits: [
        {
          name: 'Loss of function of TP53 in cancer due to loss of tetramerization ability',
          biopax_class: 'Pathway',
          identifier: 'reactome:R-HSA-9723905',
          uri: 'http://bioregistry.io/reactome:R-HSA-9723905',
          data_sources: ['reactome'],
          organism_taxids: ['9606'],
          num_participants: 1302,
          num_processes: 1,
          parent_pathways: ['reactome:R-HSA-1643685']
        }
      ]
    })
  })

  it('defaults to type Pathway, limit 25, page 0', async () => {
    const { out, urls } = await run({ query: 'apoptosis' }, [
      okJson({ numHits: 0, maxHitsPerPage: 100, pageNo: 0, searchHit: [], empty: true })
    ])
    expect(urls[0]).toBe(`${PC}/search?q=apoptosis&type=Pathway&format=json&limit=25&page=0`)
    expect(out).toMatchObject({ total: 0, n_returned: 0, truncated: false, empty: true, hits: [] })
  })

  it('reads a page past the end as empty without a false truncation', async () => {
    const { out } = await run({ query: 'TP53', limit: 5, page: 99999 }, [
      okJson({ numHits: 162, maxHitsPerPage: 100, pageNo: 99999, searchHit: [], empty: true })
    ])
    expect(out).toMatchObject({
      total: 162,
      n_returned: 0,
      page: 99999,
      empty: true,
      truncated: false
    })
  })

  it('refuses an unknown type before the request (the service answers a bare 400)', async () => {
    await expect(run({ query: 'TP53', type: 'Nonsense' }, [])).rejects.toThrow(
      /Unknown search type "Nonsense"/
    )
  })

  it('refuses a limit above the 100-hit page cap instead of silently clamping', async () => {
    await expect(run({ query: 'TP53', limit: 101 }, [])).rejects.toThrow(
      /limit must be an integer between 1 and 100/
    )
  })

  it('refuses a negative page and an empty query', async () => {
    await expect(run({ query: 'TP53', page: -1 }, [])).rejects.toThrow(/page must be an integer/)
    await expect(run({ query: '   ' }, [])).rejects.toThrow(/query is required/)
  })

  it('registers the tool under the genes connector', () => {
    expect(tool('search_pathway_commons').connector).toBe('genes')
  })
})

// Live self-test against the real Pathway Commons service. Off by default; run with LIVE_API=1.
describe.skipIf(!process.env.LIVE_API)('genes / search_pathway_commons (LIVE)', () => {
  it('returns a real pathway page with a resource version', async () => {
    const out = (await new ParserEngine({ timeoutMs: 120_000 }).call(
      tool('search_pathway_commons'),
      { query: 'TP53', type: 'Pathway', organism: '9606', limit: 3 },
      {}
    )) as Record<string, unknown>
    expect(out.resource_version).toBeTruthy()
    expect(Number(out.total)).toBeGreaterThan(0)
    const hits = out.hits as Array<Record<string, unknown>>
    expect(hits.length).toBeGreaterThan(0)
    expect(String(hits[0]!.identifier)).toBeTruthy()
    expect(String(hits[0]!.name)).toBeTruthy()
  }, 60_000)
})
