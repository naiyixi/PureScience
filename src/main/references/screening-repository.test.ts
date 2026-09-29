import { describe, expect, it, vi, type Mock } from 'vitest'

import type { ScreeningCriterion } from '../../shared/references-screening'
import { screeningRuleContentHash } from './screening-rules'
import {
  ScreeningRepository,
  type ScreeningClient,
  type StoredScreeningRunRow
} from './screening-repository'

// Three invariants carry this layer, and each one is asserted here rather than assumed:
//   1. a rule revision is immutable — writing the same (collectionId, revision) twice throws;
//   2. an override never writes to the assessment layer it layers over;
//   3. a run's items are written only while it runs, and its finish time is written once.
// The client is mocked (only the five delegates the repository declares), so these are the repository's
// own rules, not the engine's behavior.

const createdAt = new Date(1710000000000)

const inclusion: ScreeningCriterion[] = [
  { id: 'i-1', text: '英文或中文全文' },
  { id: 'i-2', text: '研究对象为成年人' }
]
const exclusion: ScreeningCriterion[] = [{ id: 'e-1', text: '综述、社论、病例报告' }]

const ruleRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  collectionId: 'col-1',
  revision: 1,
  inclusionJson: JSON.stringify(inclusion),
  exclusionJson: JSON.stringify(exclusion),
  contentHash: screeningRuleContentHash(inclusion, exclusion),
  createdAt,
  ...overrides
})

const assessmentRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  collectionId: 'col-1',
  referenceId: 'ref-1',
  ruleRevision: 3,
  inputDigest: 'digest-a',
  policyKey: 'policy-v1',
  model: 'model-x',
  verdict: 'included',
  probabilitiesJson: '{"include":0.91}',
  evidenceJson: '[{"criterionId":"i-1","coverage":"full-text","quote":"held out","locator":"p.3"}]',
  decidedAt: createdAt,
  ...overrides
})

const overrideRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  collectionId: 'col-1',
  referenceId: 'ref-1',
  decision: 'exclude',
  reason: 'population does not match',
  actor: 'user',
  createdAt,
  ...overrides
})

const runRow = (overrides: Partial<StoredScreeningRunRow> = {}): Record<string, unknown> => ({
  id: 'run-1',
  collectionId: 'col-1',
  ruleRevision: 3,
  startedAt: createdAt,
  finishedAt: null,
  status: 'running',
  ...overrides
})

const runItemRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  runId: 'run-1',
  referenceId: 'ref-1',
  state: 'pending',
  failureKind: null,
  deferredReason: null,
  inputDigest: null,
  ...overrides
})

const createMockClient = (): { client: ScreeningClient; m: Record<string, Mock> } => {
  const m: Record<string, Mock> = {
    ruleFindUnique: vi.fn(() => Promise.resolve(null)),
    ruleFindFirst: vi.fn(() => Promise.resolve(null)),
    ruleFindMany: vi.fn(() => Promise.resolve([])),
    ruleCreate: vi.fn(),
    assessmentUpsert: vi.fn(),
    assessmentFindUnique: vi.fn(() => Promise.resolve(null)),
    assessmentFindMany: vi.fn(() => Promise.resolve([])),
    overrideUpsert: vi.fn(),
    overrideFindUnique: vi.fn(() => Promise.resolve(null)),
    overrideFindMany: vi.fn(() => Promise.resolve([])),
    overrideDeleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
    runCreate: vi.fn(),
    runFindUnique: vi.fn(() => Promise.resolve(null)),
    runFindMany: vi.fn(() => Promise.resolve([])),
    runUpdate: vi.fn(),
    itemCreateMany: vi.fn(() => Promise.resolve({ count: 0 })),
    itemUpsert: vi.fn(),
    itemFindMany: vi.fn(() => Promise.resolve([])),
    itemCount: vi.fn(() => Promise.resolve(0))
  }
  const client = {
    screeningRuleRevision: {
      findUnique: m.ruleFindUnique,
      findFirst: m.ruleFindFirst,
      findMany: m.ruleFindMany,
      create: m.ruleCreate
    },
    screeningAssessment: {
      upsert: m.assessmentUpsert,
      findUnique: m.assessmentFindUnique,
      findMany: m.assessmentFindMany
    },
    screeningOverride: {
      upsert: m.overrideUpsert,
      findUnique: m.overrideFindUnique,
      findMany: m.overrideFindMany,
      deleteMany: m.overrideDeleteMany
    },
    screeningRun: {
      create: m.runCreate,
      findUnique: m.runFindUnique,
      findMany: m.runFindMany,
      update: m.runUpdate
    },
    screeningRunItem: {
      createMany: m.itemCreateMany,
      upsert: m.itemUpsert,
      findMany: m.itemFindMany,
      count: m.itemCount
    }
  } as unknown as ScreeningClient
  return { client, m }
}

const repositoryFor = (client: ScreeningClient): ScreeningRepository =>
  new ScreeningRepository(() => Promise.resolve(client))

describe('ScreeningRepository rule revisions', () => {
  it('writes a revision with canonically ordered criteria and a hash over them', async () => {
    const { client, m } = createMockClient()
    m.ruleCreate.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...args.data, createdAt })
    )

    const revision = await repositoryFor(client).createRuleRevision({
      collectionId: 'col-1',
      revision: 1,
      inclusion: [...inclusion].reverse(),
      exclusion
    })

    const call = m.ruleCreate.mock.calls[0][0] as { data: Record<string, unknown> }
    expect(call.data.inclusionJson).toBe(JSON.stringify(inclusion))
    expect(call.data.exclusionJson).toBe(JSON.stringify(exclusion))
    expect(call.data.contentHash).toBe(screeningRuleContentHash(inclusion, exclusion))
    expect(revision).toMatchObject({
      collectionId: 'col-1',
      revision: 1,
      inclusion,
      createdAt: 1710000000000
    })
  })

  it('refuses a second write of the same (collectionId, revision) instead of overwriting it', async () => {
    const { client, m } = createMockClient()
    m.ruleFindUnique.mockResolvedValue(ruleRow({ revision: 2 }))

    await expect(
      repositoryFor(client).createRuleRevision({
        collectionId: 'col-1',
        revision: 2,
        inclusion: [{ id: 'i-1', text: 'rewritten' }],
        exclusion: []
      })
    ).rejects.toThrow(/revision 2 already exists for collection col-1; revisions are immutable/)

    expect(m.ruleCreate).not.toHaveBeenCalled()
  })

  it('rejects a revision number that is not a positive integer', async () => {
    const { client, m } = createMockClient()
    const repository = repositoryFor(client)

    await expect(
      repository.createRuleRevision({ collectionId: 'col-1', revision: 0, inclusion, exclusion })
    ).rejects.toThrow(/must be a positive integer, got 0/)
    await expect(
      repository.createRuleRevision({ collectionId: 'col-1', revision: 1.5, inclusion, exclusion })
    ).rejects.toThrow(/must be a positive integer, got 1.5/)
    expect(m.ruleCreate).not.toHaveBeenCalled()
  })

  it('appends one revision past the newest, starting at 1', async () => {
    const { client, m } = createMockClient()
    m.ruleCreate.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...args.data, createdAt })
    )

    const first = await repositoryFor(client).appendRuleRevision({
      collectionId: 'col-1',
      inclusion,
      exclusion
    })
    expect(first.revision).toBe(1)

    m.ruleFindFirst.mockResolvedValue(ruleRow({ revision: 3, contentHash: 'other-hash' }))
    const next = await repositoryFor(client).appendRuleRevision({
      collectionId: 'col-1',
      inclusion,
      exclusion
    })
    expect(next.revision).toBe(4)
    expect(m.ruleCreate).toHaveBeenCalledTimes(2)
  })

  it('returns the current revision untouched when the same rule is saved again, reorder included', async () => {
    const { client, m } = createMockClient()
    m.ruleFindFirst.mockResolvedValue(ruleRow({ revision: 3 }))

    const appended = await repositoryFor(client).appendRuleRevision({
      collectionId: 'col-1',
      inclusion: [...inclusion].reverse(),
      exclusion
    })

    expect(appended).toMatchObject({
      revision: 3,
      contentHash: screeningRuleContentHash(inclusion, exclusion)
    })
    // Nothing changed, so nothing new is written: stacking a revision that differs only in its number
    // would stale every decision in the collection for no reason.
    expect(m.ruleCreate).not.toHaveBeenCalled()
  })

  it('appends when the rule set actually changed', async () => {
    const { client, m } = createMockClient()
    m.ruleFindFirst.mockResolvedValue(ruleRow({ revision: 3, contentHash: 'other-hash' }))
    m.ruleCreate.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...args.data, createdAt })
    )

    const appended = await repositoryFor(client).appendRuleRevision({
      collectionId: 'col-1',
      inclusion: [...inclusion, { id: 'i-3', text: '原始研究' }],
      exclusion
    })
    expect(appended.revision).toBe(4)
    expect(m.ruleCreate).toHaveBeenCalledTimes(1)
  })

  it('reads revisions oldest-first and the latest by number', async () => {
    const { client, m } = createMockClient()
    m.ruleFindMany.mockResolvedValue([ruleRow(), ruleRow({ revision: 2 })])
    m.ruleFindFirst.mockResolvedValue(ruleRow({ revision: 2 }))
    m.ruleFindUnique.mockResolvedValue(ruleRow({ revision: 2 }))
    const repository = repositoryFor(client)

    await expect(repository.listRuleRevisions('col-1')).resolves.toHaveLength(2)
    expect(m.ruleFindMany).toHaveBeenCalledWith({
      where: { collectionId: 'col-1' },
      orderBy: { revision: 'asc' }
    })
    await expect(repository.latestRuleRevision('col-1')).resolves.toMatchObject({ revision: 2 })
    expect(m.ruleFindFirst).toHaveBeenCalledWith({
      where: { collectionId: 'col-1' },
      orderBy: { revision: 'desc' }
    })
    await expect(repositoryFor(client).getRuleRevision('col-1', 2)).resolves.toMatchObject({
      revision: 2
    })
  })
})

describe('ScreeningRepository assessments', () => {
  it('upserts on (collectionId, referenceId) so one reference keeps one current verdict', async () => {
    const { client, m } = createMockClient()
    m.assessmentUpsert.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...assessmentRow(), ...(args.data as object) })
    )

    const assessment = await repositoryFor(client).upsertAssessment({
      collectionId: 'col-1',
      referenceId: 'ref-1',
      ruleRevision: 3,
      inputDigest: 'digest-a',
      policyKey: 'policy-v1',
      model: 'model-x',
      verdict: 'included',
      probabilities: { include: 0.91 },
      evidence: [{ criterionId: 'i-1', coverage: 'full-text', quote: 'held out', locator: 'p.3' }],
      decidedAt: 1_710_000_000_000
    })

    const call = m.assessmentUpsert.mock.calls[0][0] as {
      where: Record<string, unknown>
      create: Record<string, unknown>
      update: Record<string, unknown>
    }
    expect(call.where).toEqual({
      collectionId_referenceId: { collectionId: 'col-1', referenceId: 'ref-1' }
    })
    expect(call.create).toMatchObject({ collectionId: 'col-1', referenceId: 'ref-1' })
    expect(call.update).not.toHaveProperty('collectionId')
    expect(call.create).toMatchObject({
      verdict: 'included',
      probabilitiesJson: '{"include":0.91}',
      decidedAt: new Date(1_710_000_000_000)
    })
    expect(assessment.evidence).toEqual([
      { criterionId: 'i-1', coverage: 'full-text', quote: 'held out', locator: 'p.3' }
    ])
  })

  it('defaults probabilities and evidence, keeping the raw model output beside a guarded verdict', async () => {
    const { client, m } = createMockClient()
    m.assessmentUpsert.mockImplementation((args: { create: Record<string, unknown> }) =>
      Promise.resolve({ ...assessmentRow(), ...(args.create as object) })
    )

    const assessment = await repositoryFor(client).upsertAssessment({
      collectionId: 'col-1',
      referenceId: 'ref-2',
      ruleRevision: 3,
      inputDigest: 'digest-b',
      policyKey: 'policy-v1',
      model: 'model-x',
      // What the guard stored: the model said excluded, the abstract did not license it.
      verdict: 'needs-review',
      probabilities: { exclude: 0.72, uncertain: 0.28 }
    })

    const call = m.assessmentUpsert.mock.calls[0][0] as { create: Record<string, unknown> }
    expect(call.create.evidenceJson).toBe('[]')
    expect(assessment).toMatchObject({
      verdict: 'needs-review',
      probabilities: { exclude: 0.72, uncertain: 0.28 },
      evidence: []
    })
    expect(assessment.probabilities.include).toBeUndefined()
  })

  it('reads an unrecognized stored verdict as not-evaluated and unusable payloads as empty', async () => {
    const { client, m } = createMockClient()
    m.assessmentFindUnique.mockResolvedValue(
      assessmentRow({
        verdict: 'maybe',
        probabilitiesJson: 'not json',
        evidenceJson:
          '[{"quote":"no criterion"},{"criterionId":"i-1","quote":"ok","coverage":"weird"}]'
      })
    )

    const assessment = await repositoryFor(client).getAssessment('col-1', 'ref-1')
    expect(assessment).toMatchObject({ verdict: 'not-evaluated', probabilities: {} })
    // A citation with no criterion is dropped rather than attributed to a criterion it never named, and
    // an unreadable coverage falls back to the weakest tier instead of claiming more evidence than the
    // row proves.
    expect(assessment?.evidence).toEqual([
      { criterionId: 'i-1', coverage: 'unavailable', quote: 'ok' }
    ])
  })

  it('lists assessments for a collection', async () => {
    const { client, m } = createMockClient()
    m.assessmentFindMany.mockResolvedValue([assessmentRow()])

    await expect(repositoryFor(client).listAssessments('col-1')).resolves.toHaveLength(1)
    expect(m.assessmentFindMany).toHaveBeenCalledWith({
      where: { collectionId: 'col-1' },
      orderBy: { referenceId: 'asc' }
    })
  })
})

describe('ScreeningRepository override layering', () => {
  it('writes only the override layer, never the verdict it overrides', async () => {
    const { client, m } = createMockClient()
    m.overrideUpsert.mockImplementation((args: { create: Record<string, unknown> }) =>
      Promise.resolve({ ...overrideRow(), ...(args.create as object) })
    )

    const override = await repositoryFor(client).setOverride({
      collectionId: 'col-1',
      referenceId: 'ref-1',
      decision: 'include',
      reason: '  the exclusion criterion names a different population  ',
      actor: '  user  '
    })

    expect(m.overrideUpsert).toHaveBeenCalledTimes(1)
    const call = m.overrideUpsert.mock.calls[0][0] as {
      where: Record<string, unknown>
      create: Record<string, unknown>
      update: Record<string, unknown>
    }
    expect(call.where).toEqual({
      collectionId_referenceId: { collectionId: 'col-1', referenceId: 'ref-1' }
    })
    expect(call.create).toMatchObject({
      decision: 'include',
      reason: 'the exclusion criterion names a different population',
      actor: 'user'
    })
    expect(override).toMatchObject({ decision: 'include', actor: 'user' })
    // The AI verdict is not rewritten by a person's decision — that is the whole point of the split.
    expect(m.assessmentUpsert).not.toHaveBeenCalled()
  })

  it('requires a reason and an actor', async () => {
    const { client, m } = createMockClient()
    const repository = repositoryFor(client)

    await expect(
      repository.setOverride({
        collectionId: 'col-1',
        referenceId: 'ref-1',
        decision: 'exclude',
        reason: '   ',
        actor: 'user'
      })
    ).rejects.toThrow(/must carry a reason/)
    await expect(
      repository.setOverride({
        collectionId: 'col-1',
        referenceId: 'ref-1',
        decision: 'exclude',
        reason: 'not relevant',
        actor: ''
      })
    ).rejects.toThrow(/must name the actor/)
    expect(m.overrideUpsert).not.toHaveBeenCalled()
  })

  it('clears an override without touching the AI verdict', async () => {
    const { client, m } = createMockClient()
    m.overrideDeleteMany.mockResolvedValue({ count: 1 })

    await repositoryFor(client).clearOverride('col-1', 'ref-1')

    expect(m.overrideDeleteMany).toHaveBeenCalledWith({
      where: { collectionId: 'col-1', referenceId: 'ref-1' }
    })
    expect(m.assessmentUpsert).not.toHaveBeenCalled()
    expect(m.overrideUpsert).not.toHaveBeenCalled()
  })

  it('reads the AI verdict beside the override, with the override deciding', async () => {
    const { client, m } = createMockClient()
    m.assessmentFindMany.mockResolvedValue([assessmentRow()])
    m.overrideFindMany.mockResolvedValue([overrideRow({ decision: 'include' })])

    const [view] = await repositoryFor(client).listDecisionViews('col-1')

    expect(view).toMatchObject({
      referenceId: 'ref-1',
      verdict: 'included',
      effective: 'included',
      effectiveSource: 'override'
    })
    expect(view?.override).toMatchObject({ decision: 'include', actor: 'user' })
  })

  it('reports the AI verdict as effective where no override exists', async () => {
    const { client, m } = createMockClient()
    m.assessmentFindMany.mockResolvedValue([assessmentRow({ verdict: 'excluded' })])

    const [view] = await repositoryFor(client).listDecisionViews('col-1')
    expect(view).toMatchObject({
      verdict: 'excluded',
      override: null,
      effective: 'excluded',
      effectiveSource: 'ai'
    })
  })

  it('includes a reference a person decided before the model ever ran', async () => {
    const { client, m } = createMockClient()
    m.overrideFindMany.mockResolvedValue([
      overrideRow({ referenceId: 'ref-9', decision: 'include' })
    ])

    const views = await repositoryFor(client).listDecisionViews('col-1')
    expect(views).toEqual([
      {
        referenceId: 'ref-9',
        verdict: 'not-evaluated',
        override: expect.objectContaining({ decision: 'include' }),
        effective: 'included',
        effectiveSource: 'override'
      }
    ])
  })

  it('constrains both layers to the requested references', async () => {
    const { client, m } = createMockClient()

    await repositoryFor(client).listDecisionViews('col-1', ['ref-2', 'ref-1', 'ref-2'])

    expect(m.assessmentFindMany).toHaveBeenCalledWith({
      where: { collectionId: 'col-1', referenceId: { in: ['ref-2', 'ref-1'] } }
    })
    expect(m.overrideFindMany).toHaveBeenCalledWith({
      where: { collectionId: 'col-1', referenceId: { in: ['ref-2', 'ref-1'] } }
    })
  })
})

describe('ScreeningRepository run lifecycle', () => {
  it('refuses a run bound to a rule revision that does not exist', async () => {
    const { client, m } = createMockClient()

    await expect(
      repositoryFor(client).startRun({
        collectionId: 'col-1',
        ruleRevision: 7,
        items: [{ referenceId: 'ref-1' }]
      })
    ).rejects.toThrow(/revision 7 does not exist for collection col-1/)

    expect(m.runCreate).not.toHaveBeenCalled()
    expect(m.itemCreateMany).not.toHaveBeenCalled()
  })

  it('opens a running run bound to the revision, one pending item per candidate', async () => {
    const { client, m } = createMockClient()
    m.ruleFindUnique.mockResolvedValue(ruleRow({ revision: 3 }))
    m.runCreate.mockResolvedValue(runRow())
    m.itemCreateMany.mockResolvedValue({ count: 2 })

    const run = await repositoryFor(client).startRun({
      collectionId: 'col-1',
      ruleRevision: 3,
      items: [{ referenceId: 'ref-1' }, { referenceId: 'ref-2', inputDigest: 'digest-b' }]
    })

    expect(run).toMatchObject({
      id: 'run-1',
      collectionId: 'col-1',
      ruleRevision: 3,
      status: 'running'
    })
    expect(run.finishedAt).toBeUndefined()
    expect(m.runCreate).toHaveBeenCalledWith({
      data: { collectionId: 'col-1', ruleRevision: 3, status: 'running' }
    })
    expect(m.itemCreateMany).toHaveBeenCalledWith({
      data: [
        { runId: 'run-1', referenceId: 'ref-1', state: 'pending' },
        { runId: 'run-1', referenceId: 'ref-2', state: 'pending', inputDigest: 'digest-b' }
      ]
    })
  })

  it('deduplicates repeated candidates in one pass', async () => {
    const { client, m } = createMockClient()
    m.ruleFindUnique.mockResolvedValue(ruleRow({ revision: 3 }))
    m.runCreate.mockResolvedValue(runRow())

    await repositoryFor(client).startRun({
      collectionId: 'col-1',
      ruleRevision: 3,
      items: [{ referenceId: 'ref-1' }, { referenceId: 'ref-1', inputDigest: 'digest-b' }]
    })

    expect(m.itemCreateMany).toHaveBeenCalledWith({
      data: [{ runId: 'run-1', referenceId: 'ref-1', state: 'pending' }]
    })
  })

  it('opens a run with no candidates without writing item rows', async () => {
    const { client, m } = createMockClient()
    m.ruleFindUnique.mockResolvedValue(ruleRow({ revision: 3 }))
    m.runCreate.mockResolvedValue(runRow())

    await repositoryFor(client).startRun({ collectionId: 'col-1', ruleRevision: 3, items: [] })
    expect(m.itemCreateMany).not.toHaveBeenCalled()
  })

  it('refuses an item for an unknown run and for a run that already finished', async () => {
    const { client, m } = createMockClient()
    const repository = repositoryFor(client)

    await expect(
      repository.recordRunItem({ runId: 'run-404', referenceId: 'ref-1', state: 'pending' })
    ).rejects.toThrow(/Screening run run-404 not found/)

    m.runFindUnique.mockResolvedValue(runRow({ status: 'completed', finishedAt: createdAt }))
    await expect(
      repository.recordRunItem({ runId: 'run-1', referenceId: 'ref-1', state: 'assessed' })
    ).rejects.toThrow(/is completed; items cannot be recorded after a run finished/)

    expect(m.itemUpsert).not.toHaveBeenCalled()
  })

  it('upserts an item on (runId, referenceId) and clears the previous attempt failure', async () => {
    const { client, m } = createMockClient()
    m.runFindUnique.mockResolvedValue(runRow())
    m.itemUpsert.mockImplementation((args: { update: Record<string, unknown> }) =>
      Promise.resolve(runItemRow({ state: 'assessed', ...(args.update as object) }))
    )

    const item = await repositoryFor(client).recordRunItem({
      runId: 'run-1',
      referenceId: 'ref-1',
      state: 'assessed',
      inputDigest: 'digest-a'
    })

    const call = m.itemUpsert.mock.calls[0][0] as {
      where: Record<string, unknown>
      create: Record<string, unknown>
      update: Record<string, unknown>
    }
    expect(call.where).toEqual({ runId_referenceId: { runId: 'run-1', referenceId: 'ref-1' } })
    expect(call.update).toEqual({
      state: 'assessed',
      failureKind: null,
      deferredReason: null,
      inputDigest: 'digest-a'
    })
    expect(item).toMatchObject({ state: 'assessed', inputDigest: 'digest-a' })
    expect(item.failureKind).toBeUndefined()
  })

  it('keeps the digest recorded earlier when a later write omits it', async () => {
    const { client, m } = createMockClient()
    m.runFindUnique.mockResolvedValue(runRow())
    m.itemUpsert.mockImplementation((args: { update: Record<string, unknown> }) =>
      Promise.resolve(runItemRow({ inputDigest: 'digest-a', ...(args.update as object) }))
    )

    const item = await repositoryFor(client).recordRunItem({
      runId: 'run-1',
      referenceId: 'ref-1',
      state: 'deferred',
      deferredReason: 'input-too-long'
    })

    const call = m.itemUpsert.mock.calls[0][0] as { update: Record<string, unknown> }
    expect(call.update).not.toHaveProperty('inputDigest')
    expect(call.update).toMatchObject({ deferredReason: 'input-too-long' })
    expect(item).toMatchObject({
      state: 'deferred',
      deferredReason: 'input-too-long',
      inputDigest: 'digest-a'
    })
  })

  it('writes the finish time once and reports what is still pending', async () => {
    const { client, m } = createMockClient()
    m.runFindUnique.mockResolvedValue(runRow())
    m.runUpdate.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve(runRow({ ...(args.data as object) }))
    )
    m.itemCount.mockResolvedValue(3)

    const finished = await repositoryFor(client).finishRun('run-1', 'failed', 1_710_000_009_000)

    expect(m.runUpdate).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { status: 'failed', finishedAt: new Date(1_710_000_009_000) }
    })
    expect(finished.run).toMatchObject({ status: 'failed', finishedAt: 1_710_000_009_000 })
    // A pass that left work behind says so instead of reporting itself done.
    expect(finished.unprocessedCount).toBe(3)
    expect(m.itemCount).toHaveBeenCalledWith({ where: { runId: 'run-1', state: 'pending' } })
  })

  it('refuses to close a run twice, so a finished timeline cannot move', async () => {
    const { client, m } = createMockClient()
    m.runFindUnique.mockResolvedValue(runRow({ status: 'completed', finishedAt: createdAt }))

    await expect(repositoryFor(client).finishRun('run-1', 'failed')).rejects.toThrow(
      /is already completed; its finish time is written once/
    )
    expect(m.runUpdate).not.toHaveBeenCalled()
    expect(m.itemCount).not.toHaveBeenCalled()
  })

  it('lists items and runs in the recorded order', async () => {
    const { client, m } = createMockClient()
    m.itemFindMany.mockResolvedValue([
      runItemRow({ referenceId: 'ref-1' }),
      runItemRow({
        referenceId: 'ref-2',
        state: 'failed',
        failureKind: 'transport-error',
        inputDigest: 'digest-b'
      })
    ])
    m.runFindMany.mockResolvedValue([runRow()])
    m.runFindUnique.mockResolvedValue(runRow())
    const repository = repositoryFor(client)

    await expect(repository.listRunItems('run-1')).resolves.toEqual([
      { runId: 'run-1', referenceId: 'ref-1', state: 'pending' },
      {
        runId: 'run-1',
        referenceId: 'ref-2',
        state: 'failed',
        failureKind: 'transport-error',
        inputDigest: 'digest-b'
      }
    ])
    expect(m.itemFindMany).toHaveBeenCalledWith({
      where: { runId: 'run-1' },
      orderBy: { referenceId: 'asc' }
    })
    await expect(repository.listRuns('col-1')).resolves.toHaveLength(1)
    expect(m.runFindMany).toHaveBeenCalledWith({
      where: { collectionId: 'col-1' },
      orderBy: { startedAt: 'desc' }
    })
    await expect(repository.getRun('run-1')).resolves.toMatchObject({ id: 'run-1' })
  })
})
