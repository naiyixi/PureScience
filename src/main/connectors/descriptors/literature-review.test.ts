import { describe, expect, it, vi } from 'vitest'

import { LITERATURE_REVIEW_TOOLS } from './literature-review'
import type { ToolContext } from '../types'

const arxivFeed = (): string => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2103.14030v1</id>
    <title>Base editing paper</title>
    <summary>Abstract text here</summary>
    <author><name>Alice Researcher</name></author>
    <published>2021-03-25T17:58:29Z</published>
    <updated>2021-03-25T17:58:29Z</updated>
    <link rel="alternate" href="http://arxiv.org/abs/2103.14030v1"/>
    <link rel="related" href="http://arxiv.org/pdf/2103.14030v1"/>
    <category term="q-bio.GN" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`

const openalexBody = (): unknown => ({
  meta: { count: 1 },
  results: [
    {
      id: 'https://openalex.org/W2741809807',
      title: 'Searching and reading',
      publication_year: 2017,
      cited_by_count: 100,
      type: 'article'
    }
  ]
})

const makeContext = (): ToolContext =>
  ({
    fetchJson: vi.fn(async () => openalexBody()),
    fetchText: vi.fn(async () => arxivFeed()),
    fetchJsonWithHeaders: vi.fn(async () => ({ body: openalexBody(), headers: new Headers() })),
    postJson: vi.fn(async () => ({})),
    credentials: {}
  }) as unknown as ToolContext

type ReviewResult = {
  results: Array<{
    query: string
    total_records: number
    records: Array<{ source: string }>
    sources: {
      arxiv: { status: string; n_records_returned: number; api_total: number }
      openalex: { status: string; n_records_returned: number; api_total: number }
    }
  }>
}

describe('literature review tools', () => {
  it('registers exactly one review tool alongside the per-source tools', () => {
    expect(LITERATURE_REVIEW_TOOLS).toHaveLength(1)
    expect(LITERATURE_REVIEW_TOOLS[0]?.id).toBe('literature_review_search')
    expect(LITERATURE_REVIEW_TOOLS[0]?.connector).toBe('literature')
  })

  it('queries both sources in parallel and merges records with source tags', async () => {
    const ctx = makeContext()
    const tool = LITERATURE_REVIEW_TOOLS[0]
    if (!tool?.run) throw new Error('missing run')

    const result = (await tool.run(ctx, { query: 'base editing', max_per_source: 10 })) as ReviewResult

    expect(ctx.fetchText).toHaveBeenCalledTimes(1) // arxiv
    expect(ctx.fetchJson).toHaveBeenCalledTimes(1) // openalex (single page)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.total_records).toBe(2)
    expect(result.results[0]?.records).toHaveLength(2)
    expect(result.results[0]?.records[0]).toMatchObject({ source: 'arxiv' })
    expect(result.results[0]?.records[1]).toMatchObject({ source: 'openalex' })
    expect(result.results[0]?.sources).toMatchObject({
      arxiv: { status: 'ok', n_records_returned: 1, api_total: 1 },
      openalex: { status: 'ok', n_records_returned: 1, api_total: 1 }
    })
  })

  it('runs multiple queries in parallel as independent sub-tasks', async () => {
    const ctx = makeContext()
    const tool = LITERATURE_REVIEW_TOOLS[0]
    if (!tool?.run) throw new Error('missing run')

    const result = (await tool.run(ctx, {
      queries: ['base editing', 'prime editing']
    })) as ReviewResult

    expect(result.results).toHaveLength(2)
    expect(result.results[0]?.query).toBe('base editing')
    expect(result.results[1]?.query).toBe('prime editing')
    expect(result.results[0]?.records).toHaveLength(2)
    expect(result.results[1]?.records).toHaveLength(2)
  })

  it('keeps the other source when one source fails', async () => {
    const ctx = makeContext()
    ;(ctx.fetchText as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('arxiv rate limited')
    )
    const tool = LITERATURE_REVIEW_TOOLS[0]
    if (!tool?.run) throw new Error('missing run')

    const result = (await tool.run(ctx, { query: 'base editing' })) as ReviewResult

    expect(result.results[0]?.sources.arxiv).toMatchObject({ status: 'error' })
    expect(result.results[0]?.sources.openalex).toMatchObject({ status: 'ok' })
    expect(result.results[0]?.records).toHaveLength(1)
    expect(result.results[0]?.records[0]).toMatchObject({ source: 'openalex' })
  })

  it('rejects an empty query and empty queries array', async () => {
    const ctx = makeContext()
    const tool = LITERATURE_REVIEW_TOOLS[0]
    if (!tool?.run) throw new Error('missing run')
    await expect(tool.run(ctx, { query: '  ' })).rejects.toThrow('query or a non-empty')
    await expect(tool.run(ctx, { queries: ['  ', ''] })).rejects.toThrow('query or a non-empty')
  })
})
