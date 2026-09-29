import { describe, expect, it } from 'vitest'

import type { Reference } from '../../shared/references'
import type {
  ScreeningAssessment,
  ScreeningRun,
  ScreeningRunItem
} from '../../shared/references-screening'
import { screeningRuleContentHash } from './screening-rules'
import {
  SCREENING_DEFAULT_CONCURRENCY,
  ScreeningEngine,
  ScreeningTransportError,
  createScreeningLimiter,
  type ScreeningEngineRepository,
  type ScreeningModelRunner
} from './screening-engine'
import { SCREENING_PROMPT_POLICY_KEY } from './screening-prompt'

// The engine's own rules, asserted with a stub model (no network) and an in-memory ledger (no
// Prisma): the coverage guard is on the decision path and cannot be bypassed, at most four records
// are in flight, one bad record does not take the pass down, and a resume re-evaluates exactly the
// records whose grounds moved.

const inclusion = [
  { id: 'i-1', text: '研究对象为成年人' },
  { id: 'i-2', text: '英文或中文全文' }
]
const exclusion = [{ id: 'e-1', text: '综述、社论、病例报告' }]
const rule = {
  revision: 1,
  inclusion,
  exclusion,
  contentHash: screeningRuleContentHash(inclusion, exclusion)
}

const INCLUDED = JSON.stringify({
  verdict: 'included',
  probabilities: { include: 0.9, exclude: 0.05, uncertain: 0.05 },
  citations: [{ criterionId: 'i-1', quote: 'We enrolled 120 adults.', locator: 'p.2' }],
  refutation: null
})

const EXCLUDED = JSON.stringify({
  verdict: 'excluded',
  probabilities: { exclude: 0.9 },
  citations: [],
  refutation: { criterionId: 'e-1', quote: 'This article is a systematic review.' }
})

const reference = (id: string, overrides: Partial<Reference> = {}): Reference => ({
  id,
  projectId: 'project-1',
  title: `Title for ${id}`,
  authors: [{ name: 'Ada Lovelace' }],
  venue: 'Journal of Tests',
  year: 2024,
  doi: `10.1000/${id}`,
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

// An in-memory stand-in for the S1 repository, carrying the same three invariants the engine relies
// on (items only while running, a finished run cannot be reopened) so a regression in how the engine
// drives the ledger shows up here rather than in production.
type FakeLedger = {
  repository: ScreeningEngineRepository
  runs: Map<string, ScreeningRun>
  items: Map<string, Map<string, ScreeningRunItem>>
  assessments: Map<string, ScreeningAssessment>
}

const createFakeLedger = (): FakeLedger => {
  const runs = new Map<string, ScreeningRun>()
  const items = new Map<string, Map<string, ScreeningRunItem>>()
  const assessments = new Map<string, ScreeningAssessment>()
  let sequence = 0

  const repository: ScreeningEngineRepository = {
    getRun: (runId) => Promise.resolve(runs.get(runId) ?? null),
    startRun: (input) => {
      sequence += 1
      const id = `run-${sequence}`
      const run: ScreeningRun = {
        id,
        collectionId: input.collectionId,
        ruleRevision: input.ruleRevision,
        startedAt: sequence,
        status: 'running'
      }
      runs.set(id, run)
      const bucket = new Map<string, ScreeningRunItem>()
      for (const item of input.items) {
        bucket.set(item.referenceId, {
          runId: id,
          referenceId: item.referenceId,
          state: 'pending',
          inputDigest: item.inputDigest
        })
      }
      items.set(id, bucket)
      return Promise.resolve(run)
    },
    listRunItems: (runId) => Promise.resolve([...(items.get(runId)?.values() ?? [])]),
    recordRunItem: (input) => {
      const run = runs.get(input.runId)
      if (!run) return Promise.reject(new Error(`Screening run ${input.runId} not found.`))
      if (run.status !== 'running') {
        return Promise.reject(
          new Error(`Screening run ${input.runId} is ${run.status}; items cannot be recorded.`)
        )
      }
      const bucket = items.get(input.runId) ?? new Map<string, ScreeningRunItem>()
      const prior = bucket.get(input.referenceId)
      const next: ScreeningRunItem = {
        runId: input.runId,
        referenceId: input.referenceId,
        state: input.state,
        failureKind: input.failureKind,
        deferredReason: input.deferredReason,
        inputDigest: input.inputDigest ?? prior?.inputDigest
      }
      bucket.set(input.referenceId, next)
      items.set(input.runId, bucket)
      return Promise.resolve(next)
    },
    upsertAssessment: (input) => {
      const assessment: ScreeningAssessment = {
        collectionId: input.collectionId,
        referenceId: input.referenceId,
        ruleRevision: input.ruleRevision,
        inputDigest: input.inputDigest,
        policyKey: input.policyKey,
        model: input.model,
        verdict: input.verdict,
        probabilities: input.probabilities ?? {},
        evidence: [...(input.evidence ?? [])],
        decidedAt: input.decidedAt ?? 0
      }
      assessments.set(`${input.collectionId}:${input.referenceId}`, assessment)
      return Promise.resolve(assessment)
    },
    finishRun: (runId, status, finishedAt) => {
      const run = runs.get(runId)
      if (!run) return Promise.reject(new Error(`Screening run ${runId} not found.`))
      if (run.status !== 'running') {
        return Promise.reject(new Error(`Screening run ${runId} is already ${run.status}.`))
      }
      const finished: ScreeningRun = { ...run, status, finishedAt: finishedAt ?? sequence }
      runs.set(runId, finished)
      const pending = [...(items.get(runId)?.values() ?? [])].filter(
        (item) => item.state === 'pending'
      ).length
      return Promise.resolve({ run: finished, unprocessedCount: pending })
    }
  }

  return { repository, runs, items, assessments }
}

type StubRunner = {
  runner: ScreeningModelRunner
  prompts: string[]
  stats: () => { calls: number; peak: number }
}

const createStubRunner = (
  respond: (prompt: string, index: number) => string | Error
): StubRunner => {
  const prompts: string[] = []
  let calls = 0
  let active = 0
  let peak = 0
  const runner: ScreeningModelRunner = {
    model: 'stub-model',
    run: async (prompt) => {
      calls += 1
      prompts.push(prompt)
      active += 1
      peak = Math.max(peak, active)
      try {
        // A real yield: without it every admitted call would run to completion synchronously and the
        // concurrency ceiling below would prove nothing.
        await new Promise((resolve) => setTimeout(resolve, 5))
        const result = respond(prompt, calls)
        if (result instanceof Error) throw result
        return { text: result }
      } finally {
        active -= 1
      }
    }
  }
  return { runner, prompts, stats: () => ({ calls, peak }) }
}

type HarnessConfig = {
  references: Array<Reference | null>
  fullTexts?: Record<string, string>
  respond?: (prompt: string, index: number) => string | Error
  budget?: number
}

type Harness = FakeLedger & {
  engine: ScreeningEngine
  stub: StubRunner
  fullTexts: Record<string, string>
}

const createHarness = (config: HarnessConfig): Harness => {
  const byId = new Map<string, Reference>()
  for (const entry of config.references) if (entry) byId.set(entry.id, entry)
  // Mutable on purpose: a resume test changes the evidence on hand between passes.
  const fullTexts: Record<string, string> = { ...(config.fullTexts ?? {}) }
  const ledger = createFakeLedger()
  const stub = createStubRunner(config.respond ?? (() => INCLUDED))
  const engine = new ScreeningEngine({
    repository: ledger.repository,
    runner: stub.runner,
    loadReference: (referenceId) => Promise.resolve(byId.get(referenceId) ?? null),
    readFullText: (entry) => Promise.resolve(fullTexts[entry.id] ?? null),
    now: () => 1_700_000_000_000,
    ...(config.budget === undefined ? {} : { inputCharBudget: config.budget })
  })
  return { engine, stub, fullTexts, ...ledger }
}

const fullTextFor = (id: string): string => `Body of ${id}. We enrolled 120 adults aged 18-65.`

describe('ScreeningEngine — one assessment per candidate', () => {
  it('writes an assessment carrying the policy identity, model and evidence', async () => {
    const harness = createHarness({
      references: [reference('ref-a'), reference('ref-b')],
      fullTexts: { 'ref-a': fullTextFor('ref-a'), 'ref-b': fullTextFor('ref-b') }
    })
    const report = await harness.engine.screen({
      collectionId: 'col-1',
      rule,
      referenceIds: ['ref-a', 'ref-b']
    })

    expect(report.status).toBe('completed')
    expect(report.counts).toEqual({ assessed: 2, skipped: 0, deferred: 0, failed: 0 })
    const assessment = harness.assessments.get('col-1:ref-a')
    expect(assessment?.verdict).toBe('included')
    expect(assessment?.policyKey).toBe(SCREENING_PROMPT_POLICY_KEY)
    expect(assessment?.model).toBe('stub-model')
    expect(assessment?.ruleRevision).toBe(1)
    expect(assessment?.inputDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(assessment?.evidence).toEqual([
      {
        criterionId: 'i-1',
        coverage: 'full-text',
        quote: 'We enrolled 120 adults.',
        locator: 'p.2'
      }
    ])
  })

  it('hands the model record text only inside the untrusted data zone', async () => {
    const harness = createHarness({
      references: [reference('ref-a')],
      fullTexts: { 'ref-a': fullTextFor('ref-a') }
    })
    await harness.engine.screen({ collectionId: 'col-1', rule, referenceIds: ['ref-a'] })

    const prompt = harness.stub.prompts[0] ?? ''
    const dataZoneStart = prompt.indexOf('<literature_evidence')
    expect(dataZoneStart).toBeGreaterThan(0)
    const instructionZone = prompt.slice(0, dataZoneStart)
    // Guardrail ① end to end: the record's own title and body never reach the instruction zone.
    expect(instructionZone).not.toContain('Title for ref-a')
    expect(instructionZone).not.toContain('We enrolled 120 adults')
    expect(prompt.slice(dataZoneStart)).toContain('Title for ref-a')
  })

  it('states the coverage tier it actually has to the model', async () => {
    const harness = createHarness({
      references: [reference('ref-a', { abstractSnippet: 'We enrolled 120 adults.' })]
    })
    await harness.engine.screen({ collectionId: 'col-1', rule, referenceIds: ['ref-a'] })
    expect(harness.stub.prompts[0]).toContain('coverage="abstract-only"')
  })
})

describe('ScreeningEngine — guardrail ②: no full text ⇒ needs-review, never excluded', () => {
  it.each([
    ['abstract-only', { abstractSnippet: 'We enrolled 120 adults.' }, undefined],
    ['metadata-only', {}, undefined]
  ] as const)(
    'degrades a model exclusion to needs-review when the coverage is %s',
    async (coverage, overrides, fullText) => {
      const harness = createHarness({
        references: [reference('ref-a', overrides)],
        fullTexts: fullText === undefined ? {} : { 'ref-a': fullText },
        respond: () => EXCLUDED
      })
      const report = await harness.engine.screen({
        collectionId: 'col-1',
        rule,
        referenceIds: ['ref-a']
      })

      expect(report.outcomes[0]?.coverage).toBe(coverage)
      expect(report.outcomes[0]?.verdict).toBe('needs-review')
      expect(report.outcomes[0]?.reasons).toContain('missing-evidence')
      expect(harness.assessments.get('col-1:ref-a')?.verdict).toBe('needs-review')
    }
  )

  it('keeps a model exclusion when the coverage is full-text', async () => {
    const harness = createHarness({
      references: [reference('ref-a')],
      fullTexts: { 'ref-a': fullTextFor('ref-a') },
      respond: () => EXCLUDED
    })
    await harness.engine.screen({ collectionId: 'col-1', rule, referenceIds: ['ref-a'] })
    expect(harness.assessments.get('col-1:ref-a')?.verdict).toBe('excluded')
  })

  it('records nothing decided, and calls no model, when there is no evidence at all', async () => {
    const harness = createHarness({ references: [null] })
    const report = await harness.engine.screen({
      collectionId: 'col-1',
      rule,
      referenceIds: ['ref-missing']
    })

    expect(report.outcomes[0]?.status).toBe('deferred')
    expect(report.outcomes[0]?.coverage).toBe('unavailable')
    expect(report.outcomes[0]?.reasons).toEqual(['missing-evidence'])
    expect(harness.stub.stats().calls).toBe(0)
    expect(harness.assessments.size).toBe(0)
    expect([...(harness.items.get(report.runId)?.values() ?? [])][0]?.state).toBe('deferred')
  })

  it('defers an over-budget record by name instead of truncating its evidence', async () => {
    const harness = createHarness({
      references: [reference('ref-a')],
      fullTexts: { 'ref-a': fullTextFor('ref-a') },
      budget: 10
    })
    const report = await harness.engine.screen({
      collectionId: 'col-1',
      rule,
      referenceIds: ['ref-a']
    })
    expect(report.outcomes[0]?.status).toBe('deferred')
    expect(report.outcomes[0]?.reasons).toEqual(['input-too-long'])
    expect(harness.stub.stats().calls).toBe(0)
  })
})

describe('ScreeningEngine — concurrency ceiling', () => {
  it('keeps at most four records in flight and actually reaches four', async () => {
    const ids = Array.from({ length: 9 }, (_, index) => `ref-${index}`)
    const harness = createHarness({
      references: ids.map((id) => reference(id)),
      fullTexts: Object.fromEntries(ids.map((id) => [id, fullTextFor(id)]))
    })
    const report = await harness.engine.screen({ collectionId: 'col-1', rule, referenceIds: ids })

    expect(SCREENING_DEFAULT_CONCURRENCY).toBe(4)
    expect(harness.stub.stats().calls).toBe(9)
    expect(harness.stub.stats().peak).toBe(4)
    expect(report.counts.assessed).toBe(9)
  })

  it('admits only maxConcurrent tasks and releases waiters in order', async () => {
    const limiter = createScreeningLimiter(2)
    let active = 0
    let peak = 0
    const finished: number[] = []
    await Promise.all(
      [0, 1, 2, 3].map((index) =>
        limiter(async () => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise((resolve) => setTimeout(resolve, 2))
          active -= 1
          finished.push(index)
        })
      )
    )
    expect(peak).toBe(2)
    expect(finished).toEqual([0, 1, 2, 3])
  })

  it('refuses a nonsense concurrency instead of running unbounded', () => {
    expect(() => createScreeningLimiter(0)).toThrow(/positive integer/)
    expect(() => createScreeningLimiter(1.5)).toThrow(/positive integer/)
  })
})

describe('ScreeningEngine — a failed record does not take the pass down', () => {
  it('records the failure by name and still assesses the rest', async () => {
    const harness = createHarness({
      references: [reference('ref-a'), reference('ref-b'), reference('ref-c')],
      fullTexts: {
        'ref-a': fullTextFor('ref-a'),
        'ref-b': fullTextFor('ref-b'),
        'ref-c': fullTextFor('ref-c')
      },
      respond: (prompt) => (prompt.includes('ref-b') ? new Error('model exploded') : INCLUDED)
    })
    const report = await harness.engine.screen({
      collectionId: 'col-1',
      rule,
      referenceIds: ['ref-a', 'ref-b', 'ref-c']
    })

    const failed = report.outcomes.find((outcome) => outcome.referenceId === 'ref-b')
    expect(failed?.status).toBe('failed')
    expect(failed?.failureKind).toBe('model-error')
    expect(failed?.message).toBe('model exploded')
    expect(report.counts).toEqual({ assessed: 2, skipped: 0, deferred: 0, failed: 1 })
    expect(report.status).toBe('failed')
    expect(harness.assessments.has('col-1:ref-a')).toBe(true)
    expect(harness.assessments.has('col-1:ref-c')).toBe(true)
    expect(harness.assessments.has('col-1:ref-b')).toBe(false)
  })

  it('keeps a transport failure recognisable so a resume can retry it immediately', async () => {
    const harness = createHarness({
      references: [reference('ref-a')],
      fullTexts: { 'ref-a': fullTextFor('ref-a') },
      respond: () => new ScreeningTransportError('socket closed')
    })
    const report = await harness.engine.screen({
      collectionId: 'col-1',
      rule,
      referenceIds: ['ref-a']
    })
    expect(report.outcomes[0]?.failureKind).toBe('transport-error')
  })

  it('treats an unparseable answer as a named failure, not as a decision', async () => {
    const harness = createHarness({
      references: [reference('ref-a')],
      fullTexts: { 'ref-a': fullTextFor('ref-a') },
      respond: () => 'I would include this one.'
    })
    const report = await harness.engine.screen({
      collectionId: 'col-1',
      rule,
      referenceIds: ['ref-a']
    })
    expect(report.outcomes[0]?.status).toBe('failed')
    expect(report.outcomes[0]?.failureKind).toBe('invalid-response')
    expect(harness.assessments.size).toBe(0)
  })
})

describe('ScreeningEngine — resume re-evaluates exactly what changed', () => {
  it('skips an unchanged record and re-evaluates a changed one, naming input-changed', async () => {
    const harness = createHarness({
      references: [reference('ref-a'), reference('ref-b')],
      fullTexts: { 'ref-a': fullTextFor('ref-a'), 'ref-b': fullTextFor('ref-b') }
    })

    const first = await harness.engine.screen({
      collectionId: 'col-1',
      rule,
      referenceIds: ['ref-a', 'ref-b'],
      finalize: false
    })
    expect(harness.stub.stats().calls).toBe(2)
    expect(first.status).toBe('running')

    // ref-b's evidence moves; ref-a's does not.
    harness.fullTexts['ref-b'] = `${fullTextFor('ref-b')} Revised.`

    const report = await harness.engine.screen({
      collectionId: 'col-1',
      rule,
      referenceIds: ['ref-a', 'ref-b'],
      runId: first.runId
    })

    // Exactly one further model call: the skipped record cost nothing.
    expect(harness.stub.stats().calls).toBe(3)
    const skipped = report.outcomes.find((outcome) => outcome.referenceId === 'ref-a')
    expect(skipped?.status).toBe('skipped')
    expect(skipped?.resume).toBe('unchanged')
    const changed = report.outcomes.find((outcome) => outcome.referenceId === 'ref-b')
    expect(changed?.status).toBe('assessed')
    expect(changed?.resume).toBe('input-changed')
    expect(changed?.reasons).toContain('input-changed')
    expect(report.counts).toEqual({ assessed: 1, skipped: 1, deferred: 0, failed: 0 })
    expect(report.status).toBe('completed')
  })

  it('re-evaluates the whole collection when the rules change', async () => {
    const harness = createHarness({
      references: [reference('ref-a')],
      fullTexts: { 'ref-a': fullTextFor('ref-a') }
    })
    const first = await harness.engine.screen({
      collectionId: 'col-1',
      rule,
      referenceIds: ['ref-a'],
      finalize: false
    })

    const nextInclusion = [...inclusion, { id: 'i-3', text: '样本量 ≥ 50' }]
    const nextRule = {
      revision: 2,
      inclusion: nextInclusion,
      exclusion,
      contentHash: screeningRuleContentHash(nextInclusion, exclusion)
    }
    const report = await harness.engine.screen({
      collectionId: 'col-1',
      rule: nextRule,
      referenceIds: ['ref-a'],
      runId: first.runId
    })

    expect(report.outcomes[0]?.resume).toBe('input-changed')
    expect(report.outcomes[0]?.status).toBe('assessed')
    expect(harness.stub.stats().calls).toBe(2)
  })

  it('retries a failed record even when its input digest is unchanged', async () => {
    const harness = createHarness({
      references: [reference('ref-a')],
      fullTexts: { 'ref-a': fullTextFor('ref-a') },
      respond: () => new ScreeningTransportError('timeout')
    })
    const first = await harness.engine.screen({
      collectionId: 'col-1',
      rule,
      referenceIds: ['ref-a'],
      finalize: false
    })
    expect(first.counts.failed).toBe(1)

    // The same ledger and the same evidence — only the model transport recovered.
    const retry = new ScreeningEngine({
      repository: harness.repository,
      runner: createStubRunner(() => INCLUDED).runner,
      loadReference: () => Promise.resolve(reference('ref-a')),
      readFullText: () => Promise.resolve(fullTextFor('ref-a'))
    })
    const report = await retry.screen({
      collectionId: 'col-1',
      rule,
      referenceIds: ['ref-a'],
      runId: first.runId
    })

    expect(report.outcomes[0]?.resume).toBe('retry')
    expect(report.outcomes[0]?.status).toBe('assessed')
    expect(harness.assessments.get('col-1:ref-a')?.verdict).toBe('included')
  })

  it('refuses to resume a pass that has already finished', async () => {
    const harness = createHarness({
      references: [reference('ref-a')],
      fullTexts: { 'ref-a': fullTextFor('ref-a') }
    })
    const first = await harness.engine.screen({
      collectionId: 'col-1',
      rule,
      referenceIds: ['ref-a']
    })
    await expect(
      harness.engine.screen({
        collectionId: 'col-1',
        rule,
        referenceIds: ['ref-a'],
        runId: first.runId
      })
    ).rejects.toThrow(/is completed/)
  })
})

describe('ScreeningEngine — the ledger is closed honestly', () => {
  it('reports the items a pass never reached instead of counting them as done', async () => {
    const harness = createHarness({
      references: [reference('ref-a'), reference('ref-b')],
      fullTexts: { 'ref-a': fullTextFor('ref-a'), 'ref-b': fullTextFor('ref-b') }
    })
    // A pass opened for three candidates but driven for two: the third stays 'pending'.
    const run = await harness.repository.startRun({
      collectionId: 'col-1',
      ruleRevision: 1,
      items: [{ referenceId: 'ref-a' }, { referenceId: 'ref-b' }, { referenceId: 'ref-c' }]
    })
    const report = await harness.engine.screen({
      collectionId: 'col-1',
      rule,
      referenceIds: ['ref-a', 'ref-b'],
      runId: run.id
    })
    expect(report.unprocessedCount).toBe(1)
    expect(report.status).toBe('completed')
  })

  it('leaves the run open when the caller asks it not to finalize', async () => {
    const harness = createHarness({
      references: [reference('ref-a')],
      fullTexts: { 'ref-a': fullTextFor('ref-a') }
    })
    const report = await harness.engine.screen({
      collectionId: 'col-1',
      rule,
      referenceIds: ['ref-a'],
      finalize: false
    })
    expect(report.status).toBe('running')
    expect(harness.runs.get(report.runId)?.status).toBe('running')
  })

  it('evaluates a repeated reference id once', async () => {
    const harness = createHarness({
      references: [reference('ref-a')],
      fullTexts: { 'ref-a': fullTextFor('ref-a') }
    })
    const report = await harness.engine.screen({
      collectionId: 'col-1',
      rule,
      referenceIds: ['ref-a', 'ref-a']
    })
    expect(harness.stub.stats().calls).toBe(1)
    expect(report.outcomes).toHaveLength(1)
  })
})
