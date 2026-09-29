import { describe, expect, it } from 'vitest'

import type {
  ScreeningEvidenceCoverage,
  ScreeningItemView,
  ScreeningVerdict
} from './references-screening'
import { SCREENING_EVIDENCE_COVERAGES } from './references-screening'
import type { ScreeningCoverageChecklist } from './references-screening-coverage'
import {
  SCREENING_SEARCHED_SCOPE,
  buildScreeningCoverageChecklist,
  countScreeningCoverageItems,
  screeningCoverageBreakdown,
  screeningUnprocessedBreakdown
} from './references-screening-coverage'

// The coverage checklist (S5) is the object a reader reconciles a coverage claim against, so what it
// must never do is paper over a corpus that does not add up. These tests pin the two hard constraints
// (每篇恰属其一, 未处理量显式), the nesting candidateCount ≤ searchedCount, and the four ways a
// collection can fail to reconcile — each of which is REPORTED rather than smoothed into a total.

const item = (
  referenceId: string,
  coverage: ScreeningEvidenceCoverage,
  verdict: ScreeningVerdict = 'included'
): ScreeningItemView => ({
  referenceId,
  decision: {
    referenceId,
    verdict,
    override: null,
    effective: verdict,
    effectiveSource: 'ai'
  },
  freshness: { current: true, stale: false, review: false, reasons: [] },
  coverage,
  inputChars: 100,
  inputCharBudget: 60_000,
  ruleRevision: 1,
  policyKey: 'screening:guardrails-v1',
  model: 'stub-model-v1',
  decidedAt: 1,
  probabilities: {},
  evidence: []
})

const build = (
  items: ScreeningItemView[],
  searchedCount = items.length
): ScreeningCoverageChecklist =>
  buildScreeningCoverageChecklist({
    collectionId: 'col-1',
    searchedCount,
    candidateCount: items.length,
    items
  })

describe('the coverage checklist partitions one collection’s corpus', () => {
  it('puts every reference in exactly one of the four tiers, and all four tiers are always present', () => {
    const checklist = build([
      item('ref-full', 'full-text'),
      item('ref-abstract', 'abstract-only'),
      item('ref-metadata', 'metadata-only'),
      item('ref-bare', 'unavailable')
    ])

    // Vocabulary order, zero-count tiers kept: an empty tier is a fact, a missing one is not.
    expect(checklist.groups.map((group) => group.coverage)).toEqual([
      ...SCREENING_EVIDENCE_COVERAGES
    ])
    expect(screeningCoverageBreakdown(checklist)).toEqual([
      { coverage: 'full-text', count: 1 },
      { coverage: 'abstract-only', count: 1 },
      { coverage: 'metadata-only', count: 1 },
      { coverage: 'unavailable', count: 1 }
    ])
    // The partition adds up to the candidate count — the number the surface prints as reconciled.
    expect(checklist.classifiedCount).toBe(4)
    expect(checklist.candidateCount).toBe(4)
    expect(checklist.reconciled).toBe(true)
    expect(checklist.violations).toEqual([])
    // Each reference appears once, and only once, across the whole list.
    expect(checklist.referenceIds.sort()).toEqual([
      'ref-abstract',
      'ref-bare',
      'ref-full',
      'ref-metadata'
    ])
    const membership = checklist.groups.flatMap((group) =>
      group.items.map((entry) => `${group.coverage}:${entry.referenceId}`)
    )
    expect(new Set(membership).size).toBe(membership.length)
    expect(membership).toEqual([
      'full-text:ref-full',
      'abstract-only:ref-abstract',
      'metadata-only:ref-metadata',
      'unavailable:ref-bare'
    ])
  })

  it('states the searched total’s scope instead of implying a retrieval count the app does not keep', () => {
    const checklist = build([item('ref-a', 'metadata-only')])
    // 口径 named: the collection's members are the searched corpus AND the candidates, and the
    // checklist says so rather than leaving a reader to guess what "searched" counted.
    expect(checklist.searchedScope).toBe(SCREENING_SEARCHED_SCOPE)
    expect(checklist.searchedScope).toBe('collection-members')
    expect(checklist.searchedCount).toBe(1)
    expect(checklist.candidateCount).toBe(1)
    expect(checklist.withinSearched).toBe(true)
  })

  it('carries both totals so the nesting candidateCount ≤ searchedCount can be checked, and reports it when it fails', () => {
    const checklist = build([item('ref-a', 'full-text'), item('ref-b', 'full-text')], 1)
    expect(checklist.searchedCount).toBe(1)
    expect(checklist.candidateCount).toBe(2)
    expect(checklist.withinSearched).toBe(false)
    expect(checklist.violations).toEqual([
      'candidateCount (2) exceeds searchedCount (1); a screen cannot consider more records than it searched.'
    ])
  })

  it('reports a non-integer total rather than rendering a number that cannot be added up', () => {
    const checklist = build([item('ref-a', 'full-text')], 1.5)
    expect(checklist.withinSearched).toBe(false)
    expect(checklist.violations).toContain('searchedCount must be a non-negative integer, got 1.5.')
  })
})

describe('the unprocessed quantity is explicit', () => {
  it('enumerates the unprocessed references by id, and cuts them by evidence tier', () => {
    const checklist = build([
      item('ref-done', 'full-text', 'included'),
      item('ref-review', 'abstract-only', 'needs-review'),
      item('ref-waiting-abstract', 'abstract-only', 'not-evaluated'),
      item('ref-waiting-bare', 'unavailable', 'not-evaluated')
    ])

    // The count is carried AND the names are: "how much is left" is a list, not a missing row.
    expect(checklist.unprocessedCount).toBe(2)
    expect(checklist.unprocessedReferenceIds).toEqual(['ref-waiting-abstract', 'ref-waiting-bare'])
    expect(screeningUnprocessedBreakdown(checklist)).toEqual([
      { coverage: 'abstract-only', count: 1 },
      { coverage: 'unavailable', count: 1 }
    ])
    // Per-tier cut sums back to the total, so the surface cannot print two disagreeing unprocessed
    // numbers.
    expect(
      SCREENING_EVIDENCE_COVERAGES.reduce(
        (sum, coverage) => sum + checklist.unprocessedByCoverage[coverage],
        0
      )
    ).toBe(checklist.unprocessedCount)
    // Unprocessed items are marked per item — an item that has been assessed is never marked.
    expect(
      checklist.groups
        .flatMap((group) => group.items)
        .filter((entry) => entry.unprocessed)
        .map((entry) => entry.referenceId)
    ).toEqual(['ref-waiting-abstract', 'ref-waiting-bare'])
    // The AI verdict travels per item: an override would be the human layer's, and this reports the
    // model's own decision.
    expect(checklist.groups[1].items[0]).toEqual({
      referenceId: 'ref-review',
      verdict: 'needs-review',
      unprocessed: false
    })
  })

  it('says zero unprocessed on an untouched-but-assessed collection instead of leaving the question open', () => {
    const checklist = build([item('ref-a', 'metadata-only', 'excluded')])
    expect(checklist.unprocessedCount).toBe(0)
    expect(checklist.unprocessedReferenceIds).toEqual([])
    expect(screeningUnprocessedBreakdown(checklist)).toEqual([])
  })

  it('treats an empty collection as four empty tiers plus zero unprocessed', () => {
    const checklist = build([])
    expect(checklist.groups.map((group) => group.count)).toEqual([0, 0, 0, 0])
    expect(checklist.classifiedCount).toBe(0)
    expect(checklist.candidateCount).toBe(0)
    expect(checklist.unprocessedCount).toBe(0)
    expect(checklist.reconciled).toBe(true)
    expect(checklist.violations).toEqual([])
  })
})

describe('a corpus that does not add up is reported, not smoothed over', () => {
  it('refuses to file the same reference twice', () => {
    const checklist = build([item('ref-a', 'full-text'), item('ref-a', 'metadata-only')])
    expect(checklist.classifiedCount).toBe(1)
    expect(checklist.reconciled).toBe(false)
    expect(checklist.violations).toEqual([
      'reference ref-a appears more than once; each reference must belong to exactly one tier.',
      'the four tiers add up to 1, but there are 2 candidates.'
    ])
    expect(checklist.referenceIds).toEqual(['ref-a'])
  })

  it('refuses to bucket a coverage value that is not one of the four tiers', () => {
    const rogue = { ...item('ref-a', 'full-text'), coverage: 'partial-text' as never }
    const checklist = build([rogue, item('ref-b', 'metadata-only')])
    expect(checklist.classifiedCount).toBe(1)
    expect(checklist.reconciled).toBe(false)
    expect(checklist.violations).toEqual([
      'reference ref-a carries coverage "partial-text", which is not one of the four evidence tiers.',
      'the four tiers add up to 1, but there are 2 candidates.'
    ])
  })

  it('reports a tier sum that disagrees with the candidate count', () => {
    const checklist = buildScreeningCoverageChecklist({
      collectionId: 'col-1',
      searchedCount: 9,
      candidateCount: 9,
      items: [item('ref-a', 'full-text'), item('ref-b', 'full-text')]
    })
    expect(checklist.reconciled).toBe(false)
    expect(checklist.violations).toEqual([
      'the four tiers add up to 2, but there are 9 candidates.'
    ])
  })

  it('re-counts its own membership lists to the same totals, by a second, independent walk', () => {
    const checklist = build([
      item('ref-a', 'full-text'),
      item('ref-b', 'abstract-only'),
      item('ref-c', 'abstract-only'),
      item('ref-d', 'unavailable')
    ])
    // What the membership says, walked again — not the number the groups printed.
    expect(countScreeningCoverageItems(checklist)).toEqual({
      'full-text': 1,
      'abstract-only': 2,
      'metadata-only': 0,
      unavailable: 1
    })
    expect(screeningCoverageBreakdown(checklist)).toEqual([
      { coverage: 'full-text', count: 1 },
      { coverage: 'abstract-only', count: 2 },
      { coverage: 'metadata-only', count: 0 },
      { coverage: 'unavailable', count: 1 }
    ])
  })
})
