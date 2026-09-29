// Literature-screening (文献纳排分诊) domain types: one collection's references triaged against a
// versioned inclusion / exclusion rule set. The vocabulary here is deliberately closed — every state a
// reader can see is one of these values, and every decision that is not current carries a NAMED reason
// (never a bare "undecided", never a silent omission).
//
// Values are machine names. Human copy (Chinese first, then the other eight locales) is a presentation
// concern and lives with the renderer, not here — so this module imports nothing and stays renderer-safe.

// The four states a reference's screening decision can be in:
//   included       the evidence satisfies the inclusion rules and breaks none of the exclusion rules
//   needs-review   uncertain — a person has to look (this is the only home of "we are not sure")
//   excluded       excluded on evidence; never on the absence of evidence (see the coverage guard in
//                  src/main/references/screening-freshness.ts)
//   not-evaluated  nothing decided yet: the explicit form of "we have not looked", which statistics
//                  must count separately instead of folding into a verdict.
export const SCREENING_VERDICTS = ['included', 'needs-review', 'excluded', 'not-evaluated'] as const
export type ScreeningVerdict = (typeof SCREENING_VERDICTS)[number]

// Why a stored decision is not current, or why an item could not be decided. Exactly six values: a
// surface can only explain itself if the reasons are enumerable, and a reason that is not in this list
// is a bug rather than a new state.
export const SCREENING_NAMED_REASONS = [
  'rule-changed', // 规则变了: the inclusion/exclusion rule set moved to a newer revision
  'input-changed', // 依据变了: the evidence the decision was made from is not the evidence on hand now
  'model-changed', // 模型/策略变了: the model + prompt-policy identity differs from the decision's
  'missing-evidence', // 缺证据: no full text (or no evidence at all) — never grounds for exclusion
  'input-too-long', // 依据过长: the evidence exceeds the model's input budget; deferred, not guessed
  'uncertain' // 判定不确定: the decision itself is uncertain
] as const
export type ScreeningNamedReason = (typeof SCREENING_NAMED_REASONS)[number]

// How much of the record an assessment actually had to go on. Ordered from strongest to weakest, and
// exhaustive: every assessed reference lands in exactly one of these.
export const SCREENING_EVIDENCE_COVERAGES = [
  'full-text',
  'abstract-only',
  'metadata-only',
  'unavailable'
] as const
export type ScreeningEvidenceCoverage = (typeof SCREENING_EVIDENCE_COVERAGES)[number]

// A person's own decision, layered over the AI verdict. Two values only: an override decides, it does
// not annotate — anything subtler belongs in its reason.
export const SCREENING_OVERRIDE_DECISIONS = ['include', 'exclude'] as const
export type ScreeningOverrideDecision = (typeof SCREENING_OVERRIDE_DECISIONS)[number]

// Lifecycle of one screening pass. 'running' is not a failure state: an interrupted pass stays visible
// as running (with its per-item rows) instead of pretending to be finished.
export const SCREENING_RUN_STATUSES = ['running', 'completed', 'failed'] as const
export type ScreeningRunStatus = (typeof SCREENING_RUN_STATUSES)[number]

// Per-reference progress inside a pass.
export const SCREENING_RUN_ITEM_STATES = ['pending', 'assessed', 'deferred', 'failed'] as const
export type ScreeningRunItemState = (typeof SCREENING_RUN_ITEM_STATES)[number]

// How an item failed. Named, so a resumed pass can retry a transport error and keep an unusable
// response for inspection instead of retrying it forever.
export const SCREENING_FAILURE_KINDS = [
  'model-error',
  'transport-error',
  'invalid-response'
] as const
export type ScreeningFailureKind = (typeof SCREENING_FAILURE_KINDS)[number]

// One inclusion or exclusion criterion. The id is stable across revisions so an assessment's evidence
// can cite "which criterion this passage answers" without embedding the criterion text in the evidence.
export type ScreeningCriterion = {
  id: string
  text: string
}

// A rule revision is immutable once written: a change is a new revision, never an edit. contentHash is
// sha256 over the canonical rule JSON, so "same hash ⇒ same rule" holds even if the rows were written
// by different code paths.
export type ScreeningRuleRevision = {
  collectionId: string
  revision: number
  inclusion: ScreeningCriterion[]
  exclusion: ScreeningCriterion[]
  contentHash: string
  createdAt: number
}

// The model's own distribution over the outcomes. Optional keys: a model that reports only a label
// still yields a usable assessment, and a missing key is visibly missing rather than a fabricated 0.
export type ScreeningProbabilities = {
  include?: number
  exclude?: number
  uncertain?: number
}

// One passage a verdict rests on. quote is verbatim (never a paraphrase) and locator points back into
// the source the quote came from, which is what makes 每条决策带溯源 checkable rather than decorative.
export type ScreeningEvidenceCitation = {
  criterionId: string
  coverage: ScreeningEvidenceCoverage
  quote: string
  locator?: string
}

// The current AI decision for one reference in one collection. The identity triple
// (ruleRevision, inputDigest, policyKey) is what freshness compares against; model is kept for
// auditability, not comparison.
export type ScreeningAssessment = {
  collectionId: string
  referenceId: string
  ruleRevision: number
  inputDigest: string
  policyKey: string
  model: string
  verdict: ScreeningVerdict
  probabilities: ScreeningProbabilities
  evidence: ScreeningEvidenceCitation[]
  decidedAt: number
}

// A person's decision. Kept apart from ScreeningAssessment on purpose: the AI verdict is never
// rewritten, so clearing the override restores it exactly.
export type ScreeningOverride = {
  collectionId: string
  referenceId: string
  decision: ScreeningOverrideDecision
  reason: string
  actor: string
  createdAt: number
}

export type ScreeningRun = {
  id: string
  collectionId: string
  ruleRevision: number
  startedAt: number
  finishedAt?: number
  status: ScreeningRunStatus
}

// inputDigest is the digest this item was (or will be) decided from: a resume compares it against the
// digest on hand and re-evaluates only the items whose evidence changed.
export type ScreeningRunItem = {
  runId: string
  referenceId: string
  state: ScreeningRunItemState
  failureKind?: ScreeningFailureKind
  deferredReason?: ScreeningNamedReason
  inputDigest?: string
}

// What a surface reads for one reference: the AI verdict with its own identity, the human layer beside
// it (never merged into it), and which one a person should act on today.
export type ScreeningDecisionView = {
  referenceId: string
  verdict: ScreeningVerdict
  override: ScreeningOverride | null
  effective: ScreeningVerdict
  effectiveSource: 'ai' | 'override'
}
