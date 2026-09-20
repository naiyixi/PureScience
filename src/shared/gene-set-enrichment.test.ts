import { describe, expect, it } from 'vitest'

import {
  hypergeometricUpperTail,
  logChoose,
  logGamma,
  runGeneSetEnrichment,
  type EnrichmentTermInput
} from './gene-set-enrichment'

// The engine's whole claim is that the numbers can be checked, so the tests check them against arithmetic
// done another way: exact rational sums with BigInt for the tail probability, and hand-written expectations
// for the correction. A test that merely re-ran the implementation would prove nothing.

// Exact P(X >= k) for X ~ Hypergeometric(N, K, n), by rational arithmetic.
const exactUpperTail = (k: number, N: number, K: number, n: number): number => {
  const choose = (top: number, bottom: number): bigint => {
    if (bottom < 0 || bottom > top) return 0n
    let value = 1n
    for (let index = 0; index < bottom; index += 1) {
      value = (value * BigInt(top - index)) / BigInt(index + 1)
    }
    return value
  }
  const denominator = choose(N, n)
  let numerator = 0n
  for (let hits = k; hits <= Math.min(K, n); hits += 1) {
    numerator += choose(K, hits) * choose(N - K, n - hits)
  }
  return Number(numerator) / Number(denominator)
}

const terms = (): EnrichmentTermInput[] => [
  { term: 'GO:0001', name: 'mitotic checkpoint', genes: ['A', 'B', 'C', 'D'] },
  { term: 'GO:0002', name: 'unrelated process', genes: ['E', 'F', 'G', 'H'] }
]

describe('logGamma and logChoose', () => {
  it('matches exact factorials at small sizes', () => {
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 10)
    expect(logChoose(10, 3)).toBeCloseTo(Math.log(120), 10)
  })

  it('returns negative infinity outside the support', () => {
    expect(logChoose(5, 6)).toBe(Number.NEGATIVE_INFINITY)
    expect(logChoose(5, -1)).toBe(Number.NEGATIVE_INFINITY)
  })
})

describe('hypergeometricUpperTail', () => {
  // The property a hypergeometric tail must have: overlapping nothing is certain, and overlapping the whole
  // term cannot exceed 1.
  it('is 1 for an empty overlap and never above 1', () => {
    expect(hypergeometricUpperTail(0, 20_000, 100, 50)).toBe(1)
    expect(hypergeometricUpperTail(100, 20_000, 100, 50)).toBeLessThanOrEqual(1)
  })

  it('agrees with exact rational arithmetic on a small universe', () => {
    for (const [k, N, K, n] of [
      [1, 10, 5, 3],
      [2, 10, 5, 3],
      [3, 12, 4, 4],
      [4, 20, 8, 6]
    ] as const) {
      expect(hypergeometricUpperTail(k, N, K, n)).toBeCloseTo(exactUpperTail(k, N, K, n), 12)
    }
  })

  // A real-sized enrichment: the tail must stay finite and small rather than underflowing to a false zero.
  it('stays finite where a naive sum would underflow', () => {
    const p = hypergeometricUpperTail(30, 20_000, 200, 50)
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(1e-20)
  })
})

describe('runGeneSetEnrichment', () => {
  const background = {
    kind: 'declared-size' as const,
    size: 20_000,
    description: '人类蛋白编码基因（声明背景大小）'
  }

  it('carries the background and the correction into the result', () => {
    const outcome = runGeneSetEnrichment({
      genes: ['A', 'B', 'C'],
      terms: terms(),
      background,
      correction: 'benjamini-hochberg',
      alpha: 0.05
    })

    expect(outcome.background).toMatchObject({ kind: 'declared-size', size: 20_000, source: 'declared' })
    expect(outcome.correction).toEqual({ method: 'benjamini-hochberg', alpha: 0.05, applied: true })
    expect(outcome.recomputable).toEqual({ method: 'hypergeometric', tail: 'greater', where: 'local' })
    expect(outcome.results.every((row) => Number.isFinite(row.pValue))).toBe(true)
    expect(outcome.summary.zh).toContain('Benjamini–Hochberg')
    expect(outcome.summary.zh).toContain('α=0.05')
  })

  // The correction has to be the corrected value, not the raw p dressed up: BH multiplies the smallest
  // p by m/i and enforces monotonicity, so the two differ whenever more than one term is tested.
  it('reports an adjusted p that differs from the raw one under BH, and equals it under none', () => {
    // Two terms must actually be tested for BH to change anything: with a single tested term the
    // correction is the identity, which is why the query carries a gene from each term here.
    const withCorrection = runGeneSetEnrichment({
      genes: ['A', 'B', 'C', 'E'],
      terms: terms(),
      background,
      correction: 'benjamini-hochberg',
      alpha: 0.05
    })
    const withoutCorrection = runGeneSetEnrichment({
      genes: ['A', 'B', 'C', 'E'],
      terms: terms(),
      background,
      correction: 'none',
      alpha: 0.05
    })

    const corrected = withCorrection.results[0]
    const raw = withoutCorrection.results[0]
    expect(corrected.pValue).toBeCloseTo(raw.pValue, 12)
    expect(corrected.adjustedP).toBeGreaterThan(corrected.pValue)
    expect(raw.adjustedP).toBe(raw.pValue)
    expect(withoutCorrection.correction.applied).toBe(false)
    expect(withoutCorrection.summary.notes.join(' ')).toContain('未做多重检验校正')
  })

  it('keeps the adjusted values monotone (BH never rises as the raw p falls)', () => {
    const outcome = runGeneSetEnrichment({
      genes: ['A', 'B', 'C', 'E'],
      terms: terms(),
      background,
      correction: 'benjamini-hochberg',
      alpha: 0.05
    })
    for (let index = 1; index < outcome.results.length; index += 1) {
      expect(outcome.results[index].adjustedP).toBeGreaterThanOrEqual(
        outcome.results[index - 1].adjustedP
      )
    }
  })

  it('is a Bonferroni correction when that is what was asked for', () => {
    const outcome = runGeneSetEnrichment({
      genes: ['A', 'B', 'C'],
      terms: terms(),
      background,
      correction: 'bonferroni',
      alpha: 0.05
    })
    const row = outcome.results[0]
    expect(row.adjustedP).toBeCloseTo(Math.min(1, row.pValue * outcome.counts.tested), 12)
  })

  it('computes the fold enrichment from the background it was given', () => {
    const outcome = runGeneSetEnrichment({
      genes: ['A', 'B', 'C'],
      terms: [{ term: 'GO:0001', genes: ['A', 'B', 'C', 'D'] }],
      background: { kind: 'declared-size', size: 100, description: '小背景（便于手算）' },
      correction: 'none',
      alpha: 0.05
    })
    // 3/3 query genes in the term, term is 4/100 of the background, so expected = 3 * 4/100 = 0.12.
    expect(outcome.results[0].foldEnrichment).toBeCloseTo(3 / 0.12, 10)
    expect(outcome.results[0].termSize).toBe(4)
  })

  // A user background is used as given, and a query gene outside it is named rather than silently dropped.
  it('narrows the query to a user-supplied background and says how many fell outside', () => {
    const outcome = runGeneSetEnrichment({
      genes: ['A', 'B', 'Z'],
      terms: terms(),
      background: { kind: 'user', genes: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], description: '面板基因' },
      correction: 'none',
      alpha: 0.05
    })

    expect(outcome.background).toMatchObject({ kind: 'user', size: 8, source: 'user' })
    expect(outcome.counts.queryGenes).toBe(3)
    expect(outcome.counts.queryGenesInBackground).toBe(2)
    expect(outcome.counts.queryGenesOutsideBackground).toBe(1)
    expect(outcome.summary.notes.join(' ')).toContain('1 个不在背景集内')
    expect(outcome.results[0].termSize).toBe(4)
  })

  it('counts what it skipped instead of testing everything', () => {
    const outcome = runGeneSetEnrichment({
      genes: ['A'],
      terms: [
        { term: 'GO:0001', genes: ['A', 'B'] },
        { term: 'GO:0002', genes: ['C', 'D'] }
      ],
      background,
      correction: 'none',
      alpha: 0.05,
      minOverlap: 1
    })

    expect(outcome.counts.tested).toBe(1)
    expect(outcome.counts.skippedBelowMinOverlap).toBe(1)
    expect(outcome.summary.notes.join(' ')).toContain('未参与检验')
  })

  it('deduplicates the query and reports how many it removed', () => {
    const outcome = runGeneSetEnrichment({
      genes: ['A', 'A', 'B', ' B '],
      terms: terms(),
      background,
      correction: 'none',
      alpha: 0.05
    })
    expect(outcome.counts.queryGenes).toBe(2)
    expect(outcome.counts.duplicatesInQuery).toBe(2)
    expect(outcome.summary.notes.join(' ')).toContain('重复基因')
  })

  it('orders the results by significance, strongest first', () => {
    const outcome = runGeneSetEnrichment({
      genes: ['A', 'B', 'C', 'E'],
      terms: terms(),
      background,
      correction: 'benjamini-hochberg',
      alpha: 0.05
    })
    expect(outcome.results[0].term).toBe('GO:0001')
    expect(outcome.results[0].overlap).toBe(3)
  })

  // An empty background cannot produce a meaningful p-value, and the result says so rather than printing one.
  it('refuses to present a p-value computed against an empty background', () => {
    const outcome = runGeneSetEnrichment({
      genes: ['A'],
      terms: terms(),
      background: { kind: 'declared-size', size: 0, description: '未给出背景' },
      correction: 'benjamini-hochberg',
      alpha: 0.05
    })
    expect(outcome.summary.notes.join(' ')).toContain('背景集为空')
  })

  it('never claims to have translated a term name', () => {
    const outcome = runGeneSetEnrichment({
      genes: ['A'],
      terms: terms(),
      background,
      correction: 'none',
      alpha: 0.05
    })
    expect(outcome.summary.notes.join(' ')).toContain('未做中文翻译')
    expect(outcome.results[0].name).toBe('mitotic checkpoint')
  })
})
