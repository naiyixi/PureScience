import { describe, expect, it, vi } from 'vitest'

import {
  checkDoiIntegrity,
  normalizeDoi,
  type DoiIntegrityCheck,
  type FetchLike
} from './doi-integrity'

const NOW = new Date('2026-10-28T00:00:00.000Z')

const stubFetch = (body: unknown, status = 200): FetchLike =>
  vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async (): Promise<unknown> => body
  }))

const check = (doi: string, fetchImpl: FetchLike): Promise<DoiIntegrityCheck> =>
  checkDoiIntegrity(doi, { fetchImpl, now: () => NOW })

// Two requests now decide a clean verdict (the record, then the reverse "who updates this" query), so the
// stub answers by URL: a single-body stub would silently answer the follow-up with the first payload.
const stubFetchByUrl = (
  routes: Array<{ match: string; body: unknown; status?: number }>
): FetchLike =>
  vi.fn(async (url: string) => {
    const route = routes.find((candidate) => url.includes(candidate.match))
    const status = route?.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async (): Promise<unknown> => route?.body ?? {}
    }
  })

describe('DOI integrity check', () => {
  it('normalizes the shapes a citation actually carries', () => {
    expect(normalizeDoi('https://doi.org/10.1000/ABC')).toBe('10.1000/abc')
    expect(normalizeDoi('doi: 10.1000/xyz')).toBe('10.1000/xyz')
    expect(normalizeDoi('  10.1000/Keep  ')).toBe('10.1000/keep')
  })

  // The verdict that matters most: the paper a reference points at was retracted. Both directions of
  // Crossref's bookkeeping must be understood, because a library entry can point at either record.
  it('reports a retraction recorded on the work itself', async () => {
    const result = await check(
      '10.1000/retracted',
      stubFetch({
        message: {
          DOI: '10.1000/retracted',
          relation: { 'is-retracted-by': [{ id: '10.1000/notice' }] }
        }
      })
    )

    expect(result.status).toBe('retracted')
    expect(result.notices).toEqual([
      { kind: 'retraction', doi: '10.1000/notice', url: 'https://doi.org/10.1000/notice' }
    ])
    expect(result.checkedAt).toBe(NOW.toISOString())
    expect(result.sourceUrl).toBe('https://api.crossref.org/works/10.1000%2Fretracted')
  })

  it('reports a notice DOI as the notice it is', async () => {
    const result = await check(
      '10.1000/notice',
      stubFetch({
        message: {
          DOI: '10.1000/notice',
          'update-to': [{ type: 'retraction', DOI: '10.1000/old' }]
        }
      })
    )

    expect(result.status).toBe('retracted')
    expect(result.notices[0]).toMatchObject({ kind: 'retraction', doi: '10.1000/old' })
  })

  it('ranks retraction above correction and expression of concern', async () => {
    const result = await check(
      '10.1000/mixed',
      stubFetch({
        message: {
          relation: {
            'is-corrected-by': [{ id: '10.1000/corr' }],
            'is-expression-of-concern-for': [{ id: '10.1000/eoc' }],
            'is-retracted-by': [{ id: '10.1000/ret' }]
          }
        }
      })
    )
    expect(result.status).toBe('retracted')
    expect(result.notices).toHaveLength(3)
  })

  it('says corrected, not retracted, when a correction is all there is', async () => {
    const result = await check(
      '10.1000/corrected',
      stubFetch({ message: { relation: { 'is-corrected-by': [{ id: '10.1000/corr' }] } } })
    )
    expect(result.status).toBe('corrected')
  })

  it('returns clean only when Crossref actually said so', async () => {
    const result = await check('10.1000/clean', stubFetch({ message: { DOI: '10.1000/clean' } }))
    expect(result.status).toBe('clean')
    expect(result.notices).toEqual([])
    expect(result.error).toBeUndefined()
  })

  // The honesty rule: an unreachable registry must never read as "no retraction found".
  it('is unavailable — never clean — when the lookup fails', async () => {
    const http404 = await check('10.1000/missing', stubFetch({}, 404))
    expect(http404.status).toBe('unavailable')
    expect(http404.error).toContain('404')

    const noMessage = await check('10.1000/odd', stubFetch({}))
    expect(noMessage.status).toBe('unavailable')

    const threw = await check(
      '10.1000/offline',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND api.crossref.org')
      }) as unknown as FetchLike
    )
    expect(threw.status).toBe('unavailable')
    expect(threw.error).toContain('ENOTFOUND')
  })

  it('rejects an empty DOI without calling the network', async () => {
    const fetchImpl = stubFetch({ message: {} })
    const result = await check('   ', fetchImpl)
    expect(result.status).toBe('unavailable')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('ignores relation entries it cannot attribute a DOI to', async () => {
    const result = await check(
      '10.1000/noisy',
      stubFetch({
        message: {
          relation: { 'is-retracted-by': [{ id: 42 }, {}], 'is-supplemented-by': [{ id: 'x' }] }
        }
      })
    )
    expect(result.status).toBe('clean')
  })

  // The measured reality (2026-10-28): most retracted works carry nothing on their own record. These four
  // cases are the ones that must fire, and each verdict says which field fired.
  it('finds the retraction through the reverse query when the record itself is silent', async () => {
    const result = await check(
      '10.1000/silent',
      stubFetchByUrl([
        {
          match: 'filter=updates:',
          body: {
            message: {
              items: [
                {
                  DOI: '10.1000/notice-a',
                  'update-to': [{ type: 'retraction', DOI: '10.1000/silent' }]
                },
                // A notice for a different work must not be attributed to this one.
                {
                  DOI: '10.1000/notice-b',
                  'update-to': [{ type: 'retraction', DOI: '10.1000/other' }]
                }
              ]
            }
          }
        },
        { match: '/works/', body: { message: { DOI: '10.1000/silent', title: ['A study'] } } }
      ])
    )

    expect(result.status).toBe('retracted')
    expect(result.evidence).toBe('reverse-update')
    expect(result.notices).toEqual([
      { kind: 'retraction', doi: '10.1000/notice-a', url: 'https://doi.org/10.1000/notice-a' }
    ])
  })

  it('reads the publisher’s own retraction label in the title', async () => {
    const result = await check(
      '10.1000/labelled',
      stubFetchByUrl([
        { match: 'filter=updates:', body: { message: { items: [] } } },
        {
          match: '/works/',
          body: {
            message: {
              DOI: '10.1000/labelled',
              title: ['RETRACTED: Ileal-lymphoid-nodular hyperplasia, non-specific colitis']
            }
          }
        }
      ])
    )

    expect(result.status).toBe('retracted')
    expect(result.evidence).toBe('title-label')
    expect(result.notices[0].doi).toBe('10.1000/labelled')
  })

  it('distinguishes an expression-of-concern label from a retraction label', async () => {
    const result = await check(
      '10.1000/concern',
      stubFetchByUrl([
        { match: 'filter=updates:', body: { message: { items: [] } } },
        {
          match: '/works/',
          body: { message: { DOI: '10.1000/concern', title: ['Expression of Concern: a trial'] } }
        }
      ])
    )

    expect(result.status).toBe('expression-of-concern')
    expect(result.evidence).toBe('title-label')
  })

  // A paper *about* retractions mentions the word mid-title; only an anchored label may fire.
  it('does not treat a mid-title mention of retraction as a retraction', async () => {
    const result = await check(
      '10.1000/about',
      stubFetchByUrl([
        { match: 'filter=updates:', body: { message: { items: [] } } },
        {
          match: '/works/',
          body: {
            message: { DOI: '10.1000/about', title: ['How retracted papers keep being cited'] }
          }
        }
      ])
    )

    expect(result.status).toBe('clean')
    expect(result.evidence).toBe('none')
  })

  it('names the field that decided a verdict on the record itself', async () => {
    const viaRelation = await check(
      '10.1000/rel',
      stubFetch({ message: { relation: { 'is-retracted-by': [{ id: '10.1000/n1' }] } } })
    )
    expect(viaRelation.evidence).toBe('relation')

    const viaUpdateTo = await check(
      '10.1000/notice',
      stubFetch({ message: { 'update-to': [{ type: 'retraction', DOI: '10.1000/old' }] } })
    )
    expect(viaUpdateTo.evidence).toBe('update-to')
  })

  it('counts one notice once when two fields name the same one', async () => {
    const result = await check(
      '10.1000/both',
      stubFetch({
        message: {
          relation: { 'is-retracted-by': [{ id: '10.1000/same' }] },
          'update-to': [{ type: 'retraction', DOI: '10.1000/same' }]
        }
      })
    )
    expect(result.notices).toHaveLength(1)
    expect(result.evidence).toBe('relation')
  })

  // The reverse query failing is not "no notices found": the record stays unavailable, never clean.
  it('is unavailable — never clean — when the reverse query fails', async () => {
    const failed = await check(
      '10.1000/half',
      stubFetchByUrl([
        { match: 'filter=updates:', body: {}, status: 500 },
        { match: '/works/', body: { message: { DOI: '10.1000/half', title: ['A study'] } } }
      ])
    )

    expect(failed.status).toBe('unavailable')
    expect(failed.status).not.toBe('clean')
    expect(failed.error).toContain('500')

    const threw = await check(
      '10.1000/half',
      vi.fn(async (url: string) => {
        if (url.includes('filter=updates:')) throw new Error('socket hang up')
        return {
          ok: true,
          status: 200,
          json: async (): Promise<unknown> => ({ message: { DOI: '10.1000/half' } })
        }
      }) as unknown as FetchLike
    )
    expect(threw.status).toBe('unavailable')
    expect(threw.error).toContain('socket hang up')
  })
})
