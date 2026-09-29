import type { Reference } from '../../shared/references'
import type {
  ScreeningEvidenceCoverage,
  ScreeningFailureKind,
  ScreeningNamedReason,
  ScreeningRuleRevision,
  ScreeningRunItem,
  ScreeningRunStatus,
  ScreeningVerdict
} from '../../shared/references-screening'
import { SCREENING_FAILURE_KINDS } from '../../shared/references-screening'
import { computeScreeningInputDigest } from './screening-digest'
import { assembleScreeningEvidence } from './screening-evidence'
import { SCREENING_DEFAULT_INPUT_CHAR_BUDGET, applyEvidenceCoverage } from './screening-freshness'
import {
  SCREENING_PROMPT_POLICY_KEY,
  assembleScreeningPrompt,
  parseScreeningResponse
} from './screening-prompt'
import type { ScreeningRepository } from './screening-repository'

// The screening evaluation engine (S2.5 + S2.6): it walks a collection's candidates, assembles their
// evidence, asks a model, parses the answer through the guardrails, and writes the ledger — with at
// most four records in flight, a failed record not taking the pass down with it, and a resume that
// re-evaluates exactly the records whose grounds moved.
//
// The model seam is the same shape the artifact code-reconstruction service uses
// (src/main/artifacts/code-reconstruction.ts): a small dependency-injected runner that takes a prompt
// and hands back text, so every test here drives a stub and nothing in this module opens a socket.
// Only the repository methods this engine actually calls are required, which is what lets the tests
// substitute an in-memory ledger for Prisma.

export const SCREENING_DEFAULT_CONCURRENCY = 4

export type ScreeningModelRunner = {
  /** Model identity recorded on every assessment — auditability, not part of the freshness key. */
  readonly model: string
  run(prompt: string): Promise<{ text: string }>
}

// Thrown by a runner when the model call failed in transport (timeout, socket, 5xx) rather than
// producing an unusable answer. Kept distinct so a resume can retry a transport failure immediately
// while leaving a malformed response for inspection.
export class ScreeningTransportError extends Error {
  readonly failureKind = 'transport-error' as const
  constructor(message: string) {
    super(message)
    this.name = 'ScreeningTransportError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const failureKindFor = (error: unknown): ScreeningFailureKind => {
  if (error instanceof ScreeningTransportError) return 'transport-error'
  if (isRecord(error) && typeof error.failureKind === 'string') {
    const kind = error.failureKind
    if ((SCREENING_FAILURE_KINDS as readonly string[]).includes(kind)) {
      return kind as ScreeningFailureKind
    }
  }
  return 'model-error'
}

// A semaphore with an explicit waiter queue: the first `maxConcurrent` tasks enter immediately, and
// the rest park on the queue until one slot is released. Bounded in-flight work is the whole point —
// an unbounded pass would fire one model request per candidate at once.
export type ScreeningLimiter = <T>(task: () => Promise<T>) => Promise<T>

export const createScreeningLimiter = (maxConcurrent: number): ScreeningLimiter => {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(
      `Screening concurrency must be a positive integer, got ${String(maxConcurrent)}.`
    )
  }
  let active = 0
  const waiters: Array<() => void> = []
  const release = (): void => {
    active -= 1
    const next = waiters.shift()
    if (next) next()
  }
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= maxConcurrent) await new Promise<void>((resolve) => waiters.push(resolve))
    active += 1
    try {
      return await task()
    } finally {
      release()
    }
  }
}

export type ScreeningEngineRepository = Pick<
  ScreeningRepository,
  'getRun' | 'startRun' | 'listRunItems' | 'recordRunItem' | 'upsertAssessment' | 'finishRun'
>

export type ScreeningEngineOptions = {
  repository: ScreeningEngineRepository
  runner: ScreeningModelRunner
  /** Loads one library record. `null` when it is gone — which reads as unavailable, not as an error. */
  loadReference: (referenceId: string) => Promise<Reference | null>
  /** Reads the record's PDF body text (attachment → managed file → extractor). `null` = none. */
  readFullText: (reference: Reference) => Promise<string | null>
  now?: () => number
  inputCharBudget?: number
  concurrency?: number
  /** Override for tests / a future guardrail revision; defaults to the current policy identity. */
  policyKey?: string
}

export type ScreenReferencesInput = {
  collectionId: string
  rule: Pick<ScreeningRuleRevision, 'revision' | 'inclusion' | 'exclusion' | 'contentHash'>
  referenceIds: readonly string[]
  /** Resume an existing pass instead of opening a new one. */
  runId?: string
  /**
   * Close the run when this call returns. `false` leaves it 'running' so a later call resumes it —
   * which is how an interrupted pass stays visible instead of pretending to be finished.
   */
  finalize?: boolean
}

// Why this item was (or was not) looked at this time. 'unchanged' is the resume's payoff: the same
// input, already decided, so no model call is spent on it.
export type ScreeningResumeDisposition = 'first-pass' | 'input-changed' | 'retry' | 'unchanged'

export type ScreeningItemOutcome = {
  referenceId: string
  status: 'assessed' | 'skipped' | 'deferred' | 'failed'
  resume: ScreeningResumeDisposition
  coverage: ScreeningEvidenceCoverage
  verdict?: ScreeningVerdict
  /** Named reasons attached to this outcome, e.g. 'input-changed' or a coverage degradation. */
  reasons: ScreeningNamedReason[]
  failureKind?: ScreeningFailureKind
  message?: string
}

export type ScreeningRunReport = {
  runId: string
  policyKey: string
  /** The run's status when this call returned; 'running' when the caller asked not to finalize. */
  status: ScreeningRunStatus
  outcomes: ScreeningItemOutcome[]
  counts: { assessed: number; skipped: number; deferred: number; failed: number }
  /** Items still pending after finalizing — stated, never inferred from a missing row. */
  unprocessedCount: number
}

export class ScreeningEngine {
  private readonly repository: ScreeningEngineRepository
  private readonly runner: ScreeningModelRunner
  private readonly now: () => number
  private readonly inputCharBudget: number
  private readonly concurrency: number
  readonly policyKey: string

  constructor(private readonly options: ScreeningEngineOptions) {
    this.repository = options.repository
    this.runner = options.runner
    this.now = options.now ?? (() => Date.now())
    this.inputCharBudget = options.inputCharBudget ?? SCREENING_DEFAULT_INPUT_CHAR_BUDGET
    this.concurrency = options.concurrency ?? SCREENING_DEFAULT_CONCURRENCY
    this.policyKey = options.policyKey ?? SCREENING_PROMPT_POLICY_KEY
  }

  async screen(input: ScreenReferencesInput): Promise<ScreeningRunReport> {
    const { repository } = this
    const referenceIds = [...new Set(input.referenceIds)]
    const finalize = input.finalize ?? true

    let runId = input.runId
    let priorItems = new Map<string, ScreeningRunItem>()
    if (runId === undefined) {
      const run = await repository.startRun({
        collectionId: input.collectionId,
        ruleRevision: input.rule.revision,
        items: referenceIds.map((referenceId) => ({ referenceId }))
      })
      runId = run.id
    } else {
      const run = await repository.getRun(runId)
      if (!run) throw new Error(`Screening run ${runId} not found.`)
      if (run.status !== 'running') {
        throw new Error(
          `Screening run ${runId} is ${run.status}; resume a run that is still running, or start a new pass.`
        )
      }
      priorItems = new Map(
        (await repository.listRunItems(runId)).map((item) => [item.referenceId, item])
      )
    }

    const limiter = createScreeningLimiter(this.concurrency)
    const outcomes = await Promise.all(
      referenceIds.map((referenceId) =>
        limiter(() =>
          this.evaluateOne({
            collectionId: input.collectionId,
            rule: input.rule,
            runId,
            referenceId,
            prior: priorItems.get(referenceId)
          })
        )
      )
    )

    const counts = { assessed: 0, skipped: 0, deferred: 0, failed: 0 }
    for (const outcome of outcomes) counts[outcome.status] += 1

    if (!finalize) {
      return {
        runId,
        policyKey: this.policyKey,
        status: 'running',
        outcomes,
        counts,
        unprocessedCount: 0
      }
    }
    // A pass that left a record failed is a failed pass: status has to reflect the ledger, not the
    // fact that the loop ran to the end.
    const status: ScreeningRunStatus = counts.failed > 0 ? 'failed' : 'completed'
    const finished = await repository.finishRun(runId, status)
    return {
      runId,
      policyKey: this.policyKey,
      status: finished.run.status,
      outcomes,
      counts,
      unprocessedCount: finished.unprocessedCount
    }
  }

  private async evaluateOne(args: {
    collectionId: string
    rule: ScreenReferencesInput['rule']
    runId: string
    referenceId: string
    prior: ScreeningRunItem | undefined
  }): Promise<ScreeningItemOutcome> {
    const { repository } = this
    const { collectionId, rule, runId, referenceId, prior } = args
    try {
      const reference = await this.options.loadReference(referenceId)
      const fullText = reference ? await this.options.readFullText(reference) : null
      const bundle = assembleScreeningEvidence({ reference, fullText })
      const digest = computeScreeningInputDigest({
        ruleContentHash: rule.contentHash,
        policyKey: this.policyKey,
        coverage: bundle.coverage,
        sections: bundle.sections
      })

      // Resume check (S2.6), per record and before any model call: an input that has not moved is not
      // looked at again. A 'failed' item is the exception — a failure is not a property of the input,
      // so it is retried even when the digest matches.
      let disposition: ScreeningResumeDisposition = 'first-pass'
      if (prior && prior.inputDigest === digest) {
        if (prior.state === 'assessed' || prior.state === 'deferred') {
          return {
            referenceId,
            status: 'skipped',
            resume: 'unchanged',
            coverage: bundle.coverage,
            reasons: []
          }
        }
        disposition = 'retry'
      } else if (prior && prior.inputDigest !== undefined) {
        disposition = 'input-changed'
      }
      const carried: ScreeningNamedReason[] =
        disposition === 'input-changed' ? ['input-changed'] : []

      // No evidence at all is not a question a model can answer: the record stays explicitly
      // unprocessed with a named reason, and no exclusion is ever invented from silence.
      if (bundle.coverage === 'unavailable') {
        await repository.recordRunItem({
          runId,
          referenceId,
          state: 'deferred',
          deferredReason: 'missing-evidence',
          inputDigest: digest
        })
        return {
          referenceId,
          status: 'deferred',
          resume: disposition,
          coverage: bundle.coverage,
          reasons: [...carried, 'missing-evidence']
        }
      }

      // Evidence beyond the input budget is deferred with its own reason rather than truncated: a
      // silently clipped read would drop the exclusion criteria and answer anyway.
      if (bundle.inputChars > this.inputCharBudget) {
        await repository.recordRunItem({
          runId,
          referenceId,
          state: 'deferred',
          deferredReason: 'input-too-long',
          inputDigest: digest
        })
        return {
          referenceId,
          status: 'deferred',
          resume: disposition,
          coverage: bundle.coverage,
          reasons: [...carried, 'input-too-long']
        }
      }

      const prompt = assembleScreeningPrompt({
        inclusion: rule.inclusion,
        exclusion: rule.exclusion,
        coverage: bundle.coverage,
        sections: bundle.sections
      })

      let raw: { text: string }
      try {
        raw = await this.runner.run(prompt.prompt)
      } catch (error) {
        const failureKind = failureKindFor(error)
        await repository.recordRunItem({
          runId,
          referenceId,
          state: 'failed',
          failureKind,
          inputDigest: digest
        })
        return {
          referenceId,
          status: 'failed',
          resume: disposition,
          coverage: bundle.coverage,
          reasons: carried,
          failureKind,
          message: error instanceof Error ? error.message : String(error)
        }
      }

      const parsed = parseScreeningResponse(raw.text, {
        coverage: bundle.coverage,
        inclusion: rule.inclusion,
        exclusion: rule.exclusion
      })
      if (!parsed.ok) {
        await repository.recordRunItem({
          runId,
          referenceId,
          state: 'failed',
          failureKind: parsed.failureKind,
          inputDigest: digest
        })
        return {
          referenceId,
          status: 'failed',
          resume: disposition,
          coverage: bundle.coverage,
          reasons: carried,
          failureKind: parsed.failureKind,
          message: parsed.reason
        }
      }

      // The coverage guard runs on every parsed verdict — the one place the plan says it cannot be
      // bypassed. An abstract-only 'excluded' becomes needs-review here, not at a later read path.
      const guarded = applyEvidenceCoverage(parsed.verdict, bundle.coverage)
      await repository.upsertAssessment({
        collectionId,
        referenceId,
        ruleRevision: rule.revision,
        inputDigest: digest,
        policyKey: this.policyKey,
        model: this.runner.model,
        verdict: guarded.verdict,
        probabilities: parsed.probabilities,
        evidence: parsed.citations,
        decidedAt: this.now()
      })
      await repository.recordRunItem({
        runId,
        referenceId,
        state: 'assessed',
        inputDigest: digest
      })

      const reasons: ScreeningNamedReason[] = [...carried]
      if (guarded.degraded && guarded.reason) reasons.push(guarded.reason)
      if (parsed.downgraded && parsed.downgradeReason) reasons.push(parsed.downgradeReason)
      return {
        referenceId,
        status: 'assessed',
        resume: disposition,
        coverage: bundle.coverage,
        verdict: guarded.verdict,
        reasons
      }
    } catch (error) {
      // One record going wrong must not take the pass down with it: it is recorded as a named failure
      // and the remaining records still get their turn.
      const failureKind = failureKindFor(error)
      try {
        await repository.recordRunItem({ runId, referenceId, state: 'failed', failureKind })
      } catch {
        // The ledger write itself failed; the report below still carries the failure so callers see it.
      }
      return {
        referenceId,
        status: 'failed',
        resume: 'first-pass',
        coverage: 'unavailable',
        reasons: [],
        failureKind,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
}
