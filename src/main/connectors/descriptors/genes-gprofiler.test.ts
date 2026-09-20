import { describe, expect, it, vi } from 'vitest'

import { ParserEngine } from '../engine'
import { GENES_GPROFILER_TOOLS } from './genes-gprofiler'

// The claim this tool makes is that an the service does not get to have the last word: whatever it
// returns is recomputed here from the same four integers, and a disagreement is reported. So the tests
// cover the agreement, the disagreement, and the case where the service did not report enough to check.

const jsonRes = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as Response

const tool = (): (typeof GENES_GPROFILER_TOOLS)[number] => {
  const found = GENES_GPROFILER_TOOLS.find((candidate) => candidate.id === 'gene_set_enrichment')
  if (!found) throw new Error('gene_set_enrichment is missing')
  return found
}

const run = (args: Record<string, unknown>, fetchImpl?: ReturnType<typeof vi.fn>): Promise<unknown> =>
  new ParserEngine({
    fetchImpl: (fetchImpl ?? vi.fn()) as unknown as typeof fetch,
    retries: 0
  }).call(tool(), args, {})

// The service p-value in this test is computed independently, by exact rational arithmetic, so the
// agreement check compares two different implementations rather than one implementation with itself.
const exactUpperTail = (k: number, N: number, K: number, n: number): number => {
  const choose = (top: number, bottom: number): bigint => {
    if (bottom < 0 || bottom > top) return 0n
    let value = 1n
    for (let index = 0; index < bottom; index += 1) {
      value = (value * BigInt(top - index)) / BigInt(index + 1)
    }
    return value
  }
  let numerator = 0n
  for (let hits = k; hits <= Math.min(K, n); hits += 1) {
    numerator += choose(K, hits) * choose(N - K, n - hits)
  }
  return Number(numerator) / Number(choose(N, n))
}

// A universe small enough for the exact value to be computed above, and the value the service row reports.
const SERVICE_FIGURES = { k: 4, N: 200, K: 20, n: 10 }
const SERVICE_P = exactUpperTail(
  SERVICE_FIGURES.k,
  SERVICE_FIGURES.N,
  SERVICE_FIGURES.K,
  SERVICE_FIGURES.n
)

describe('genes gene_set_enrichment — offline mode', () => {
  it('computes the enrichment locally, without any network call', async () => {
    const fetchImpl = vi.fn()
    const result = (await run(
      {
        genes: ['A', 'B', 'C'],
        annotation: [
          { term: 'GO:1', name: 'mitotic checkpoint', genes: ['A', 'B', 'C', 'D'] },
          { term: 'GO:2', name: 'other', genes: ['E', 'F'] }
        ],
        background_size: 100,
        correction: 'benjamini-hochberg',
        alpha: 0.05
      },
      fetchImpl
    )) as Record<string, unknown>

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.mode).toBe('offline')
    expect(result.network).toBe(false)
    expect(result.background).toMatchObject({ kind: 'declared-size', size: 100, source: 'declared' })
    expect(result.correction).toEqual({ method: 'benjamini-hochberg', alpha: 0.05, applied: true })
    const results = result.results as Array<Record<string, unknown>>
    expect(results[0]).toMatchObject({ term: 'GO:1', overlap: 3, termSize: 4 })
    expect(String((result.summary as { zh: string }).zh)).toContain('Benjamini–Hochberg')
  })

  it('uses a caller background as given and names the query genes outside it', async () => {
    const result = (await run({
      genes: ['A', 'B', 'Z'],
      annotation: [{ term: 'GO:1', genes: ['A', 'B', 'C', 'D'] }],
      background_genes: ['A', 'B', 'C', 'D', 'E'],
      correction: 'none'
    })) as Record<string, unknown>

    expect(result.background).toMatchObject({ kind: 'user', size: 5, source: 'user' })
    expect((result.counts as Record<string, number>).queryGenesOutsideBackground).toBe(1)
    expect((result.summary as { notes: string[] }).notes.join(' ')).toContain('未做多重检验校正')
  })
})

describe('genes gene_set_enrichment — service mode', () => {
  const serviceRow = {
    native: 'GO:0000278',
    name: 'mitotic cell cycle',
    source: 'GO:BP',
    p_value: SERVICE_P,
    term_size: SERVICE_FIGURES.K,
    query_size: SERVICE_FIGURES.n,
    intersection_size: SERVICE_FIGURES.k,
    effective_domain_size: SERVICE_FIGURES.N,
    significant: true
  }

  it('recomputes every returned term and records agreement', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ result: [serviceRow] }))
    const result = (await run({ genes: ['A', 'B', 'C'], alpha: 0.05 }, fetchImpl)) as Record<string, unknown>

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      { method?: string; body?: string }
    ]
    expect(url).toContain('gprofiler')
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(sent).toMatchObject({
      organism: 'hsapiens',
      user_threshold: 0.05,
      significance_threshold_method: 'fdr'
    })
    expect(sent.query).toEqual(['A', 'B', 'C'])

    const results = result.results as Array<Record<string, unknown>>
    expect(results[0].recomputed).toBe(true)
    // The local value comes from our own hypergeometric; the service one is only a number to compare with.
    const local = Number(results[0].p_value_local)
    expect(local).toBeGreaterThan(0)
    // The local value must match the independently computed one: both are the same tail probability.
    expect(local).toBeCloseTo(SERVICE_P, 9)
    expect(result.mismatches).toEqual([])
    expect(String((result.summary as { zh: string }).zh)).toContain('1 个一致')
  })

  // A service whose p-value does not match its own reported counts is reported, not swallowed.
  it('flags a row whose service p-value disagrees with the local recomputation', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ result: [{ ...serviceRow, p_value: 0.42 }] })
    )
    const result = (await run({ genes: ['A', 'B', 'C'] }, fetchImpl)) as Record<string, unknown>

    expect((result.mismatches as unknown[]).length).toBe(1)
    expect(String((result.summary as { zh: string }).zh)).toContain('1 个不一致')
  })

  it('says it cannot recompute when the service omitted the sizes', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ result: [{ native: 'GO:1', name: 'x', p_value: 0.01 }] })
    )
    const result = (await run({ genes: ['A'] }, fetchImpl)) as Record<string, unknown>

    const results = result.results as Array<Record<string, unknown>>
    expect(results[0].recomputed).toBe(false)
    expect(results[0].agrees).toBe(false)
    expect((result.summary as { notes: string[] }).notes.join(' ')).toContain('本地无法复算')
  })

  it('submits a caller background as a custom domain scope and says the background was theirs', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ result: [] }))
    const result = (await run(
      { genes: ['A'], background_genes: ['A', 'B', 'C'] },
      fetchImpl
    )) as Record<string, unknown>

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, { body?: string }]
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(sent).toMatchObject({ domain_scope: 'custom', background: ['A', 'B', 'C'] })
    expect(result.background).toMatchObject({ kind: 'user', size: 3, source: 'user' })
    expect((result.summary as { notes: string[] }).notes.join(' ')).toContain('domain_scope=custom')
  })

  it('says when it fell back to the service default background rather than the caller’s', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ result: [] }))
    const result = (await run({ genes: ['A'] }, fetchImpl)) as Record<string, unknown>
    expect(result.background).toMatchObject({ kind: 'service-default', size: null })
    expect((result.summary as { notes: string[] }).notes.join(' ')).toContain('默认注释域')
  })
})
