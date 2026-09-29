import { describe, expect, it } from 'vitest'

import type { Reference } from '../../shared/references'
import { SCREENING_EVIDENCE_COVERAGES, SCREENING_VERDICTS } from '../../shared/references-screening'
import { buildScreeningExportScope } from '../../shared/references-screening-export'
import { createInMemoryScreeningClient } from '../../../test/fixtures/in-memory-screening-client'
import type { ScreeningModelRunner } from './screening-engine'
import { ScreeningRepository } from './screening-repository'
import { ScreeningService } from './screening-service'

// 统计与库内逐项一致 (S4): the counts a surface renders must equal what the LEDGER holds, item by item.
// The service's snapshot and the ledger are read through different paths here — the projection
// (snapshot / items) and the raw rows (listAssessments / listOverrides / listDecisionViews / the
// collection's own members) — so a statistic that was inferred, rounded or inherited from the model's
// answer instead of from what was stored shows up as a disagreement between two reads.
//
// The export range is cross-checked the same way: the ids a GB/T 7714 export would contain are compared
// against the effective decisions the repository returns directly.

const COLLECTION = 'col-stats'

const reference = (id: string, overrides: Partial<Reference> = {}): Reference => ({
  id,
  projectId: 'project-1',
  title: `Title for ${id}`,
  authors: [{ name: 'Ada Lovelace' }],
  venue: 'Journal of Tests',
  year: 2024,
  doi: undefined,
  pmid: undefined,
  pmcid: undefined,
  arxivId: undefined,
  url: undefined,
  abstractSnippet: undefined,
  sourceConnector: 'manual',
  sourceRecordId: undefined,
  citationKey: `key-${id}`,
  provenance: undefined,
  pdfManagedFileId: undefined,
  notes: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

// Nothing at all to read: the only shape that lands in the 'unavailable' coverage tier, i.e. the
// explicit 未处理 row that statistics must count separately.
const bareReference = (id: string): Reference =>
  reference(id, {
    title: '',
    authors: [],
    venue: undefined,
    year: undefined,
    doi: undefined,
    citationKey: ''
  })

const FULL_TEXT = 'We enrolled 120 adults and measured the primary endpoint over twelve weeks.'

const answer = (verdict: 'included' | 'excluded' | 'uncertain'): string =>
  JSON.stringify(
    verdict === 'excluded'
      ? {
          verdict,
          probabilities: { exclude: 0.9 },
          citations: [],
          refutation: { criterionId: 'e-1', quote: 'This article is a systematic review.' }
        }
      : verdict === 'included'
        ? {
            verdict,
            probabilities: { include: 0.9 },
            citations: [{ criterionId: 'i-1', quote: 'We enrolled 120 adults' }],
            refutation: null
          }
        : {
            verdict,
            probabilities: { uncertain: 0.7 },
            citations: [],
            refutation: null
          }
  )

// One answer per record, chosen by the title in the prompt — the only way to reach all four states
// without a provider.
const VERDICT_BY_TITLE: readonly (readonly [string, 'included' | 'excluded' | 'uncertain'])[] = [
  ['Title for ref-included', 'included'],
  ['Title for ref-excluded', 'excluded'],
  ['Title for ref-uncertain', 'uncertain']
]

const runner: ScreeningModelRunner = {
  model: 'stub-model-v1',
  run: async (prompt: string) => {
    for (const [title, verdict] of VERDICT_BY_TITLE) {
      if (prompt.includes(title)) return { text: answer(verdict) }
    }
    // The bare record has no title to key on; it answers with an inclusion it cannot possibly support,
    // which the coverage guard must degrade rather than store.
    return { text: answer('included') }
  }
}

const references = [
  reference('ref-included'),
  reference('ref-excluded'),
  reference('ref-uncertain'),
  bareReference('ref-unavailable')
]

const build = (): {
  service: ScreeningService
  repository: ScreeningRepository
} => {
  const client = createInMemoryScreeningClient()
  const repository = new ScreeningRepository(async () => client)
  const byId = new Map(references.map((entry) => [entry.id, entry]))
  const service = new ScreeningService({
    repository,
    references: {
      listCollectionReferences: async () => [...references],
      getReference: async (referenceId) => byId.get(referenceId) ?? null
    },
    fullText: async (entry) => (entry.id === 'ref-unavailable' ? null : FULL_TEXT),
    runner: () => runner,
    beginPass: () => undefined,
    chunkSize: 4
  })
  return { service, repository }
}

const pollUntilIdle = async (
  service: ScreeningService,
  timeoutMs = 5_000
): Promise<Awaited<ReturnType<ScreeningService['snapshot']>>> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = await service.snapshot(COLLECTION)
    if (!snapshot.lastRun?.running) return snapshot
    if (Date.now() > deadline) throw new Error('the pass never finished')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('screening statistics against the ledger', () => {
  it('reports AI decisions, human overrides and unprocessed exactly as the stored rows have them', async () => {
    const { service, repository } = build()
    await service.appendRuleRevision({
      collectionId: COLLECTION,
      inclusion: [{ id: 'i-1', text: '研究对象为成年人' }],
      exclusion: [{ id: 'e-1', text: '综述、社论、病例报告' }]
    })
    await service.startRun({ collectionId: COLLECTION })
    await pollUntilIdle(service)

    // A person flips one AI decision each way, AFTER the pass: the AI layer must not move.
    await service.setOverride({
      collectionId: COLLECTION,
      referenceId: 'ref-included',
      decision: 'exclude',
      reason: 'retracted after screening',
      actor: 'user'
    })
    await service.setOverride({
      collectionId: COLLECTION,
      referenceId: 'ref-uncertain',
      decision: 'include',
      reason: 'the protocol admits this cohort',
      actor: 'user'
    })

    const snapshot = await service.snapshot(COLLECTION)
    const assessments = await repository.listAssessments(COLLECTION)
    const overrides = await repository.listOverrides(COLLECTION)
    const decisions = await repository.listDecisionViews(COLLECTION)

    // 1. AI 判定数 = the stored assessments, item by item.
    expect(snapshot.aiDecidedCount).toBe(assessments.length)
    expect(snapshot.aiDecidedCount).toBe(
      snapshot.items.filter((item) => item.decision.verdict !== 'not-evaluated').length
    )
    // The four-state distribution is the collection's MEMBERS by state: a decided state is counted from
    // the stored assessment rows (never from the effective verdicts — an override would then masquerade
    // as a model decision), and 'not-evaluated' is exactly the members that have no row at all.
    for (const verdict of SCREENING_VERDICTS) {
      const fromLedger =
        verdict === 'not-evaluated'
          ? references.length - assessments.length
          : assessments.filter((assessment) => assessment.verdict === verdict).length
      expect({ verdict, count: snapshot.summary.verdictCounts[verdict] }).toEqual({
        verdict,
        count: fromLedger
      })
    }
    expect(
      SCREENING_VERDICTS.reduce((sum, verdict) => sum + snapshot.summary.verdictCounts[verdict], 0)
    ).toBe(references.length)
    // 2. 人工覆盖数 = the stored overrides.
    expect(snapshot.overrideCount).toBe(overrides.length)
    expect(snapshot.overrideCount).toBe(2)
    // 3. 未处理数 = members with no assessment at all, stated rather than inferred from a missing row.
    expect(snapshot.summary.unprocessedCount).toBe(references.length - assessments.length)
    expect(snapshot.summary.unprocessedCount).toBe(
      snapshot.items.filter((item) => item.decision.verdict === 'not-evaluated').length
    )
    // The evidence-coverage distribution covers every candidate exactly once.
    expect(
      SCREENING_EVIDENCE_COVERAGES.reduce(
        (sum, coverage) => sum + snapshot.summary.coverageCounts[coverage],
        0
      )
    ).toBe(snapshot.summary.candidateCount)
    expect(snapshot.summary.coverageCounts.unavailable).toBe(1)

    // The override never rewrote the AI verdict it overrides, and a reader can still see both layers.
    expect(assessments.find((entry) => entry.referenceId === 'ref-included')?.verdict).toBe(
      'included'
    )
    expect(decisions.find((entry) => entry.referenceId === 'ref-included')).toMatchObject({
      verdict: 'included',
      effective: 'excluded',
      effectiveSource: 'override'
    })
    expect(decisions.find((entry) => entry.referenceId === 'ref-uncertain')).toMatchObject({
      verdict: 'needs-review',
      effective: 'included',
      effectiveSource: 'override'
    })

    // The export range is the effective decisions — cross-checked against the repository's own
    // projection, which is read through a different path than the snapshot's items.
    const scope = buildScreeningExportScope({
      collectionId: COLLECTION,
      rule: snapshot.rule,
      items: snapshot.items
    })
    expect(scope.includedReferenceIds).toEqual(
      decisions
        .filter((decision) => decision.effective === 'included')
        .map((decision) => decision.referenceId)
        .sort()
    )
    expect(scope.includedReferenceIds).toEqual(['ref-uncertain'])
    expect(scope.includedByOverrideCount).toBe(1)
    expect(scope.notExportedByOverrideCount).toBe(1)
    expect(scope.notExportedCount).toBe(references.length - 1)
    expect(scope.ruleRevision).toBe(snapshot.rule?.revision ?? null)
    expect(scope.ruleContentHash).toBe(snapshot.rule?.contentHash ?? null)
    // 未处理 stays named in the range rather than being dropped from it.
    expect(scope.notExportedCounts['not-evaluated']).toBe(1)
  })

  it('counts an untouched collection as unprocessed rather than as undecided AI work', async () => {
    const { service, repository } = build()
    await service.appendRuleRevision({
      collectionId: COLLECTION,
      inclusion: [{ id: 'i-1', text: '研究对象为成年人' }],
      exclusion: [{ id: 'e-1', text: '综述、社论、病例报告' }]
    })
    await service.setOverride({
      collectionId: COLLECTION,
      referenceId: 'ref-included',
      decision: 'include',
      reason: 'decided before any pass ran',
      actor: 'user'
    })

    const snapshot = await service.snapshot(COLLECTION)
    const assessments = await repository.listAssessments(COLLECTION)
    // Nothing has been assessed, so the AI count is honestly zero — and the unprocessed count says how
    // much of the collection that is, instead of leaving the reader to subtract.
    expect(assessments).toEqual([])
    expect(snapshot.aiDecidedCount).toBe(0)
    expect(snapshot.overrideCount).toBe(1)
    expect(snapshot.summary.unprocessedCount).toBe(references.length)
    expect(snapshot.summary.assessedCount).toBe(0)

    // A person's decision made before any pass still travels: the export contains that record, built
    // from a decision with no assessment behind it.
    const scope = buildScreeningExportScope({
      collectionId: COLLECTION,
      rule: snapshot.rule,
      items: snapshot.items
    })
    expect(scope.includedReferenceIds).toEqual(['ref-included'])
    expect(scope.includedByOverrideCount).toBe(1)
    expect(scope.notExportedCounts['not-evaluated']).toBe(references.length - 1)
  })
})
