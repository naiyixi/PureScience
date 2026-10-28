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
})
