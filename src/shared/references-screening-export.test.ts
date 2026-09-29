import { describe, expect, it } from 'vitest'

import {
  SCREENING_NAMED_REASONS,
  SCREENING_VERDICTS,
  type ScreeningItemView,
  type ScreeningNamedReason,
  type ScreeningOverride,
  type ScreeningRuleRevision,
  type ScreeningVerdict
} from './references-screening'
import {
  SCREENING_EXPORT_SCOPE,
  buildScreeningExportScope,
  screeningExportFileName,
  screeningExportNotExportedBreakdown,
  screeningExportReasonBreakdown
} from './references-screening-export'

// The export range, asserted as a rule rather than through the window: 有效判定 (a human override
// outranks the AI's own answer) decides what a GB/T 7714 export contains, and every record left out is
// accounted for by state and by named reason — the two things a receipt has to be able to say.

const rule: ScreeningRuleRevision = {
  collectionId: 'col-1',
  revision: 3,
  inclusion: [{ id: 'i-1', text: 'adults' }],
  exclusion: [{ id: 'e-1', text: 'reviews' }],
  contentHash: 'f'.repeat(64),
  createdAt: 1_700_000_000_000
}

const item = (
  referenceId: string,
  verdict: ScreeningVerdict,
  options: {
    override?: ScreeningOverride | null
    reasons?: ScreeningNamedReason[]
    stale?: boolean
  } = {}
): ScreeningItemView => {
  const override = options.override ?? null
  const effective: ScreeningVerdict = override
    ? override.decision === 'include'
      ? 'included'
      : 'excluded'
    : verdict
  return {
    referenceId,
    decision: {
      referenceId,
      verdict,
      override,
      effective,
      effectiveSource: override ? 'override' : 'ai'
    },
    freshness: {
      current: (options.reasons ?? []).length === 0,
      stale: options.stale ?? (options.reasons ?? []).some((reason) => reason !== 'uncertain'),
      review: verdict === 'needs-review',
      reasons: options.reasons ?? []
    },
    coverage: 'full-text',
    inputChars: 100,
    inputCharBudget: 60_000,
    ruleRevision: 3,
    policyKey: 'screening:guardrails-v1',
    model: 'stub-model-v1',
    decidedAt: 1_700_000_000_000,
    probabilities: {},
    evidence: []
  }
}

const override = (
  referenceId: string,
  decision: 'include' | 'exclude',
  reason = 'a person looked'
): ScreeningOverride => ({
  collectionId: 'col-1',
  referenceId,
  decision,
  reason,
  actor: 'user',
  createdAt: 1_700_000_100_000
})

const scopeOf = (
  items: readonly ScreeningItemView[]
): ReturnType<typeof buildScreeningExportScope> =>
  buildScreeningExportScope({ collectionId: 'col-1', rule, items })

describe('buildScreeningExportScope', () => {
  it('exports only the records whose EFFECTIVE verdict is included', () => {
    const scope = scopeOf([
      item('ref-included', 'included'),
      item('ref-review', 'needs-review', { reasons: ['uncertain'] }),
      item('ref-excluded', 'excluded'),
      item('ref-untouched', 'not-evaluated')
    ])

    expect(scope.kind).toBe(SCREENING_EXPORT_SCOPE)
    expect(scope.includedReferenceIds).toEqual(['ref-included'])
    expect(scope.includedCount).toBe(1)
    expect(scope.notExportedCount).toBe(3)
    expect(scope.notExportedCounts).toEqual({
      included: 0,
      'needs-review': 1,
      excluded: 1,
      'not-evaluated': 1
    })
    // The AI's own verdicts decided all of it, so nothing here is the human layer's doing.
    expect(scope.includedByOverrideCount).toBe(0)
    expect(scope.notExportedByOverrideCount).toBe(0)
    // 未处理量 is named in the breakdown rather than folded into a verdict.
    expect(scope.notExportedCounts['not-evaluated']).toBe(1)
  })

  it('lets a human override outrank the AI verdict in BOTH directions', () => {
    const scope = scopeOf([
      // The model was unsure and a reviewer included it: it IS exported.
      item('ref-included-by-human', 'needs-review', {
        override: override('ref-included-by-human', 'include'),
        reasons: ['uncertain']
      }),
      // The model was unsure and a reviewer excluded it: it is NOT exported.
      item('ref-excluded-by-human', 'needs-review', {
        override: override('ref-excluded-by-human', 'exclude'),
        reasons: ['uncertain']
      }),
      // The model included it and a reviewer excluded it: the override wins, so it is NOT exported.
      item('ref-excluded-by-human-2', 'included', {
        override: override('ref-excluded-by-human-2', 'exclude', 'wrong population')
      })
    ])

    expect(scope.includedReferenceIds).toEqual(['ref-included-by-human'])
    expect(scope.includedByOverrideCount).toBe(1)
    expect(scope.notExportedByOverrideCount).toBe(2)
    // The state breakdown follows the effective verdict, not the model's answer.
    expect(scope.notExportedCounts).toEqual({
      included: 0,
      'needs-review': 0,
      excluded: 2,
      'not-evaluated': 0
    })
  })

  it('accounts for every record by state and by named reason, so nothing leaves silently', () => {
    const items = [
      item('ref-a', 'included'),
      item('ref-b', 'needs-review', { reasons: ['uncertain'] }),
      item('ref-c', 'excluded', { reasons: ['rule-changed'], stale: true }),
      item('ref-d', 'excluded', { reasons: ['rule-changed', 'model-changed'], stale: true }),
      item('ref-e', 'not-evaluated', { reasons: ['missing-evidence'] }),
      item('ref-f', 'not-evaluated', { reasons: ['input-too-long'] })
    ]
    const scope = scopeOf(items)

    // included + notExported === total, and the states nest exactly.
    expect(scope.includedCount + scope.notExportedCount).toBe(items.length)
    expect(scope.totalCount).toBe(items.length)
    expect(
      SCREENING_VERDICTS.reduce((sum, verdict) => sum + scope.notExportedCounts[verdict], 0)
    ).toBe(scope.notExportedCount)
    // The named-reason record is exhaustive over the closed vocabulary.
    expect(Object.keys(scope.notExportedByReason).sort()).toEqual(
      [...SCREENING_NAMED_REASONS].sort()
    )
    expect(scope.notExportedByReason).toMatchObject({
      'rule-changed': 2,
      'model-changed': 1,
      'missing-evidence': 1,
      'input-too-long': 1,
      'input-changed': 0,
      uncertain: 1
    })
    // A record that IS exported contributes no exclusion accounting at all.
    expect(screeningExportReasonBreakdown(scope).map((entry) => entry.reason)).toEqual([
      'rule-changed',
      'model-changed',
      'missing-evidence',
      'input-too-long',
      'uncertain'
    ])
    expect(screeningExportNotExportedBreakdown(scope)).toEqual([
      { verdict: 'included', count: 0 },
      { verdict: 'needs-review', count: 1 },
      { verdict: 'excluded', count: 2 },
      { verdict: 'not-evaluated', count: 2 }
    ])
  })

  it('reports the rule revision the range was judged against, and an honest null without one', () => {
    const withRule = scopeOf([item('ref-a', 'included')])
    expect(withRule.ruleRevision).toBe(3)
    expect(withRule.ruleContentHash).toBe('f'.repeat(64))

    const withoutRule = buildScreeningExportScope({
      collectionId: 'col-1',
      rule: null,
      items: [item('ref-a', 'not-evaluated')]
    })
    expect(withoutRule.ruleRevision).toBeNull()
    expect(withoutRule.ruleContentHash).toBeNull()
    // A collection nobody has screened exports NOTHING: an unscreened collection is not a licence to
    // export everything under the screening banner.
    expect(withoutRule.includedCount).toBe(0)
    expect(withoutRule.notExportedCount).toBe(1)
  })

  it('handles an empty collection without inventing a range', () => {
    const scope = scopeOf([])
    expect(scope.includedReferenceIds).toEqual([])
    expect(scope.includedCount).toBe(0)
    expect(scope.totalCount).toBe(0)
    expect(scope.notExportedCount).toBe(0)
  })
})

describe('screeningExportFileName', () => {
  it('carries the scope, the collection, the rule revision, the style and the day', () => {
    const name = screeningExportFileName({
      collectionName: 'Screen hits',
      styleId: 'gbt7714-2015',
      revision: 2,
      generatedAt: Date.UTC(2026, 8, 29, 3, 0, 0)
    })
    expect(name).toBe('references-screen-hits-included-only-r2-gbt7714-2015-2026-09-29.txt')
    // The scope is legible in the file a reviewer keeps.
    expect(name).toContain(SCREENING_EXPORT_SCOPE)
  })

  it('names the revision honestly when the collection has none, and survives a CJK collection name', () => {
    const name = screeningExportFileName({
      collectionName: '文献纳排',
      styleId: 'gbt7714-2015',
      revision: null,
      generatedAt: Date.UTC(2026, 8, 29)
    })
    // A name that cannot be slugged falls back rather than producing an empty path segment.
    expect(name).toBe('references-collection-included-only-r-unknown-gbt7714-2015-2026-09-29.txt')
  })

  it('strips path separators and other unsafe characters out of every segment', () => {
    const name = screeningExportFileName({
      collectionName: '../../etc/passwd',
      styleId: 'My Style (v2)!',
      revision: 7,
      generatedAt: Date.UTC(2026, 0, 2)
    })
    expect(name).toBe('references-etc-passwd-included-only-r7-my-style-v2-2026-01-02.txt')
    expect(name).not.toContain('/')
    expect(name).not.toContain('..')
  })
})
