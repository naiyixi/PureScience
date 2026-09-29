import type { PrismaClient } from '@prisma/client'

import type {
  ScreeningAssessment,
  ScreeningCriterion,
  ScreeningDecisionView,
  ScreeningEvidenceCitation,
  ScreeningFailureKind,
  ScreeningNamedReason,
  ScreeningOverride,
  ScreeningOverrideDecision,
  ScreeningProbabilities,
  ScreeningRuleRevision,
  ScreeningRun,
  ScreeningRunItem,
  ScreeningRunItemState,
  ScreeningRunStatus,
  ScreeningVerdict
} from '../../shared/references-screening'
import {
  SCREENING_FAILURE_KINDS,
  SCREENING_NAMED_REASONS,
  SCREENING_RUN_ITEM_STATES,
  SCREENING_RUN_STATUSES,
  SCREENING_VERDICTS
} from '../../shared/references-screening'
import { resolveEffectiveDecision } from './screening-freshness'
import {
  parseScreeningCriteria,
  nextRuleRevision,
  screeningRuleContentHash,
  serializeScreeningCriteria
} from './screening-rules'

// Storage for literature screening (v1.77): the versioned rule set a collection is screened against, the
// AI verdict layer, the human override layer, and the run/item ledger that makes a pass resumable. Three
// invariants are enforced here rather than left to callers:
//
//   1. a rule revision is immutable — writing (collectionId, revision) twice is a bug and throws, and the
//      composite primary key refuses it even if two callers race past the check;
//   2. an override never writes to the assessment layer — the AI verdict stays what the model said, so
//      clearing an override restores the original decision exactly;
//   3. a run's item rows are written only while the run is running, and a run's finish time is written
//      once — an interrupted pass cannot look finished, and a finished one cannot be reopened silently.
//
// Only the five delegates this repository needs are typed, so it is unit-testable with a lightweight
// mock instead of a real (engine-backed) PrismaClient — the same seam the reference repository uses.
export type ScreeningClient = Pick<
  PrismaClient,
  | 'screeningRuleRevision'
  | 'screeningAssessment'
  | 'screeningOverride'
  | 'screeningRun'
  | 'screeningRunItem'
>
type ScreeningClientProvider = () => Promise<ScreeningClient>

// Row shapes as SQLite hands them back, declared explicitly so the mappers can be exercised with plain
// fixtures instead of the engine's inference.
export type StoredScreeningRuleRevisionRow = {
  collectionId: string
  revision: number
  inclusionJson: string
  exclusionJson: string
  contentHash: string
  createdAt: Date
}
export type StoredScreeningAssessmentRow = {
  collectionId: string
  referenceId: string
  ruleRevision: number
  inputDigest: string
  policyKey: string
  model: string
  verdict: string
  probabilitiesJson: string
  evidenceJson: string
  decidedAt: Date
}
export type StoredScreeningOverrideRow = {
  collectionId: string
  referenceId: string
  decision: string
  reason: string
  actor: string
  createdAt: Date
}
export type StoredScreeningRunRow = {
  id: string
  collectionId: string
  ruleRevision: number
  startedAt: Date
  finishedAt: Date | null
  status: string
}
export type StoredScreeningRunItemRow = {
  runId: string
  referenceId: string
  state: string
  failureKind: string | null
  deferredReason: string | null
  inputDigest: string | null
}

const oneOf = <T extends string>(allowed: readonly T[], value: string, fallback: T): T =>
  (allowed as readonly string[]).includes(value) ? (value as T) : fallback

// An unrecognized stored verdict reads as 'not-evaluated' — visibly unprocessed — instead of being
// invented into a filter's list, which is the one thing a triage surface must never do.
const asVerdict = (value: string): ScreeningVerdict =>
  oneOf(SCREENING_VERDICTS, value, 'not-evaluated')

const parseJsonObject = (value: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const asProbabilities = (value: string): ScreeningProbabilities => {
  const parsed = parseJsonObject(value)
  const numberOrUndefined = (key: string): number | undefined =>
    typeof parsed[key] === 'number' ? (parsed[key] as number) : undefined
  return {
    include: numberOrUndefined('include'),
    exclude: numberOrUndefined('exclude'),
    uncertain: numberOrUndefined('uncertain')
  }
}

const asEvidence = (value: string): ScreeningEvidenceCitation[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((entry): ScreeningEvidenceCitation[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const citation = entry as Record<string, unknown>
    if (typeof citation.criterionId !== 'string' || typeof citation.quote !== 'string') return []
    return [
      {
        criterionId: citation.criterionId,
        // A citation whose coverage is unreadable is read as the weakest tier: claiming more evidence
        // than the row proves is the error that matters here.
        coverage: oneOf(
          ['full-text', 'abstract-only', 'metadata-only', 'unavailable'],
          String(citation.coverage ?? ''),
          'unavailable'
        ),
        quote: citation.quote,
        ...(typeof citation.locator === 'string' ? { locator: citation.locator } : {})
      }
    ]
  })
}

export const mapScreeningRuleRevision = (
  row: StoredScreeningRuleRevisionRow
): ScreeningRuleRevision => ({
  collectionId: row.collectionId,
  revision: row.revision,
  inclusion: parseScreeningCriteria(row.inclusionJson),
  exclusion: parseScreeningCriteria(row.exclusionJson),
  contentHash: row.contentHash,
  createdAt: row.createdAt.getTime()
})

export const mapScreeningAssessment = (row: StoredScreeningAssessmentRow): ScreeningAssessment => ({
  collectionId: row.collectionId,
  referenceId: row.referenceId,
  ruleRevision: row.ruleRevision,
  inputDigest: row.inputDigest,
  policyKey: row.policyKey,
  model: row.model,
  verdict: asVerdict(row.verdict),
  probabilities: asProbabilities(row.probabilitiesJson),
  evidence: asEvidence(row.evidenceJson),
  decidedAt: row.decidedAt.getTime()
})

export const mapScreeningOverride = (row: StoredScreeningOverrideRow): ScreeningOverride => ({
  collectionId: row.collectionId,
  referenceId: row.referenceId,
  decision: row.decision === 'include' ? 'include' : 'exclude',
  reason: row.reason,
  actor: row.actor,
  createdAt: row.createdAt.getTime()
})

export const mapScreeningRun = (row: StoredScreeningRunRow): ScreeningRun => ({
  id: row.id,
  collectionId: row.collectionId,
  ruleRevision: row.ruleRevision,
  startedAt: row.startedAt.getTime(),
  finishedAt: row.finishedAt?.getTime(),
  status: oneOf(SCREENING_RUN_STATUSES, row.status, 'running')
})

export const mapScreeningRunItem = (row: StoredScreeningRunItemRow): ScreeningRunItem => ({
  runId: row.runId,
  referenceId: row.referenceId,
  state: oneOf(SCREENING_RUN_ITEM_STATES, row.state, 'pending'),
  failureKind:
    row.failureKind === null
      ? undefined
      : oneOf<ScreeningFailureKind>(SCREENING_FAILURE_KINDS, row.failureKind, 'model-error'),
  deferredReason:
    row.deferredReason === null
      ? undefined
      : oneOf<ScreeningNamedReason>(SCREENING_NAMED_REASONS, row.deferredReason, 'uncertain'),
  inputDigest: row.inputDigest ?? undefined
})

export type CreateScreeningRuleRevisionInput = {
  collectionId: string
  revision: number
  inclusion: readonly ScreeningCriterion[]
  exclusion: readonly ScreeningCriterion[]
}

export type AppendScreeningRuleRevisionInput = {
  collectionId: string
  inclusion: readonly ScreeningCriterion[]
  exclusion: readonly ScreeningCriterion[]
}

export type ScreeningAssessmentInput = {
  collectionId: string
  referenceId: string
  ruleRevision: number
  inputDigest: string
  policyKey: string
  model: string
  verdict: ScreeningVerdict
  probabilities?: ScreeningProbabilities
  evidence?: readonly ScreeningEvidenceCitation[]
  decidedAt?: number
}

export type ScreeningOverrideInput = {
  collectionId: string
  referenceId: string
  decision: ScreeningOverrideDecision
  reason: string
  actor: string
}

export type StartScreeningRunInput = {
  collectionId: string
  ruleRevision: number
  items: readonly { referenceId: string; inputDigest?: string }[]
}

export type RecordScreeningRunItemInput = {
  runId: string
  referenceId: string
  state: ScreeningRunItemState
  failureKind?: ScreeningFailureKind
  deferredReason?: ScreeningNamedReason
  inputDigest?: string
}

export class ScreeningRepository {
  constructor(private readonly getClient: ScreeningClientProvider) {}

  // --- rule revisions: immutable by construction -------------------------------------------------

  // Writes one revision at an explicit number. A second write of the same (collectionId, revision) is
  // rejected: revisions are the anchor every verdict is explained against, so an edit in place would
  // silently re-point history. Returns the existing row's absence of ambiguity rather than an update.
  async createRuleRevision(
    input: CreateScreeningRuleRevisionInput
  ): Promise<ScreeningRuleRevision> {
    const client = await this.getClient()
    if (!Number.isInteger(input.revision) || input.revision < 1) {
      throw new Error(
        `A screening rule revision must be a positive integer, got ${String(input.revision)}.`
      )
    }
    const existing = await client.screeningRuleRevision.findUnique({
      where: {
        collectionId_revision: { collectionId: input.collectionId, revision: input.revision }
      }
    })
    if (existing) {
      throw new Error(
        `Screening rule revision ${input.revision} already exists for collection ${input.collectionId}; revisions are immutable — append a new revision instead.`
      )
    }
    const row = await client.screeningRuleRevision.create({
      data: {
        collectionId: input.collectionId,
        revision: input.revision,
        inclusionJson: serializeScreeningCriteria(input.inclusion),
        exclusionJson: serializeScreeningCriteria(input.exclusion),
        contentHash: screeningRuleContentHash(input.inclusion, input.exclusion)
      }
    })
    return mapScreeningRuleRevision(row as StoredScreeningRuleRevisionRow)
  }

  // The ordinary way a rule changes: one revision past the newest. Appending a rule set whose canonical
  // content hash matches the current revision returns that revision untouched — nothing changed, so
  // stacking a revision that differs only in its number would stale every decision in the collection for
  // no reason. The canonical form makes that comparison order-insensitive.
  async appendRuleRevision(
    input: AppendScreeningRuleRevisionInput
  ): Promise<ScreeningRuleRevision> {
    const client = await this.getClient()
    const latest = await client.screeningRuleRevision.findFirst({
      where: { collectionId: input.collectionId },
      orderBy: { revision: 'desc' }
    })
    const contentHash = screeningRuleContentHash(input.inclusion, input.exclusion)
    if (latest && latest.contentHash === contentHash) {
      return mapScreeningRuleRevision(latest as StoredScreeningRuleRevisionRow)
    }
    const row = await client.screeningRuleRevision.create({
      data: {
        collectionId: input.collectionId,
        revision: nextRuleRevision(latest?.revision ?? null),
        inclusionJson: serializeScreeningCriteria(input.inclusion),
        exclusionJson: serializeScreeningCriteria(input.exclusion),
        contentHash
      }
    })
    return mapScreeningRuleRevision(row as StoredScreeningRuleRevisionRow)
  }

  async listRuleRevisions(collectionId: string): Promise<ScreeningRuleRevision[]> {
    const client = await this.getClient()
    const rows = await client.screeningRuleRevision.findMany({
      where: { collectionId },
      orderBy: { revision: 'asc' }
    })
    return rows.map((row) => mapScreeningRuleRevision(row as StoredScreeningRuleRevisionRow))
  }

  async getRuleRevision(
    collectionId: string,
    revision: number
  ): Promise<ScreeningRuleRevision | null> {
    const client = await this.getClient()
    const row = await client.screeningRuleRevision.findUnique({
      where: { collectionId_revision: { collectionId, revision } }
    })
    return row ? mapScreeningRuleRevision(row as StoredScreeningRuleRevisionRow) : null
  }

  async latestRuleRevision(collectionId: string): Promise<ScreeningRuleRevision | null> {
    const client = await this.getClient()
    const row = await client.screeningRuleRevision.findFirst({
      where: { collectionId },
      orderBy: { revision: 'desc' }
    })
    return row ? mapScreeningRuleRevision(row as StoredScreeningRuleRevisionRow) : null
  }

  // --- the AI verdict layer: one current decision per reference -----------------------------------

  // Writes the current decision for (collectionId, referenceId). The composite key is the "one reference,
  // one current verdict" guarantee: re-evaluating replaces the row in place instead of stacking verdicts a
  // reader would have to disambiguate. The raw model output stays in probabilitiesJson, so a verdict that
  // the coverage guard degraded still shows what the model actually said.
  async upsertAssessment(input: ScreeningAssessmentInput): Promise<ScreeningAssessment> {
    const client = await this.getClient()
    const data = {
      ruleRevision: input.ruleRevision,
      inputDigest: input.inputDigest,
      policyKey: input.policyKey,
      model: input.model,
      verdict: input.verdict,
      probabilitiesJson: JSON.stringify(input.probabilities ?? {}),
      evidenceJson: JSON.stringify(input.evidence ?? []),
      decidedAt: new Date(input.decidedAt ?? Date.now())
    }
    const row = await client.screeningAssessment.upsert({
      where: {
        collectionId_referenceId: {
          collectionId: input.collectionId,
          referenceId: input.referenceId
        }
      },
      create: {
        collectionId: input.collectionId,
        referenceId: input.referenceId,
        ...data
      },
      update: data
    })
    return mapScreeningAssessment(row as StoredScreeningAssessmentRow)
  }

  async getAssessment(
    collectionId: string,
    referenceId: string
  ): Promise<ScreeningAssessment | null> {
    const client = await this.getClient()
    const row = await client.screeningAssessment.findUnique({
      where: { collectionId_referenceId: { collectionId, referenceId } }
    })
    return row ? mapScreeningAssessment(row as StoredScreeningAssessmentRow) : null
  }

  async listAssessments(collectionId: string): Promise<ScreeningAssessment[]> {
    const client = await this.getClient()
    const rows = await client.screeningAssessment.findMany({
      where: { collectionId },
      orderBy: { referenceId: 'asc' }
    })
    return rows.map((row) => mapScreeningAssessment(row as StoredScreeningAssessmentRow))
  }

  // --- the human layer: never writes to the verdict it overrides ----------------------------------

  // Records a person's decision. This method touches ScreeningOverride and nothing else: the AI verdict
  // keeps saying what the model decided, which is what makes an override reversible and auditable.
  async setOverride(input: ScreeningOverrideInput): Promise<ScreeningOverride> {
    const client = await this.getClient()
    if (!input.reason.trim()) {
      throw new Error('An override must carry a reason; a decision without one cannot be reviewed.')
    }
    if (!input.actor.trim()) {
      throw new Error('An override must name the actor who decided it.')
    }
    const data = {
      decision: input.decision,
      reason: input.reason.trim(),
      actor: input.actor.trim(),
      createdAt: new Date()
    }
    const row = await client.screeningOverride.upsert({
      where: {
        collectionId_referenceId: {
          collectionId: input.collectionId,
          referenceId: input.referenceId
        }
      },
      create: {
        collectionId: input.collectionId,
        referenceId: input.referenceId,
        ...data
      },
      update: data
    })
    return mapScreeningOverride(row as StoredScreeningOverrideRow)
  }

  // Drops the human layer for one reference, which is exactly "go back to the AI verdict": nothing was
  // written into the assessment layer to undo.
  async clearOverride(collectionId: string, referenceId: string): Promise<void> {
    const client = await this.getClient()
    await client.screeningOverride.deleteMany({ where: { collectionId, referenceId } })
  }

  async getOverride(collectionId: string, referenceId: string): Promise<ScreeningOverride | null> {
    const client = await this.getClient()
    const row = await client.screeningOverride.findUnique({
      where: { collectionId_referenceId: { collectionId, referenceId } }
    })
    return row ? mapScreeningOverride(row as StoredScreeningOverrideRow) : null
  }

  async listOverrides(collectionId: string): Promise<ScreeningOverride[]> {
    const client = await this.getClient()
    const rows = await client.screeningOverride.findMany({
      where: { collectionId },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map((row) => mapScreeningOverride(row as StoredScreeningOverrideRow))
  }

  // What a surface shows for each reference: the AI verdict beside the human layer, with effective /
  // effectiveSource saying which one a person acts on. The two layers are read apart and merged only in
  // the projection, so no read path can confuse a person's decision for the model's.
  async listDecisionViews(
    collectionId: string,
    referenceIds?: readonly string[]
  ): Promise<ScreeningDecisionView[]> {
    const client = await this.getClient()
    const filter =
      referenceIds === undefined ? {} : { referenceId: { in: [...new Set(referenceIds)] } }
    const [assessmentRows, overrideRows] = await Promise.all([
      client.screeningAssessment.findMany({ where: { collectionId, ...filter } }),
      client.screeningOverride.findMany({ where: { collectionId, ...filter } })
    ])
    const overridesByReference = new Map(
      overrideRows.map((row) => {
        const override = mapScreeningOverride(row as StoredScreeningOverrideRow)
        return [override.referenceId, override] as const
      })
    )
    const views = assessmentRows.map((row) => {
      const assessment = mapScreeningAssessment(row as StoredScreeningAssessmentRow)
      const override = overridesByReference.get(assessment.referenceId) ?? null
      const { effective, source } = resolveEffectiveDecision(assessment.verdict, override)
      return {
        referenceId: assessment.referenceId,
        verdict: assessment.verdict,
        override,
        effective,
        effectiveSource: source
      } satisfies ScreeningDecisionView
    })
    // A person may decide before the model ever runs: that reference belongs in the list too, with its
    // verdict honestly reported as unprocessed.
    const seen = new Set(views.map((view) => view.referenceId))
    for (const [referenceId, override] of overridesByReference) {
      if (seen.has(referenceId)) continue
      const { effective, source } = resolveEffectiveDecision('not-evaluated', override)
      views.push({
        referenceId,
        verdict: 'not-evaluated',
        override,
        effective,
        effectiveSource: source
      })
    }
    return views.sort((left, right) =>
      left.referenceId < right.referenceId ? -1 : left.referenceId > right.referenceId ? 1 : 0
    )
  }

  // --- runs and items: a resumable pass ----------------------------------------------------------

  // Opens a pass bound to one rule revision (a run against a revision that does not exist is refused —
  // the binding is what makes its verdicts explainable). Item rows start 'pending' so an interrupted pass
  // can be resumed per item instead of restarted.
  async startRun(input: StartScreeningRunInput): Promise<ScreeningRun> {
    const client = await this.getClient()
    const revision = await client.screeningRuleRevision.findUnique({
      where: {
        collectionId_revision: { collectionId: input.collectionId, revision: input.ruleRevision }
      }
    })
    if (!revision) {
      throw new Error(
        `Screening rule revision ${input.ruleRevision} does not exist for collection ${input.collectionId}; a run can only be bound to a revision that exists.`
      )
    }
    const run = await client.screeningRun.create({
      data: {
        collectionId: input.collectionId,
        ruleRevision: input.ruleRevision,
        status: 'running'
      }
    })
    const items = new Map<string, { referenceId: string; inputDigest?: string }>()
    for (const item of input.items) {
      if (!items.has(item.referenceId)) items.set(item.referenceId, item)
    }
    if (items.size > 0) {
      await client.screeningRunItem.createMany({
        data: [...items.values()].map((item) => ({
          runId: run.id,
          referenceId: item.referenceId,
          state: 'pending',
          ...(item.inputDigest === undefined ? {} : { inputDigest: item.inputDigest })
        }))
      })
    }
    return mapScreeningRun(run as StoredScreeningRunRow)
  }

  async getRun(runId: string): Promise<ScreeningRun | null> {
    const client = await this.getClient()
    const row = await client.screeningRun.findUnique({ where: { id: runId } })
    return row ? mapScreeningRun(row as StoredScreeningRunRow) : null
  }

  async listRuns(collectionId: string): Promise<ScreeningRun[]> {
    const client = await this.getClient()
    const rows = await client.screeningRun.findMany({
      where: { collectionId },
      orderBy: { startedAt: 'desc' }
    })
    return rows.map((row) => mapScreeningRun(row as StoredScreeningRunRow))
  }

  async listRunItems(runId: string): Promise<ScreeningRunItem[]> {
    const client = await this.getClient()
    const rows = await client.screeningRunItem.findMany({
      where: { runId },
      orderBy: { referenceId: 'asc' }
    })
    return rows.map((row) => mapScreeningRunItem(row as StoredScreeningRunItemRow))
  }

  // Writes one item's progress. Upserting on (runId, referenceId) means a resumed pass overwrites its own
  // row rather than stacking duplicate progress. failureKind / deferredReason are cleared on every write
  // (they describe the last attempt, not the item), while an omitted inputDigest is left as it was — a
  // resume compares that digest to the one on hand to decide whether the item must be re-evaluated.
  async recordRunItem(input: RecordScreeningRunItemInput): Promise<ScreeningRunItem> {
    const client = await this.getClient()
    const run = await client.screeningRun.findUnique({ where: { id: input.runId } })
    if (!run) throw new Error(`Screening run ${input.runId} not found.`)
    if (run.status !== 'running') {
      throw new Error(
        `Screening run ${input.runId} is ${run.status}; items cannot be recorded after a run finished.`
      )
    }
    const transient = {
      state: input.state,
      failureKind: input.failureKind ?? null,
      deferredReason: input.deferredReason ?? null
    }
    const row = await client.screeningRunItem.upsert({
      where: {
        runId_referenceId: { runId: input.runId, referenceId: input.referenceId }
      },
      create: {
        runId: input.runId,
        referenceId: input.referenceId,
        ...transient,
        inputDigest: input.inputDigest ?? null
      },
      update: {
        ...transient,
        ...(input.inputDigest === undefined ? {} : { inputDigest: input.inputDigest })
      }
    })
    return mapScreeningRunItem(row as StoredScreeningRunItemRow)
  }

  // Closes a pass. The finish time is written once — a second call is refused so a finished run's
  // timeline cannot move. unprocessedCount counts items still 'pending' after the status change, so a
  // completed pass that left work behind says so instead of reporting itself done.
  async finishRun(
    runId: string,
    status: Exclude<ScreeningRunStatus, 'running'>,
    finishedAt?: number
  ): Promise<{ run: ScreeningRun; unprocessedCount: number }> {
    const client = await this.getClient()
    const existing = await client.screeningRun.findUnique({ where: { id: runId } })
    if (!existing) throw new Error(`Screening run ${runId} not found.`)
    if (existing.status !== 'running') {
      throw new Error(
        `Screening run ${runId} is already ${existing.status}; its finish time is written once.`
      )
    }
    const row = await client.screeningRun.update({
      where: { id: runId },
      data: { status, finishedAt: new Date(finishedAt ?? Date.now()) }
    })
    const unprocessedCount = await client.screeningRunItem.count({
      where: { runId, state: 'pending' }
    })
    return { run: mapScreeningRun(row as StoredScreeningRunRow), unprocessedCount }
  }
}
