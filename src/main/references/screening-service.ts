import type { Reference } from '../../shared/references'
import type {
  AppendScreeningRuleRevisionInput,
  AppendScreeningRuleRevisionResult,
  CancelScreeningRunResult,
  ClearScreeningOverrideResult,
  ScreeningAssessment,
  ScreeningBatchOverrideRequest,
  ScreeningBatchOverrideResult,
  ScreeningCollectionSnapshot,
  ScreeningCoverageEntry,
  ScreeningDecisionView,
  ScreeningEvidenceCitation,
  ScreeningItemView,
  ScreeningNamedReason,
  ScreeningOverride,
  ScreeningRuleRevision,
  ScreeningRunItem,
  ScreeningRunView,
  StartScreeningRunInput,
  StartScreeningRunResult
} from '../../shared/references-screening'
import { SCREENING_NAMED_REASONS } from '../../shared/references-screening'
import { computeScreeningInputDigest } from './screening-digest'
import { assembleScreeningEvidence } from './screening-evidence'
import {
  SCREENING_DEFAULT_INPUT_CHAR_BUDGET,
  evaluateScreeningFreshness,
  resolveEffectiveDecision,
  summarizeScreeningCoverage
} from './screening-freshness'
import {
  createScreeningFullTextCache,
  type ScreeningFullTextReader
} from './screening-full-text-cache'
import {
  SCREENING_DEFAULT_CONCURRENCY,
  ScreeningEngine,
  type ScreeningEngineRepository,
  type ScreeningModelRunner
} from './screening-engine'
import { SCREENING_PROMPT_POLICY_KEY } from './screening-prompt'
import type { ScreeningRepository } from './screening-repository'

// The orchestration layer between the window and S1/S2 (S3): it reads a collection's screening state,
// appends rule revisions, drives a pass in bounded chunks with a real cancel, and records human
// overrides — without weakening anything below it.
//
// Three properties are deliberate:
//
//   1. the AI verdict and the human override are read APART and merged only in the projection
//      (resolveEffectiveDecision), so no read path here can present a person's decision as the model's;
//   2. a pass reports its own progress because it IS the ledger: counts come from the run's item rows,
//      and "unprocessed" is stated, never inferred from rows a caller happens to be holding;
//   3. a pass is cancellable between chunks. Nothing in flight is abandoned mid-call (a model call has
//      no honest cancellation), and the run is left RUNNING with its pending rows — exactly the state a
//      resume continues from — instead of being marked finished after doing half the work.

export class ScreeningRunnerUnavailableError extends Error {
  readonly code = 'screening-runner-unavailable'
  constructor(message = 'The screening model runner is not available yet.') {
    super(message)
    this.name = 'ScreeningRunnerUnavailableError'
  }
}

export class ScreeningRuleMissingError extends Error {
  readonly code = 'screening-rule-missing'
  constructor(collectionId: string) {
    super(
      `Collection ${collectionId} has no inclusion / exclusion criteria yet; declare a revision before screening.`
    )
    this.name = 'ScreeningRuleMissingError'
  }
}

export class ScreeningRuleInvalidError extends Error {
  readonly code = 'screening-rule-invalid'
  constructor(message: string) {
    super(message)
    this.name = 'ScreeningRuleInvalidError'
  }
}

// The repository methods this layer and the engine beneath it actually call, so a test can substitute an
// in-memory ledger without implementing Prisma.
export type ScreeningServiceRepository = Pick<
  ScreeningRepository,
  | 'listRuleRevisions'
  | 'latestRuleRevision'
  | 'appendRuleRevision'
  | 'listAssessments'
  | 'getAssessment'
  | 'setOverride'
  | 'clearOverride'
  | 'listOverrides'
  | 'getOverride'
  | 'listRuns'
  | 'listRunItems'
  | 'getRun'
  | 'startRun'
  | 'recordRunItem'
  | 'upsertAssessment'
  | 'finishRun'
>

export type ScreeningServiceDependencies = {
  repository: ScreeningServiceRepository
  references: {
    listCollectionReferences: (collectionId: string) => Promise<Reference[]>
    getReference: (referenceId: string) => Promise<Reference | null>
  }
  /** Raw reader of an attached PDF's body text. Wrapped in the shared cache below. */
  fullText: ScreeningFullTextReader
  /**
   * The production model runner. A function rather than a value because the runner is created later in
   * the composition root; until it is bound, starting a pass reports a named failure instead of
   * pretending to screen anything.
   */
  runner: () => ScreeningModelRunner
  runnerAvailable?: () => boolean
  /** Called once when a pass starts: lets the runner re-resolve the user's current Agent selection. */
  beginPass?: () => void
  now?: () => number
  inputCharBudget?: number
  concurrency?: number
  /** Items handed to the engine per call. Also the granularity at which a cancel takes effect. */
  chunkSize?: number
  fullTextCacheEntries?: number
}

type ActivePass = {
  runId: string
  ruleRevision: number
  referenceIds: string[]
  cancelRequested: boolean
}

const emptyReasonCounts = (): Record<ScreeningNamedReason, number> =>
  Object.fromEntries(SCREENING_NAMED_REASONS.map((reason) => [reason, 0])) as Record<
    ScreeningNamedReason,
    number
  >

export class ScreeningService {
  private readonly repository: ScreeningServiceRepository
  private readonly now: () => number
  private readonly inputCharBudget: number
  private readonly chunkSize: number
  private readonly fullText: ReturnType<typeof createScreeningFullTextCache>
  private readonly activePasses = new Map<string, ActivePass>()
  private readonly lastErrors = new Map<string, string>()

  constructor(private readonly dependencies: ScreeningServiceDependencies) {
    this.repository = dependencies.repository
    this.now = dependencies.now ?? (() => Date.now())
    this.inputCharBudget = dependencies.inputCharBudget ?? SCREENING_DEFAULT_INPUT_CHAR_BUDGET
    this.chunkSize = dependencies.chunkSize ?? 8
    if (!Number.isInteger(this.chunkSize) || this.chunkSize < 1) {
      throw new Error(
        `The screening chunk size must be a positive integer, got ${String(this.chunkSize)}.`
      )
    }
    this.fullText = createScreeningFullTextCache(
      dependencies.fullText,
      dependencies.fullTextCacheEntries ?? 128
    )
  }

  // --- reads -------------------------------------------------------------------------------------

  async snapshot(collectionId: string): Promise<ScreeningCollectionSnapshot> {
    const [references, rule, assessments, overrides, runs] = await Promise.all([
      this.dependencies.references.listCollectionReferences(collectionId),
      this.repository.latestRuleRevision(collectionId),
      this.repository.listAssessments(collectionId),
      this.repository.listOverrides(collectionId),
      this.repository.listRuns(collectionId)
    ])
    const items = await this.buildItems({ references, assessments, overrides, rule })
    const latestRun = runs[0] ?? null
    const lastRun = latestRun
      ? await this.buildRunView(latestRun.id, latestRun, collectionId)
      : null

    const entries: ScreeningCoverageEntry[] = []
    const reasonCounts = emptyReasonCounts()
    let aiDecidedCount = 0
    let overrideCount = 0
    for (const item of items) {
      entries.push({
        verdict: item.decision.verdict,
        coverage: item.coverage,
        fresh: !item.freshness.stale
      })
      for (const reason of item.freshness.reasons) reasonCounts[reason] += 1
      if (item.decision.verdict !== 'not-evaluated') aiDecidedCount += 1
      if (item.decision.override) overrideCount += 1
    }

    // The collection IS the searched corpus: candidates are its members, and a screen cannot have
    // considered more records than the corpus holds — the nesting S1 asserts rather than trusts.
    const summary = summarizeScreeningCoverage({
      searchedCount: references.length,
      candidateCount: references.length,
      entries
    })

    return {
      collectionId,
      rule,
      items,
      summary,
      reasonCounts,
      aiDecidedCount,
      overrideCount,
      lastRun,
      runnerAvailable: this.runnerAvailable(),
      lastError: this.lastErrors.get(collectionId) ?? null
    }
  }

  listRuleRevisions(collectionId: string): Promise<ScreeningRuleRevision[]> {
    return this.repository.listRuleRevisions(collectionId)
  }

  // --- rule revisions: append only, never edit ----------------------------------------------------

  // A rule change is a new revision. Append-only is enforced by the repository (a second write of the
  // same (collectionId, revision) throws) and a save whose canonical content is unchanged returns the
  // existing revision instead of stacking one — which is what keeps "I pressed save again" from
  // staling every decision in the collection.
  async appendRuleRevision(
    input: AppendScreeningRuleRevisionInput
  ): Promise<AppendScreeningRuleRevisionResult> {
    const criteria = [...input.inclusion, ...input.exclusion].map((criterion) => ({
      id: criterion.id.trim(),
      text: criterion.text
    }))
    for (const criterion of criteria) {
      if (criterion.id.length === 0) {
        throw new ScreeningRuleInvalidError(
          'Every criterion needs an id; it is what a citation cites.'
        )
      }
      if (criterion.text.trim().length === 0) {
        throw new ScreeningRuleInvalidError(`Criterion ${criterion.id} has no text.`)
      }
    }
    const ids = new Set(criteria.map((criterion) => criterion.id))
    if (ids.size !== criteria.length) {
      throw new ScreeningRuleInvalidError('Criterion ids must be unique within a revision.')
    }

    const before = await this.repository.latestRuleRevision(input.collectionId)
    const revision = await this.repository.appendRuleRevision({
      collectionId: input.collectionId,
      inclusion: input.inclusion,
      exclusion: input.exclusion
    })
    const appended = before === null || revision.revision !== before.revision
    const assessments = appended ? await this.repository.listAssessments(input.collectionId) : []
    return {
      revision,
      appended,
      // Every stored decision was decided against an older revision, so a real append stales exactly
      // the decisions that exist. Saying how many is the difference between a notice and a surprise.
      affectedDecisions: appended
        ? assessments.filter((assessment) => assessment.ruleRevision !== revision.revision).length
        : 0
    }
  }

  // --- runs: bounded chunks, a real cancel, a resumable tail --------------------------------------

  async startRun(input: StartScreeningRunInput): Promise<StartScreeningRunResult> {
    const active = this.activePasses.get(input.collectionId)
    if (active) {
      return {
        runId: active.runId,
        ruleRevision: active.ruleRevision,
        referenceCount: active.referenceIds.length,
        started: false
      }
    }
    const runner = this.dependencies.runner()

    const references = await this.dependencies.references.listCollectionReferences(
      input.collectionId
    )
    const members = new Set(references.map((reference) => reference.id))
    const selected =
      input.referenceIds === undefined
        ? [...members]
        : [...new Set(input.referenceIds)].filter((referenceId) => members.has(referenceId))
    if (selected.length === 0) {
      throw new ScreeningRuleInvalidError(
        'There is nothing to screen: the collection has no references.'
      )
    }

    let runId: string
    let ruleRevision: number
    let pending: string[]
    if (input.resumeRunId) {
      const run = await this.repository
        .listRuns(input.collectionId)
        .then((runs) => runs.find((candidate) => candidate.id === input.resumeRunId))
      if (!run) {
        throw new ScreeningRuleInvalidError(
          `Screening run ${input.resumeRunId} does not belong to collection ${input.collectionId}.`
        )
      }
      if (run.status !== 'running') {
        throw new ScreeningRuleInvalidError(
          `Screening run ${input.resumeRunId} is ${run.status}; only a running pass can be resumed.`
        )
      }
      const items = await this.repository.listRunItems(run.id)
      // A failure is not a property of the input, so a failed item is retried; a pending one was never
      // looked at. An assessed or deferred item is left alone — that is S2.6's resume rule, restated
      // here only to decide which ids to hand the engine.
      pending = items
        .filter((item) => item.state === 'pending' || item.state === 'failed')
        .map((item) => item.referenceId)
      runId = run.id
      ruleRevision = run.ruleRevision
      if (pending.length === 0) {
        return { runId, ruleRevision, referenceCount: 0, started: false }
      }
    } else {
      const rule = await this.repository.latestRuleRevision(input.collectionId)
      if (!rule) throw new ScreeningRuleMissingError(input.collectionId)
      const run = await this.repository.startRun({
        collectionId: input.collectionId,
        ruleRevision: rule.revision,
        items: selected.map((referenceId) => ({ referenceId }))
      })
      runId = run.id
      ruleRevision = rule.revision
      pending = selected
    }

    const pass: ActivePass = {
      runId,
      ruleRevision,
      referenceIds: pending,
      cancelRequested: false
    }
    this.activePasses.set(input.collectionId, pass)
    this.lastErrors.delete(input.collectionId)
    // The model identity is resolved once per pass (see beginPass), so every record in this pass is
    // labelled with the backend that actually answered it.
    this.dependencies.beginPass?.()

    // The pass runs on its own so the caller gets a run id it can poll and cancel. A failure is
    // recorded on the pass and surfaced in the next snapshot instead of vanishing into a detached
    // promise.
    void this.drivePass({ collectionId: input.collectionId, pass, runner }).catch(
      (error: unknown) => {
        this.lastErrors.set(
          input.collectionId,
          error instanceof Error ? error.message : String(error)
        )
        this.activePasses.delete(input.collectionId)
      }
    )

    return { runId, ruleRevision, referenceCount: pending.length, started: true }
  }

  // Stops the pass after the chunk in flight. Unprocessed rows stay pending on the run, which is what
  // makes "resume" a continuation instead of a restart, and the run is NOT marked finished.
  async cancelRun(collectionId: string): Promise<CancelScreeningRunResult> {
    const pass = this.activePasses.get(collectionId)
    if (!pass) {
      return { runId: '', cancelled: false, processed: 0, remaining: 0 }
    }
    pass.cancelRequested = true
    const items = await this.repository.listRunItems(pass.runId)
    const processed = items.filter((item) => item.state !== 'pending').length
    return {
      runId: pass.runId,
      cancelled: true,
      processed,
      remaining: items.filter((item) => item.state === 'pending').length
    }
  }

  private async drivePass(args: {
    collectionId: string
    pass: ActivePass
    runner: ScreeningModelRunner
  }): Promise<void> {
    const { collectionId, pass, runner } = args
    const rule = await this.repository.latestRuleRevision(collectionId)
    if (!rule) throw new ScreeningRuleMissingError(collectionId)
    const engine = new ScreeningEngine({
      repository: this.repository as ScreeningEngineRepository,
      runner,
      loadReference: (referenceId) => this.dependencies.references.getReference(referenceId),
      readFullText: (reference) => this.fullText.read(reference),
      now: this.now,
      inputCharBudget: this.inputCharBudget,
      concurrency: this.dependencies.concurrency ?? SCREENING_DEFAULT_CONCURRENCY,
      policyKey: SCREENING_PROMPT_POLICY_KEY
    })

    try {
      for (let offset = 0; offset < pass.referenceIds.length; offset += this.chunkSize) {
        if (pass.cancelRequested) return
        const chunk = pass.referenceIds.slice(offset, offset + this.chunkSize)
        const isLast = offset + this.chunkSize >= pass.referenceIds.length
        const report = await engine.screen({
          collectionId,
          rule: {
            revision: rule.revision,
            inclusion: rule.inclusion,
            exclusion: rule.exclusion,
            contentHash: rule.contentHash
          },
          referenceIds: chunk,
          runId: pass.runId,
          // A cancelled chunk is not "finished", so only the final chunk closes the run. Cancelling
          // leaves the run running with its pending rows.
          finalize: isLast && !pass.cancelRequested
        })
        // A record that failed is reported, not swallowed: the run's own status carries it (the engine
        // finishes a pass with failures as 'failed'), and the failure is named per item in the ledger.
        for (const outcome of report.outcomes) {
          if (outcome.status === 'failed' && outcome.message) {
            this.lastErrors.set(collectionId, `${outcome.referenceId}: ${outcome.message}`)
          }
        }
      }
    } finally {
      this.activePasses.delete(collectionId)
    }
  }

  // --- the human layer ----------------------------------------------------------------------------

  async setOverride(request: {
    collectionId: string
    referenceId: string
    decision: ScreeningOverride['decision']
    reason: string
    actor: string
  }): Promise<ScreeningItemView> {
    await this.repository.setOverride({
      collectionId: request.collectionId,
      referenceId: request.referenceId,
      decision: request.decision,
      reason: request.reason,
      actor: request.actor
    })
    return this.item(request.collectionId, request.referenceId)
  }

  async setOverrides(
    request: ScreeningBatchOverrideRequest
  ): Promise<ScreeningBatchOverrideResult> {
    const referenceIds = [...new Set(request.referenceIds)]
    if (referenceIds.length === 0) {
      throw new ScreeningRuleInvalidError('A batch override needs at least one reference.')
    }
    for (const referenceId of referenceIds) {
      await this.repository.setOverride({
        collectionId: request.collectionId,
        referenceId,
        decision: request.decision,
        reason: request.reason,
        actor: request.actor
      })
    }
    const items: ScreeningItemView[] = []
    for (const referenceId of referenceIds) {
      items.push(await this.item(request.collectionId, referenceId))
    }
    return { applied: referenceIds.length, items }
  }

  // Clearing the human layer restores the AI verdict exactly, because the override never wrote to the
  // assessment: there is nothing to undo.
  async clearOverride(
    collectionId: string,
    referenceId: string
  ): Promise<ClearScreeningOverrideResult> {
    await this.repository.clearOverride(collectionId, referenceId)
    return { referenceId, item: await this.item(collectionId, referenceId) }
  }

  async clearOverrides(
    collectionId: string,
    referenceIds: readonly string[]
  ): Promise<ClearScreeningOverrideResult[]> {
    const cleared: ClearScreeningOverrideResult[] = []
    for (const referenceId of [...new Set(referenceIds)]) {
      cleared.push(await this.clearOverride(collectionId, referenceId))
    }
    return cleared
  }

  // --- projections --------------------------------------------------------------------------------

  private runnerAvailable(): boolean {
    if (this.dependencies.runnerAvailable) return this.dependencies.runnerAvailable()
    try {
      this.dependencies.runner()
      return true
    } catch {
      return false
    }
  }

  private async item(collectionId: string, referenceId: string): Promise<ScreeningItemView> {
    const [reference, assessment, override, rule] = await Promise.all([
      this.dependencies.references.getReference(referenceId),
      this.repository.getAssessment(collectionId, referenceId),
      this.repository.getOverride(collectionId, referenceId),
      this.repository.latestRuleRevision(collectionId)
    ])
    const [view] = await this.buildItems({
      references: reference ? [reference] : [],
      assessments: assessment ? [assessment] : [],
      overrides: override ? [override] : [],
      rule
    })
    if (view) return view
    // The record is gone: report the override (a decision about a deleted record is still a decision)
    // with no evidence rather than inventing a line for it.
    return {
      referenceId,
      decision: this.decisionView(referenceId, null, override),
      freshness: {
        current: false,
        stale: override !== null,
        review: override !== null,
        reasons: []
      },
      coverage: 'unavailable',
      inputChars: 0,
      inputCharBudget: this.inputCharBudget,
      ruleRevision: null,
      policyKey: null,
      model: null,
      decidedAt: null,
      probabilities: {},
      evidence: []
    }
  }

  // One line per record: assembles the evidence on hand (through the cache), digests it exactly as the
  // engine does, and asks S1 whether the stored decision still answers today's question — which is the
  // only way a named reason can be attached honestly.
  private async buildItems(args: {
    references: readonly Reference[]
    assessments: readonly ScreeningAssessment[]
    overrides: readonly ScreeningOverride[]
    rule: ScreeningRuleRevision | null
  }): Promise<ScreeningItemView[]> {
    const assessments = new Map(args.assessments.map((entry) => [entry.referenceId, entry]))
    const overrides = new Map(args.overrides.map((entry) => [entry.referenceId, entry]))
    const policyKey = SCREENING_PROMPT_POLICY_KEY
    const ruleContentHash = args.rule?.contentHash ?? ''
    const ruleRevision = args.rule?.revision ?? 0

    const views: ScreeningItemView[] = []
    for (const reference of args.references) {
      const fullText = await this.fullText.read(reference)
      const bundle = assembleScreeningEvidence({ reference, fullText })
      const inputDigest = computeScreeningInputDigest({
        ruleContentHash,
        policyKey,
        coverage: bundle.coverage,
        sections: bundle.sections
      })
      const stored = assessments.get(reference.id) ?? null
      const override = overrides.get(reference.id) ?? null
      const freshness = evaluateScreeningFreshness({
        stored: stored
          ? {
              identity: {
                ruleRevision: stored.ruleRevision,
                inputDigest: stored.inputDigest,
                policyKey: stored.policyKey
              },
              verdict: stored.verdict
            }
          : null,
        current: {
          ruleRevision,
          inputDigest,
          policyKey,
          evidenceCoverage: bundle.coverage,
          inputChars: bundle.inputChars,
          inputCharBudget: this.inputCharBudget
        }
      })
      views.push({
        referenceId: reference.id,
        decision: this.decisionView(reference.id, stored, override),
        freshness: {
          current: freshness.current,
          stale: freshness.stale,
          review: freshness.review,
          reasons: freshness.reasons
        },
        coverage: bundle.coverage,
        inputChars: bundle.inputChars,
        inputCharBudget: this.inputCharBudget,
        ruleRevision: stored?.ruleRevision ?? null,
        policyKey: stored?.policyKey ?? null,
        model: stored?.model ?? null,
        decidedAt: stored?.decidedAt ?? null,
        probabilities: stored?.probabilities ?? {},
        evidence: (stored?.evidence ?? []) as ScreeningEvidenceCitation[]
      })
    }
    return views.sort((left, right) =>
      left.referenceId < right.referenceId ? -1 : left.referenceId > right.referenceId ? 1 : 0
    )
  }

  private decisionView(
    referenceId: string,
    assessment: ScreeningAssessment | null,
    override: ScreeningOverride | null
  ): ScreeningDecisionView {
    const verdict = assessment?.verdict ?? 'not-evaluated'
    const { effective, source } = resolveEffectiveDecision(verdict, override)
    return { referenceId, verdict, override, effective, effectiveSource: source }
  }

  private async buildRunView(
    runId: string,
    run: ScreeningRunView['run'],
    collectionId: string
  ): Promise<ScreeningRunView> {
    const items = await this.repository.listRunItems(runId)
    const count = (state: ScreeningRunItem['state']): number =>
      items.filter((item) => item.state === state).length
    return {
      run,
      ruleRevision: run.ruleRevision,
      referenceCount: items.length,
      assessed: count('assessed'),
      deferred: count('deferred'),
      failed: count('failed'),
      pending: count('pending'),
      running: this.activePasses.get(collectionId)?.runId === runId
    }
  }
}
