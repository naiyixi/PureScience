import { describe, expect, it } from 'vitest'

import {
  SCREENING_NAMED_REASONS,
  SCREENING_VERDICTS,
  type ScreeningEvidenceCoverage,
  type ScreeningNamedReason,
  type ScreeningVerdict
} from '../../shared/references-screening'
import {
  SCREENING_DEFAULT_INPUT_CHAR_BUDGET,
  applyEvidenceCoverage,
  coverageBlocksVerdict,
  evaluateScreeningFreshness,
  resolveEffectiveDecision,
  summarizeScreeningCoverage,
  type ScreeningCoverageEntry,
  type ScreeningFreshnessInput
} from './screening-freshness'

// The decision semantics of screening are pure, so every rule the plan states is asserted directly here
// rather than through a database: the six named reasons, freshness = the three-key identity, the review
// bucket as uncertain ∪ stale, and the rule that decides the whole feature's credibility —
// 拿不到全文 ⇒ 不确定，绝不 excluded.

const COVERAGES: readonly ScreeningEvidenceCoverage[] = [
  'full-text',
  'abstract-only',
  'metadata-only',
  'unavailable'
]

const currentIdentity = (
  overrides: Partial<ScreeningFreshnessInput['current']> = {}
): ScreeningFreshnessInput['current'] => ({
  ruleRevision: 4,
  inputDigest: 'digest-a',
  policyKey: 'policy-v1',
  evidenceCoverage: 'full-text',
  inputChars: 1_000,
  inputCharBudget: SCREENING_DEFAULT_INPUT_CHAR_BUDGET,
  ...overrides
})

const stored = (
  verdict: ScreeningVerdict,
  identity: Partial<ScreeningFreshnessInput['current']> = {}
): NonNullable<ScreeningFreshnessInput['stored']> => ({
  identity: {
    ruleRevision: identity.ruleRevision ?? 4,
    inputDigest: identity.inputDigest ?? 'digest-a',
    policyKey: identity.policyKey ?? 'policy-v1'
  },
  verdict
})

const freshnessFor = (
  storedValue: ScreeningFreshnessInput['stored'],
  currentOverrides: Partial<ScreeningFreshnessInput['current']> = {}
): ReturnType<typeof evaluateScreeningFreshness> =>
  evaluateScreeningFreshness({ stored: storedValue, current: currentIdentity(currentOverrides) })

describe('the named reasons are a closed set', () => {
  it('exposes exactly the six reasons the verdicts can point at', () => {
    expect([...SCREENING_NAMED_REASONS]).toEqual([
      'rule-changed',
      'input-changed',
      'model-changed',
      'missing-evidence',
      'input-too-long',
      'uncertain'
    ])
  })

  it('never reports a reason outside that set, and never repeats one', () => {
    const matrix: ScreeningFreshnessInput[] = []
    for (const verdict of SCREENING_VERDICTS) {
      for (const coverage of COVERAGES) {
        for (const chars of [10, SCREENING_DEFAULT_INPUT_CHAR_BUDGET + 1]) {
          for (const identity of [
            currentIdentity(),
            currentIdentity({ ruleRevision: 5, inputDigest: 'other', policyKey: 'policy-v2' })
          ]) {
            matrix.push({
              stored: stored(verdict, identity),
              current: { ...currentIdentity({ evidenceCoverage: coverage, inputChars: chars }) }
            })
            matrix.push({
              stored: null,
              current: { ...currentIdentity({ evidenceCoverage: coverage, inputChars: chars }) }
            })
          }
        }
      }
    }

    const reasons = matrix.flatMap((input) => evaluateScreeningFreshness(input).reasons)
    expect(reasons.length).toBeGreaterThan(0)
    for (const reason of reasons) {
      expect(SCREENING_NAMED_REASONS).toContain(reason as ScreeningNamedReason)
    }
    for (const input of matrix) {
      const { reasons: reported } = evaluateScreeningFreshness(input)
      expect(new Set(reported).size).toBe(reported.length)
    }
  })
})

describe('freshness = ruleRevision ∧ inputDigest ∧ policyKey', () => {
  it('is current with no reasons when all three match', () => {
    const freshness = freshnessFor(stored('included'))
    expect(freshness).toEqual({ current: true, reasons: [], stale: false, review: false })
  })

  it('names each moved identity key and marks the decision stale', () => {
    const ruleChanged = freshnessFor(stored('included'), { ruleRevision: 5 })
    expect(ruleChanged.reasons).toEqual(['rule-changed'])
    expect(ruleChanged).toMatchObject({ current: false, stale: true, review: true })

    const inputChanged = freshnessFor(stored('included'), { inputDigest: 'digest-b' })
    expect(inputChanged.reasons).toEqual(['input-changed'])
    expect(inputChanged).toMatchObject({ current: false, stale: true, review: true })

    const modelChanged = freshnessFor(stored('included'), { policyKey: 'policy-v2' })
    expect(modelChanged.reasons).toEqual(['model-changed'])
    expect(modelChanged).toMatchObject({ current: false, stale: true, review: true })
  })

  it('reports all three in a stable order when every key moved', () => {
    const freshness = freshnessFor(stored('excluded'), {
      ruleRevision: 9,
      inputDigest: 'digest-z',
      policyKey: 'policy-v9'
    })
    expect(freshness.reasons).toEqual(['rule-changed', 'input-changed', 'model-changed'])
    expect(freshness.current).toBe(false)
  })

  it('treats an unassessed reference as unprocessed, not as stale, and names missing evidence', () => {
    const unassessed = freshnessFor(null)
    expect(unassessed).toEqual({ current: false, reasons: [], stale: false, review: false })

    const noEvidence = freshnessFor(null, { evidenceCoverage: 'unavailable' })
    expect(noEvidence.reasons).toEqual(['missing-evidence'])
    expect(noEvidence).toMatchObject({ current: false, stale: false, review: false })
  })

  it('defers an over-budget input with input-too-long, and only past the budget', () => {
    const atBudget = freshnessFor(stored('included'), {
      inputChars: SCREENING_DEFAULT_INPUT_CHAR_BUDGET
    })
    expect(atBudget.reasons).toEqual([])

    const overBudget = freshnessFor(stored('included'), {
      inputChars: SCREENING_DEFAULT_INPUT_CHAR_BUDGET + 1
    })
    expect(overBudget.reasons).toEqual(['input-too-long'])
    // Over budget defers a pass; it does not by itself make an existing decision wrong.
    expect(overBudget).toMatchObject({ current: true, stale: false, review: false })
  })
})

describe('the review bucket is exactly uncertain ∪ stale', () => {
  it('covers the four verdicts across current and stale decisions', () => {
    const cases: Array<{
      label: string
      input: ScreeningFreshnessInput
      review: boolean
    }> = [
      {
        label: 'included, current',
        input: { stored: stored('included'), current: currentIdentity() },
        review: false
      },
      {
        label: 'needs-review, current (uncertain)',
        input: { stored: stored('needs-review'), current: currentIdentity() },
        review: true
      },
      {
        label: 'excluded, stale (rule changed)',
        input: { stored: stored('excluded'), current: currentIdentity({ ruleRevision: 5 }) },
        review: true
      },
      {
        label: 'not-evaluated (unprocessed)',
        input: { stored: null, current: currentIdentity() },
        review: false
      },
      {
        label: 'included, current but evidence downgraded to metadata-only',
        input: {
          stored: stored('included'),
          current: currentIdentity({ evidenceCoverage: 'metadata-only' })
        },
        review: true
      }
    ]

    for (const testCase of cases) {
      expect(evaluateScreeningFreshness(testCase.input).review, testCase.label).toBe(
        testCase.review
      )
    }
  })

  it('marks uncertain on its own, without calling a current decision stale', () => {
    const freshness = freshnessFor(stored('needs-review'))
    expect(freshness.reasons).toEqual(['uncertain'])
    expect(freshness).toMatchObject({ current: true, stale: false, review: true })
  })
})

describe('evidence coverage: 拿不到全文 ⇒ 不确定，绝不 excluded', () => {
  it('licenses every verdict only on full text', () => {
    for (const verdict of SCREENING_VERDICTS) {
      expect(applyEvidenceCoverage(verdict, 'full-text')).toEqual({
        verdict,
        degraded: false,
        reason: null
      })
    }
  })

  it('degrades anything but a not-yet-decided verdict to needs-review without full text', () => {
    for (const coverage of ['abstract-only', 'metadata-only'] as const) {
      expect(applyEvidenceCoverage('included', coverage)).toEqual({
        verdict: 'needs-review',
        degraded: true,
        reason: 'missing-evidence'
      })
      expect(applyEvidenceCoverage('excluded', coverage)).toEqual({
        verdict: 'needs-review',
        degraded: true,
        reason: 'missing-evidence'
      })
      // Already uncertain: nothing to degrade, but the reason still names why.
      expect(applyEvidenceCoverage('needs-review', coverage)).toEqual({
        verdict: 'needs-review',
        degraded: false,
        reason: 'missing-evidence'
      })
    }
  })

  it('keeps a record with no evidence unprocessed rather than uncertain', () => {
    for (const verdict of ['included', 'excluded', 'needs-review'] as const) {
      const guarded = applyEvidenceCoverage(verdict, 'unavailable')
      expect(guarded).toEqual({
        verdict: 'not-evaluated',
        degraded: true,
        reason: 'missing-evidence'
      })
    }
    expect(applyEvidenceCoverage('not-evaluated', 'unavailable')).toEqual({
      verdict: 'not-evaluated',
      degraded: false,
      reason: null
    })
  })

  it('never yields excluded unless full text was read', () => {
    for (const verdict of SCREENING_VERDICTS) {
      for (const coverage of COVERAGES) {
        const { verdict: guarded } = applyEvidenceCoverage(verdict, coverage)
        if (coverage !== 'full-text') {
          expect(guarded, `${verdict} @ ${coverage}`).not.toBe('excluded')
        }
      }
    }
  })

  it('flags a stored decision whose evidence no longer licenses it', () => {
    expect(coverageBlocksVerdict('full-text', 'excluded')).toBe(false)
    expect(coverageBlocksVerdict('abstract-only', 'excluded')).toBe(true)
    expect(coverageBlocksVerdict('metadata-only', 'included')).toBe(true)
    expect(coverageBlocksVerdict('abstract-only', 'needs-review')).toBe(false)
    expect(coverageBlocksVerdict('abstract-only', 'not-evaluated')).toBe(false)

    const staleExclusion = evaluateScreeningFreshness({
      stored: stored('excluded'),
      current: currentIdentity({ evidenceCoverage: 'abstract-only' })
    })
    expect(staleExclusion.reasons).toEqual(['missing-evidence'])
    expect(staleExclusion).toMatchObject({ current: true, stale: true, review: true })
  })

  it('still reports a fresh decision when nothing but the coverage line changed', () => {
    const freshness = freshnessFor(stored('included'), { evidenceCoverage: 'full-text' })
    expect(freshness.reasons).toEqual([])
    expect(freshness.current).toBe(true)
  })
})

describe('resolveEffectiveDecision', () => {
  it('returns the AI verdict when no override exists', () => {
    expect(resolveEffectiveDecision('included', null)).toEqual({
      effective: 'included',
      source: 'ai'
    })
    expect(resolveEffectiveDecision('not-evaluated', undefined)).toEqual({
      effective: 'not-evaluated',
      source: 'ai'
    })
  })

  it('lets a person decide, without inheriting the AI verdict', () => {
    expect(
      resolveEffectiveDecision('excluded', {
        collectionId: 'col-1',
        referenceId: 'ref-1',
        decision: 'include',
        reason: 'the exclusion criterion does not apply to this population',
        actor: 'user',
        createdAt: 1
      })
    ).toEqual({ effective: 'included', source: 'override' })
  })

  it('carries an override onto a reference the model never decided', () => {
    expect(
      resolveEffectiveDecision('not-evaluated', {
        collectionId: 'col-1',
        referenceId: 'ref-1',
        decision: 'exclude',
        reason: 'predatory venue',
        actor: 'user',
        createdAt: 1
      })
    ).toEqual({ effective: 'excluded', source: 'override' })
  })
})

describe('summarizeScreeningCoverage', () => {
  const entry = (
    verdict: ScreeningVerdict,
    coverage: ScreeningEvidenceCoverage,
    fresh = true
  ): ScreeningCoverageEntry => ({ verdict, coverage, fresh })

  it('asserts candidateCount ≤ searchedCount instead of trusting it', () => {
    expect(() =>
      summarizeScreeningCoverage({ searchedCount: 10, candidateCount: 11, entries: [] })
    ).toThrow(/candidateCount \(11\) exceeds searchedCount \(10\)/)
  })

  it('refuses a coverage list longer than the candidate set', () => {
    expect(() =>
      summarizeScreeningCoverage({
        searchedCount: 10,
        candidateCount: 1,
        entries: [entry('included', 'full-text'), entry('excluded', 'full-text')]
      })
    ).toThrow(/decisions cannot outnumber candidates/)
  })

  it('refuses counts that are not non-negative integers', () => {
    expect(() =>
      summarizeScreeningCoverage({ searchedCount: 10, candidateCount: -1, entries: [] })
    ).toThrow(/candidateCount must be a non-negative integer/)
    expect(() =>
      summarizeScreeningCoverage({ searchedCount: 1.5, candidateCount: 0, entries: [] })
    ).toThrow(/searchedCount must be a non-negative integer/)
  })

  it('states the unprocessed remainder instead of omitting it', () => {
    const summary = summarizeScreeningCoverage({
      searchedCount: 40,
      candidateCount: 12,
      entries: [
        entry('included', 'full-text'),
        entry('excluded', 'full-text'),
        entry('needs-review', 'abstract-only'),
        entry('not-evaluated', 'unavailable')
      ]
    })
    expect(summary).toMatchObject({
      searchedCount: 40,
      candidateCount: 12,
      assessedCount: 3,
      unprocessedCount: 9,
      // uncertain ∪ stale: the abstract-only needs-review, and nothing else here is stale.
      reviewCount: 1
    })
    expect(summary.verdictCounts).toEqual({
      included: 1,
      'needs-review': 1,
      excluded: 1,
      'not-evaluated': 1
    })
    expect(summary.coverageCounts).toEqual({
      'full-text': 2,
      'abstract-only': 1,
      'metadata-only': 0,
      unavailable: 1
    })
  })

  it('counts a stale decision for review even when the model was certain', () => {
    const summary = summarizeScreeningCoverage({
      searchedCount: 5,
      candidateCount: 4,
      entries: [
        entry('included', 'full-text', false),
        entry('excluded', 'full-text', true),
        entry('not-evaluated', 'metadata-only', false)
      ]
    })
    expect(summary.reviewCount).toBe(1)
    expect(summary.assessedCount).toBe(2)
    expect(summary.unprocessedCount).toBe(2)
  })

  it('reports zeros for an untouched collection', () => {
    const summary = summarizeScreeningCoverage({ searchedCount: 0, candidateCount: 0, entries: [] })
    expect(summary.assessedCount).toBe(0)
    expect(summary.unprocessedCount).toBe(0)
    expect(summary.reviewCount).toBe(0)
    expect(summary.coverageCounts['full-text']).toBe(0)
  })

  it('is what a seeded evidence-coverage list produces end to end', () => {
    // A screen of 5 candidates over 20 search hits, where the PDF-only arm could not be read.
    const decisions = [
      applyEvidenceCoverage('included', 'full-text'),
      applyEvidenceCoverage('excluded', 'abstract-only'),
      applyEvidenceCoverage('included', 'metadata-only'),
      applyEvidenceCoverage('excluded', 'unavailable'),
      applyEvidenceCoverage('included', 'full-text')
    ]
    expect(decisions.map((decision) => decision.verdict)).toEqual([
      'included',
      'needs-review',
      'needs-review',
      'not-evaluated',
      'included'
    ])

    const summary = summarizeScreeningCoverage({
      searchedCount: 20,
      candidateCount: 5,
      entries: decisions.map((decision, index) => ({
        verdict: decision.verdict,
        coverage: (
          ['full-text', 'abstract-only', 'metadata-only', 'unavailable', 'full-text'] as const
        )[index],
        fresh: true
      }))
    })
    expect(summary.assessedCount).toBe(4)
    expect(summary.unprocessedCount).toBe(1)
    expect(summary.reviewCount).toBe(2)
  })
})
