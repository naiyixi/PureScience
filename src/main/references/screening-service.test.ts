import { describe, expect, it, vi } from 'vitest'

import type { Reference } from '../../shared/references'
import type {
  ScreeningOverrideDecision,
  ScreeningRunItemState
} from '../../shared/references-screening'
import { computeScreeningInputDigest } from './screening-digest'
import { assembleScreeningEvidence } from './screening-evidence'
import type { ScreeningModelRunner } from './screening-engine'
import { ScreeningService, ScreeningRunnerUnavailableError } from './screening-service'
import { SCREENING_PROMPT_POLICY_KEY } from './screening-prompt'
import { ScreeningRepository } from './screening-repository'
import { createInMemoryScreeningClient } from '../../../test/fixtures/in-memory-screening-client'

// The orchestration layer's own rules, exercised against the real repository and the real engine over an
// in-memory ledger: only the model is stubbed. That is what makes these assertions about the SERVICE
// rather than about a mock — an override that leaked into the AI layer, a resume that re-decided an
// unchanged record, or a cancel that marked a half-finished pass complete would all show up here.

// --- fixtures ------------------------------------------------------------------------------------

const COLLECTION = 'col-1'

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

// A record that carries nothing at all: no title, no authors, no venue, no year. It is the only shape
// that reaches the 'unavailable' coverage tier, which is what 'never excluded on silence' is about.
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

const build = (
  references: readonly Reference[],
  options: {
    fullText?: (reference: Reference) => Promise<string | null>
    runner?: ScreeningModelRunner
    chunkSize?: number
    inputCharBudget?: number
  } = {}
): {
  service: ScreeningService
  repository: ScreeningRepository
  runner: ScreeningModelRunner
  setRunner: (next: () => ScreeningModelRunner) => void
} => {
  const client = createInMemoryScreeningClient()
  const repository = new ScreeningRepository(async () => client)
  const byId = new Map(references.map((entry) => [entry.id, entry]))
  let runnerFactory = (): ScreeningModelRunner => {
    if (!options.runner) throw new ScreeningRunnerUnavailableError()
    return options.runner
  }
  const service = new ScreeningService({
    repository,
    references: {
      listCollectionReferences: async () => [...references],
      getReference: async (referenceId) => byId.get(referenceId) ?? null
    },
    fullText: options.fullText ?? (async () => FULL_TEXT),
    runner: () => runnerFactory(),
    beginPass: () => undefined,
    chunkSize: options.chunkSize ?? 8,
    ...(options.inputCharBudget === undefined ? {} : { inputCharBudget: options.inputCharBudget })
  })
  return {
    service,
    repository,
    runner: options.runner as ScreeningModelRunner,
    setRunner: (next) => {
      runnerFactory = next
    }
  }
}

// A stub model whose answer depends on the record it was asked about — the only thing that makes a
// four-state collection reachable without a provider.
const verdictRunner = (answers: Record<string, string>): ScreeningModelRunner => ({
  model: 'stub-model-v1',
  run: async (prompt: string) => {
    for (const [marker, answer] of Object.entries(answers)) {
      if (prompt.includes(marker)) return { text: answer }
    }
    throw new Error(`no stub answer for prompt: ${prompt.slice(0, 120)}`)
  }
})

const INCLUDED_ANSWER = JSON.stringify({
  verdict: 'included',
  probabilities: { include: 0.9, exclude: 0.05, uncertain: 0.05 },
  citations: [{ criterionId: 'i-1', quote: 'We enrolled 120 adults', locator: 'p.2' }],
  refutation: null
})
const EXCLUDED_ANSWER = JSON.stringify({
  verdict: 'excluded',
  probabilities: { exclude: 0.88 },
  citations: [],
  refutation: { criterionId: 'e-1', quote: 'This article is a systematic review.' }
})
const UNCERTAIN_ANSWER = JSON.stringify({
  verdict: 'uncertain',
  probabilities: { uncertain: 0.7 },
  citations: [],
  refutation: null
})

const inclusion = [
  { id: 'i-1', text: '研究对象为成年人' },
  { id: 'i-2', text: '英文或中文全文' }
]
const exclusion = [{ id: 'e-1', text: '综述、社论、病例报告' }]

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

describe('ScreeningService snapshot', () => {
  it('states the four states, the named reasons and the unprocessed count before anything is decided', async () => {
    const withText = reference('ref-full')
    const metadataOnly = reference('ref-metadata', { doi: '10.1000/x' })
    const nothing = bareReference('ref-empty')
    const { service } = build([withText, metadataOnly, nothing], {
      fullText: async (entry) => (entry.id === 'ref-full' ? FULL_TEXT : null),
      runner: verdictRunner({})
    })

    await service.appendRuleRevision({ collectionId: COLLECTION, inclusion, exclusion })
    const snapshot = await service.snapshot(COLLECTION)

    expect(snapshot.rule?.revision).toBe(1)
    expect(snapshot.items.map((item) => item.referenceId)).toEqual([
      'ref-empty',
      'ref-full',
      'ref-metadata'
    ])
    // Nothing is decided yet, and every line says so in the vocabulary a surface can translate.
    expect(snapshot.items.every((item) => item.decision.verdict === 'not-evaluated')).toBe(true)
    expect(snapshot.items.every((item) => item.decision.effectiveSource === 'ai')).toBe(true)
    // Coverage is computed from the material: full text / metadata only / nothing at all.
    expect(snapshot.items.map((item) => [item.referenceId, item.coverage] as const)).toEqual([
      ['ref-empty', 'unavailable'],
      ['ref-full', 'full-text'],
      ['ref-metadata', 'metadata-only']
    ])
    // The unprocessed count is stated (not inferred), and the missing evidence is a NAMED reason.
    expect(snapshot.summary).toMatchObject({
      searchedCount: 3,
      candidateCount: 3,
      assessedCount: 0,
      unprocessedCount: 3,
      reviewCount: 0
    })
    expect(snapshot.summary.verdictCounts['not-evaluated']).toBe(3)
    // Only the record with NOTHING to read names the missing evidence; a metadata-only record is a
    // weaker basis, not a missing one, and it stays unprocessed without a staleness reason.
    expect(snapshot.reasonCounts['missing-evidence']).toBe(1)
    expect(snapshot.aiDecidedCount).toBe(0)
    expect(snapshot.overrideCount).toBe(0)
    expect(snapshot.runnerAvailable).toBe(true)
  })

  it('reports the model runner as unavailable instead of pretending a pass could run', async () => {
    const { service } = build([reference('ref-1')])

    const snapshot = await service.snapshot(COLLECTION)
    expect(snapshot.runnerAvailable).toBe(false)

    await service.appendRuleRevision({ collectionId: COLLECTION, inclusion, exclusion })
    await expect(service.startRun({ collectionId: COLLECTION })).rejects.toBeInstanceOf(
      ScreeningRunnerUnavailableError
    )
    // The refused start left no run behind: nothing is "running" and no ledger row was written.
    expect((await service.snapshot(COLLECTION)).lastRun).toBeNull()
  })
})

describe('ScreeningService rule revisions', () => {
  it('appends a revision, refuses a duplicate, and says how many decisions a real change stales', async () => {
    const { service } = build([reference('ref-1')], {
      runner: verdictRunner({ 'ref-1': INCLUDED_ANSWER })
    })

    const first = await service.appendRuleRevision({
      collectionId: COLLECTION,
      inclusion,
      exclusion
    })
    expect(first.appended).toBe(true)
    expect(first.revision.revision).toBe(1)
    expect(first.affectedDecisions).toBe(0)

    // The same criteria in a different order are the same rule: no revision is stacked, so no stored
    // decision is staled for nothing.
    const again = await service.appendRuleRevision({
      collectionId: COLLECTION,
      inclusion: [...inclusion].reverse(),
      exclusion
    })
    expect(again.appended).toBe(false)
    expect(again.revision.revision).toBe(1)

    await service.startRun({ collectionId: COLLECTION })
    await pollUntilIdle(service)

    const changed = await service.appendRuleRevision({
      collectionId: COLLECTION,
      inclusion: [...inclusion, { id: 'i-3', text: '随访至少 12 周' }],
      exclusion
    })
    expect(changed.appended).toBe(true)
    expect(changed.revision.revision).toBe(2)
    expect(changed.affectedDecisions).toBe(1)

    // And the surface now names why the stored verdict is not today's answer.
    const snapshot = await service.snapshot(COLLECTION)
    expect(snapshot.rule?.revision).toBe(2)
    expect(snapshot.items[0].freshness.reasons).toContain('rule-changed')
    expect(snapshot.items[0].freshness.stale).toBe(true)
    expect(snapshot.reasonCounts['rule-changed']).toBe(1)
  })

  it('refuses a criterion with no id or no text, and duplicate ids', async () => {
    const { service } = build([reference('ref-1')])

    await expect(
      service.appendRuleRevision({
        collectionId: COLLECTION,
        inclusion: [{ id: '  ', text: 'no id' }],
        exclusion: []
      })
    ).rejects.toThrow(/needs an id/)
    await expect(
      service.appendRuleRevision({
        collectionId: COLLECTION,
        inclusion: [{ id: 'i-1', text: '   ' }],
        exclusion: []
      })
    ).rejects.toThrow(/has no text/)
    await expect(
      service.appendRuleRevision({
        collectionId: COLLECTION,
        inclusion: [
          { id: 'i-1', text: 'one' },
          { id: 'i-1', text: 'two' }
        ],
        exclusion: []
      })
    ).rejects.toThrow(/unique/)
  })
})

describe('ScreeningService runs', () => {
  it('screens a collection to four states with named reasons, then reports AI counts apart from overrides', async () => {
    const references = [
      reference('ref-included'),
      reference('ref-excluded'),
      reference('ref-uncertain'),
      bareReference('ref-nothing')
    ]
    const { service } = build(references, {
      fullText: async (entry) => (entry.id === 'ref-nothing' ? null : FULL_TEXT),
      runner: verdictRunner({
        'ref-included': INCLUDED_ANSWER,
        'ref-excluded': EXCLUDED_ANSWER,
        'ref-uncertain': UNCERTAIN_ANSWER
      })
    })
    await service.appendRuleRevision({ collectionId: COLLECTION, inclusion, exclusion })

    const started = await service.startRun({ collectionId: COLLECTION })
    expect(started.started).toBe(true)
    expect(started.referenceCount).toBe(4)

    const snapshot = await pollUntilIdle(service)
    const byId = new Map(snapshot.items.map((item) => [item.referenceId, item]))

    // Four states, each reached honestly.
    expect(byId.get('ref-included')?.decision.verdict).toBe('included')
    expect(byId.get('ref-excluded')?.decision.verdict).toBe('excluded')
    expect(byId.get('ref-uncertain')?.decision.verdict).toBe('needs-review')
    expect(byId.get('ref-nothing')?.decision.verdict).toBe('not-evaluated')
    // 每条决策带溯源: the included verdict carries the passage it rests on, and the model that said it.
    expect(byId.get('ref-included')?.evidence).toEqual([
      { criterionId: 'i-1', coverage: 'full-text', quote: 'We enrolled 120 adults', locator: 'p.2' }
    ])
    expect(byId.get('ref-included')?.model).toBe('stub-model-v1')
    expect(byId.get('ref-included')?.decidedAt).toBeGreaterThan(0)
    expect(byId.get('ref-included')?.freshness.current).toBe(true)
    // The record with nothing to read stays unprocessed with a NAMED reason, never excluded on silence.
    expect(byId.get('ref-nothing')?.freshness.reasons).toEqual(['missing-evidence'])
    // uncertain ∪ stale — and the unprocessed record is NOT counted as needing review.
    expect(snapshot.summary).toMatchObject({
      assessedCount: 3,
      unprocessedCount: 1,
      reviewCount: 1
    })
    expect(snapshot.reasonCounts.uncertain).toBe(1)
    // 统计必须区分 AI 判定数 / 人工覆盖数.
    expect(snapshot.aiDecidedCount).toBe(3)
    expect(snapshot.overrideCount).toBe(0)
    expect(snapshot.lastRun).toMatchObject({
      running: false,
      referenceCount: 4,
      assessed: 3,
      deferred: 1,
      failed: 0,
      pending: 0
    })
    expect(snapshot.lastRun?.run.status).toBe('completed')
  })

  it('defers evidence beyond the model input budget with its own reason instead of truncating it', async () => {
    const { service } = build([reference('ref-long')], {
      fullText: async () => 'x'.repeat(5_000),
      runner: verdictRunner({ 'ref-long': INCLUDED_ANSWER }),
      inputCharBudget: 1_000
    })
    await service.appendRuleRevision({ collectionId: COLLECTION, inclusion, exclusion })

    await service.startRun({ collectionId: COLLECTION })
    const snapshot = await pollUntilIdle(service)

    expect(snapshot.items[0].decision.verdict).toBe('not-evaluated')
    expect(snapshot.items[0].freshness.reasons).toContain('input-too-long')
    expect(snapshot.items[0].inputChars).toBeGreaterThan(1_000)
    expect(snapshot.lastRun).toMatchObject({ deferred: 1, assessed: 0 })
  })

  it('stops a pass between chunks, leaves the rest pending, and resumes exactly there', async () => {
    const references = [reference('ref-a'), reference('ref-b'), reference('ref-c')]
    let releaseFirst: (() => void) | undefined
    const firstCall = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let call = 0
    const slowRunner: ScreeningModelRunner = {
      model: 'stub-model-v1',
      run: async (prompt: string) => {
        call += 1
        // The first record is answered immediately; the second hangs, which is where the cancel lands.
        if (call > 1) await firstCall
        if (prompt.includes('ref-a')) return { text: INCLUDED_ANSWER }
        if (prompt.includes('ref-b')) return { text: EXCLUDED_ANSWER }
        return { text: UNCERTAIN_ANSWER }
      }
    }
    const { service } = build(references, { runner: slowRunner, chunkSize: 1 })
    await service.appendRuleRevision({ collectionId: COLLECTION, inclusion, exclusion })
    await service.startRun({ collectionId: COLLECTION })
    await vi.waitFor(async () => {
      expect((await service.snapshot(COLLECTION)).lastRun?.assessed).toBe(1)
    })

    const cancelled = await service.cancelRun(COLLECTION)
    expect(cancelled.cancelled).toBe(true)
    expect(cancelled.remaining).toBeGreaterThan(0)
    releaseFirst?.()

    // Cancelling does not mark the pass finished: it stays resumable, and the untouched rows stay pending.
    await vi.waitFor(async () => {
      const snapshot = await service.snapshot(COLLECTION)
      expect(snapshot.lastRun?.running).toBe(false)
      expect(snapshot.lastRun?.pending).toBeGreaterThan(0)
      expect(snapshot.lastRun?.run.status).toBe('running')
    })
    const afterCancel = await service.snapshot(COLLECTION)
    const pendingBefore = afterCancel.items.filter(
      (item) => item.decision.verdict === 'not-evaluated'
    ).length
    expect(pendingBefore).toBeGreaterThan(0)

    const resumed = await service.startRun({
      collectionId: COLLECTION,
      resumeRunId: cancelled.runId
    })
    expect(resumed.started).toBe(true)
    const finished = await pollUntilIdle(service)
    expect(finished.items.every((item) => item.decision.verdict !== 'not-evaluated')).toBe(true)
    // The resume continued the SAME run rather than opening a second one.
    expect(finished.lastRun?.run.id).toBe(cancelled.runId)
    expect(finished.lastRun?.run.status).toBe('completed')
  })

  it('refuses to start without criteria, and refuses a second pass for the same collection', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const gatedRunner: ScreeningModelRunner = {
      model: 'stub-model-v1',
      run: async (prompt: string) => {
        await gate
        if (prompt.includes('ref-a')) return { text: INCLUDED_ANSWER }
        return { text: UNCERTAIN_ANSWER }
      }
    }
    const { service } = build([reference('ref-a'), reference('ref-b')], {
      runner: gatedRunner,
      chunkSize: 1
    })
    await expect(service.startRun({ collectionId: COLLECTION })).rejects.toThrow(
      /no inclusion \/ exclusion criteria/
    )

    await service.appendRuleRevision({ collectionId: COLLECTION, inclusion, exclusion })
    const first = await service.startRun({ collectionId: COLLECTION })
    const second = await service.startRun({ collectionId: COLLECTION })
    expect(second.started).toBe(false)
    expect(second.runId).toBe(first.runId)
    release?.()
    await pollUntilIdle(service)
  })
})

describe('ScreeningService overrides', () => {
  const decideEverything = async (
    references: readonly Reference[]
  ): Promise<ReturnType<typeof build>> => {
    const built = build(references, {
      runner: verdictRunner({
        'ref-a': INCLUDED_ANSWER,
        'ref-b': EXCLUDED_ANSWER
      })
    })
    await built.service.appendRuleRevision({ collectionId: COLLECTION, inclusion, exclusion })
    await built.service.startRun({ collectionId: COLLECTION })
    await pollUntilIdle(built.service)
    return built
  }

  it('layers a human override beside the AI verdict and restores the original when cleared', async () => {
    const { service, repository } = await decideEverything([reference('ref-a'), reference('ref-b')])
    const before = await repository.getAssessment(COLLECTION, 'ref-a')

    const overridden = await service.setOverride({
      collectionId: COLLECTION,
      referenceId: 'ref-a',
      decision: 'exclude',
      reason: 'the cohort is paediatric',
      actor: 'user'
    })

    // Both layers travel: the AI verdict is still the model's, and the effective decision is the human's.
    expect(overridden.decision.verdict).toBe('included')
    expect(overridden.decision.override).toMatchObject({
      decision: 'exclude',
      reason: 'the cohort is paediatric',
      actor: 'user'
    })
    expect(overridden.decision.effective).toBe('excluded')
    expect(overridden.decision.effectiveSource).toBe('override')
    // 人工覆盖不改写 AI 原判: the assessment row is byte-identical after the override.
    expect(await repository.getAssessment(COLLECTION, 'ref-a')).toEqual(before)

    const snapshot = await service.snapshot(COLLECTION)
    expect(snapshot.overrideCount).toBe(1)
    expect(snapshot.aiDecidedCount).toBe(2)
    expect(snapshot.summary.verdictCounts.included).toBe(1)

    const cleared = await service.clearOverride(COLLECTION, 'ref-a')
    expect(cleared.item.decision.override).toBeNull()
    expect(cleared.item.decision.verdict).toBe('included')
    expect(cleared.item.decision.effective).toBe('included')
    expect(cleared.item.decision.effectiveSource).toBe('ai')
    expect((await service.snapshot(COLLECTION)).overrideCount).toBe(0)
  })

  it('requires a reason for an override, and applies a batch override to every selected record', async () => {
    const { service } = await decideEverything([reference('ref-a'), reference('ref-b')])

    await expect(
      service.setOverride({
        collectionId: COLLECTION,
        referenceId: 'ref-a',
        decision: 'include',
        reason: '   ',
        actor: 'user'
      })
    ).rejects.toThrow(/reason/)

    const batch = await service.setOverrides({
      collectionId: COLLECTION,
      referenceIds: ['ref-a', 'ref-b', 'ref-a'],
      decision: 'include' as ScreeningOverrideDecision,
      reason: 'both match the protocol',
      actor: 'user'
    })
    expect(batch.applied).toBe(2)
    expect(batch.items).toHaveLength(2)
    expect(batch.items.every((item) => item.decision.effective === 'included')).toBe(true)
    expect(
      batch.items.every((item) => item.decision.override?.reason === 'both match the protocol')
    ).toBe(true)
    // The AI verdicts are untouched by a batch too: one was excluded, the other included.
    expect(batch.items.map((item) => [item.referenceId, item.decision.verdict] as const)).toEqual([
      ['ref-a', 'included'],
      ['ref-b', 'excluded']
    ])
    await expect(
      service.setOverrides({
        collectionId: COLLECTION,
        referenceIds: [],
        decision: 'include',
        reason: 'nothing selected',
        actor: 'user'
      })
    ).rejects.toThrow(/at least one reference/)
  })

  it('keeps an override a person made before the model ever ran, with the verdict honestly unprocessed', async () => {
    const { service } = build([bareReference('ref-a')], {
      runner: verdictRunner({}),
      fullText: async () => null
    })
    await service.appendRuleRevision({ collectionId: COLLECTION, inclusion, exclusion })

    const item = await service.setOverride({
      collectionId: COLLECTION,
      referenceId: 'ref-a',
      decision: 'include',
      reason: 'screened by hand at the protocol meeting',
      actor: 'user'
    })

    expect(item.decision.verdict).toBe('not-evaluated')
    expect(item.decision.effective).toBe('included')
    expect(item.freshness.reasons).toContain('missing-evidence')
    const snapshot = await service.snapshot(COLLECTION)
    expect(snapshot.summary.unprocessedCount).toBe(1)
    expect(snapshot.overrideCount).toBe(1)
  })

  it('reports a stored decision as model-changed when the policy identity moves', async () => {
    const { service, repository } = build([reference('ref-a')], {
      runner: verdictRunner({ 'ref-a': INCLUDED_ANSWER })
    })
    const rule = await service.appendRuleRevision({
      collectionId: COLLECTION,
      inclusion,
      exclusion
    })
    const bundle = assembleScreeningEvidence({ reference: reference('ref-a'), fullText: FULL_TEXT })
    await repository.upsertAssessment({
      collectionId: COLLECTION,
      referenceId: 'ref-a',
      ruleRevision: rule.revision.revision,
      inputDigest: computeScreeningInputDigest({
        ruleContentHash: rule.revision.contentHash,
        policyKey: 'screening:older-policy',
        coverage: bundle.coverage,
        sections: bundle.sections
      }),
      policyKey: 'screening:older-policy',
      model: 'stub-model-v0',
      verdict: 'included',
      decidedAt: 1
    })

    const snapshot = await service.snapshot(COLLECTION)
    const item = snapshot.items[0]
    expect(item.policyKey).toBe('screening:older-policy')
    expect(item.freshness.current).toBe(false)
    expect(item.freshness.reasons).toContain('model-changed')
    // The current policy key is what the surface compares against, so the reason is about the policy
    // and not about a coincidence.
    expect(SCREENING_PROMPT_POLICY_KEY).not.toBe('screening:older-policy')
  })
})

describe('ScreeningService projection', () => {
  it('never returns more evidence rows than candidates, and lists the collection it was asked about', async () => {
    const { service } = build([reference('ref-a')])
    await service.appendRuleRevision({ collectionId: COLLECTION, inclusion, exclusion })
    const snapshot = await service.snapshot(COLLECTION)

    expect(snapshot.collectionId).toBe(COLLECTION)
    expect(snapshot.summary.searchedCount).toBeGreaterThanOrEqual(snapshot.summary.candidateCount)
    expect(snapshot.items).toHaveLength(snapshot.summary.candidateCount)
    expect(snapshot.lastRun).toBeNull()
    expect(snapshot.lastError).toBeNull()
  })

  it('records a named failure per item without taking the pass down', async () => {
    const { service } = build([reference('ref-a'), reference('ref-b')], {
      runner: {
        model: 'stub-model-v1',
        run: async (prompt: string) => {
          if (prompt.includes('ref-a')) throw new Error('provider refused the request')
          return { text: UNCERTAIN_ANSWER }
        }
      }
    })
    await service.appendRuleRevision({ collectionId: COLLECTION, inclusion, exclusion })
    await service.startRun({ collectionId: COLLECTION })
    const snapshot = await pollUntilIdle(service)

    expect(snapshot.lastRun?.failed).toBe(1)
    expect(snapshot.lastRun?.assessed).toBe(1)
    // A failed pass says so, and the one failure is reported verbatim instead of vanishing.
    expect(snapshot.lastRun?.run.status).toBe('failed')
    expect(snapshot.lastError).toContain('ref-a')
    const items = await service.listRuleRevisions(COLLECTION)
    expect(items).toHaveLength(1)
  })

  it('keeps the run item ledger honest: every item ends in a named state', async () => {
    const { service, repository } = build([reference('ref-a'), reference('ref-b')], {
      runner: verdictRunner({ 'ref-a': INCLUDED_ANSWER, 'ref-b': UNCERTAIN_ANSWER })
    })
    await service.appendRuleRevision({ collectionId: COLLECTION, inclusion, exclusion })
    const started = await service.startRun({ collectionId: COLLECTION })
    await pollUntilIdle(service)

    const rows = await repository.listRunItems(started.runId)
    expect(rows.map((item) => [item.referenceId, item.state] as const)).toEqual([
      ['ref-a', 'assessed'],
      ['ref-b', 'assessed']
    ])
    expect(rows.every((item: { state: ScreeningRunItemState }) => item.state !== 'pending')).toBe(
      true
    )
  })
})
