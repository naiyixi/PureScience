import { describe, expect, it, vi } from 'vitest'

import { discoverCitations, type FetchLike } from './citation-discovery'

// Payload shapes below are trimmed copies of real OpenAlex answers (2026-10-29): no `message`
// wrapper, `meta.count` on the list endpoint, `primary_location.source.language` sometimes null.
const work = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'https://openalex.org/W2919115771',
  doi: 'https://doi.org/10.1038/nature14539',
  title: 'Deep learning',
  publication_year: 2015,
  language: 'en',
  cited_by_count: 84078,
  referenced_works_count: 2,
  referenced_works: ['https://openalex.org/W146900863', 'https://openalex.org/W170811313'],
  primary_location: { source: { language: null } },
  ...overrides
})

const json = (payload: unknown, status = 200): Awaited<ReturnType<FetchLike>> => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload
})

/** Routes by URL substring so a test names only the answers it cares about. */
const fetchStub = (routes: Array<{ match: string; answer: () => Promise<unknown> }>): FetchLike =>
  vi.fn(async (url: string) => {
    const route = routes.find((entry) => url.includes(entry.match))
    if (!route) throw new Error(`unexpected url: ${url}`)
    return (await route.answer()) as Awaited<ReturnType<FetchLike>>
  })

const doiWork = { match: '/works/doi:', answer: async () => json(work()) }

describe('discoverCitations — citations direction', () => {
  it('returns the citing works with the source total and the number actually read', async () => {
    const citing = Array.from({ length: 3 }, (_, index) => ({
      id: `https://openalex.org/W225797913${index}`,
      doi: 'https://doi.org/10.1038/nature16961',
      title: 'Mastering the game of Go',
      publication_year: 2016,
      language: 'en',
      primary_location: { source: { language: null } }
    }))
    const result = await discoverCitations({
      referenceId: 'ref-1',
      doi: '10.1038/nature14539',
      direction: 'citations',
      fetchImpl: fetchStub([
        doiWork,
        {
          match: 'filter=cites:',
          answer: async () => json({ meta: { count: 83700 }, results: citing })
        }
      ])
    })

    expect(result.status).toBe('found')
    expect(result.total).toBe(83700)
    expect(result.examined).toBe(3)
    expect(result.candidates.map((row) => row.openAlexId)).toEqual([
      'W2257979130',
      'W2257979131',
      'W2257979132'
    ])
    expect(result.candidates[0].sourceUrl).toBe('https://openalex.org/W2257979130')
    expect(result.incomplete).toBe(false)
  })

  it('says "empty" only when the index answered and had nothing', async () => {
    const result = await discoverCitations({
      referenceId: 'ref-1',
      doi: '10.1038/nature14539',
      direction: 'citations',
      fetchImpl: fetchStub([
        doiWork,
        { match: 'filter=cites:', answer: async () => json({ meta: { count: 0 }, results: [] }) }
      ])
    })
    expect(result.status).toBe('empty')
    expect(result.total).toBe(0)
    expect(result.examined).toBe(0)
    expect(result.error).toBeUndefined()
  })

  it('never reads a failed walk as "nothing cites it"', async () => {
    const result = await discoverCitations({
      referenceId: 'ref-1',
      doi: '10.1038/nature14539',
      direction: 'citations',
      fetchImpl: fetchStub([
        doiWork,
        { match: 'filter=cites:', answer: async () => json({ error: 'boom' }, 503) }
      ])
    })
    expect(result.status).toBe('unavailable')
    expect(result.error).toContain('503')
  })

  it('keeps the first page when a later page fails, and marks the read as partial', async () => {
    const pageOne = Array.from({ length: 25 }, (_, index) => ({
      id: `https://openalex.org/W3000000${index}`,
      title: `citing ${index}`
    }))
    let call = 0
    const result = await discoverCitations({
      referenceId: 'ref-1',
      doi: '10.1038/nature14539',
      direction: 'citations',
      fetchImpl: fetchStub([
        doiWork,
        {
          match: 'filter=cites:',
          answer: async () => {
            call += 1
            return call === 1 ? json({ meta: { count: 60 }, results: pageOne }) : json({}, 500)
          }
        }
      ])
    })
    expect(result.status).toBe('found')
    expect(result.examined).toBe(25)
    expect(result.total).toBe(60)
    expect(result.incomplete).toBe(true)
    expect(result.error).toContain('page 2')
  })
})

describe('discoverCitations — references direction', () => {
  it('resolves the cited ids in one batch and names the batch it did not read', async () => {
    const result = await discoverCitations({
      referenceId: 'ref-1',
      doi: '10.1038/nature14539',
      direction: 'references',
      fetchImpl: fetchStub([
        doiWork,
        {
          match: 'filter=openalex_id:',
          answer: async () =>
            json({
              meta: { count: 2 },
              results: [
                {
                  id: 'https://openalex.org/W146900863',
                  doi: 'https://doi.org/10.7551/x',
                  title: 'NIPS'
                },
                { id: 'https://openalex.org/W170811313', title: 'IJCAI' }
              ]
            })
        }
      ])
    })
    expect(result.status).toBe('found')
    expect(result.total).toBe(2)
    expect(result.examined).toBe(2)
    // The record without a DOI keeps its row; it simply has no DOI to show.
    expect(result.candidates[1].doi).toBeUndefined()
    expect(result.incomplete).toBe(false)
  })

  it('marks the walk partial when the work lists more references than two pages hold', async () => {
    const ids = Array.from({ length: 53 }, (_, index) => `https://openalex.org/W900000${index}`)
    const result = await discoverCitations({
      referenceId: 'ref-1',
      doi: '10.1038/nature14539',
      direction: 'references',
      fetchImpl: fetchStub([
        {
          match: '/works/doi:',
          answer: async () =>
            json(work({ referenced_works: ids, referenced_works_count: ids.length }))
        },
        {
          match: 'filter=openalex_id:',
          answer: async () => json({ meta: { count: 25 }, results: [] })
        }
      ])
    })
    expect(result.total).toBe(53)
    expect(result.incomplete).toBe(true)
    expect(result.error).toContain('53 references')
    expect(result.error).toContain('first 50')
  })
})

describe('discoverCitations — refusals before any request', () => {
  it('refuses a record with no DOI and a malformed one without calling the index', async () => {
    const fetchImpl = vi.fn()
    const noDoi = await discoverCitations({
      referenceId: 'ref-1',
      doi: '   ',
      direction: 'citations',
      fetchImpl
    })
    const malformed = await discoverCitations({
      referenceId: 'ref-1',
      doi: 'nature14539',
      direction: 'citations',
      fetchImpl
    })
    expect(noDoi.status).toBe('unavailable')
    expect(noDoi.error).toBe('this record has no DOI')
    expect(malformed.status).toBe('unavailable')
    expect(malformed.error).toBe('this DOI is malformed')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps "the index has no record for this DOI" apart from "nothing cites it"', async () => {
    const result = await discoverCitations({
      referenceId: 'ref-1',
      doi: '10.9999/does-not-exist-xyz',
      direction: 'citations',
      fetchImpl: fetchStub([{ match: '/works/doi:', answer: async () => json({}, 404) }])
    })
    expect(result.status).toBe('unavailable')
    expect(result.error).toContain('404')
  })

  it('reports an unreachable index as unavailable, with the transport message', async () => {
    const result = await discoverCitations({
      referenceId: 'ref-1',
      doi: '10.1038/nature14539',
      direction: 'references',
      fetchImpl: fetchStub([
        {
          match: '/works/doi:',
          answer: async () => {
            throw new Error('UND_ERR_CONNECT_TIMEOUT')
          }
        }
      ])
    })
    expect(result.status).toBe('unavailable')
    expect(result.error).toContain('UND_ERR_CONNECT_TIMEOUT')
  })
})
