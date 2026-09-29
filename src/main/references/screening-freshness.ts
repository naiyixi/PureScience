import {
  SCREENING_EVIDENCE_COVERAGES,
  SCREENING_VERDICTS,
  type ScreeningEvidenceCoverage,
  type ScreeningNamedReason,
  type ScreeningOverride,
  type ScreeningVerdict
} from '../../shared/references-screening'

// Decision semantics for literature screening: is a stored decision still today's answer, what named
// reason says it is not, what a given evidence coverage licenses, and which decisions a person has to
// look at. All pure — no client, no clock, no network — so every rule below is directly assertable.
//
// The rule that matters most: evidence nobody read can never ground an exclusion. A verdict that
// excludes on less than full text is degraded to 'needs-review' (the uncertain state), a record with no
// evidence at all stays 'not-evaluated' (an explicit "unprocessed", which statistics must list rather
// than count as a decision), and neither is ever 'excluded'.

// The identity a stored decision was produced against. Freshness compares exactly these three, because
// they are the only facts that make re-using a verdict sound: the rules, the evidence, the policy.
export type ScreeningDecisionIdentity = {
  ruleRevision: number
  inputDigest: string
  policyKey: string
}

// How much model input one record may spend. Beyond this the honest outcome is a deferred item with a
// named reason, not a truncated read that silently drops the exclusion criteria.
export const SCREENING_DEFAULT_INPUT_CHAR_BUDGET = 60_000

export type ScreeningFreshnessInput = {
  // The stored AI decision, or null when this reference has never been assessed.
  stored: {
    identity: ScreeningDecisionIdentity
    verdict: ScreeningVerdict
  } | null
  // What is on hand right now for the same reference.
  current: {
    ruleRevision: number
    inputDigest: string
    policyKey: string
    evidenceCoverage: ScreeningEvidenceCoverage
    inputChars: number
    inputCharBudget: number
  }
}

export type ScreeningFreshness = {
  // current ⇔ ruleRevision ∧ inputDigest ∧ policyKey all match, and nothing else. A decision that is
  // current is still not necessarily an answer a person acts on (see review).
  current: boolean
  // Every reason this decision is not current — never empty merely because it was awkward to name.
  reasons: ScreeningNamedReason[]
  // stale: a decision exists but must not be presented as today's answer. Either one of the three
  // identity keys moved, or the evidence no longer licenses the verdict it is paired with (the full
  // text behind an exclusion disappeared).
  stale: boolean
  // The review bucket, exactly: uncertain ∪ stale. An unassessed record is neither — it is 未处理, and
  // folding it in here is what makes "how much is left" impossible to answer.
  review: boolean
}

// Does this coverage fail to license the verdict it is paired with? Full text licenses anything; with
// less, only 'not-evaluated' and 'needs-review' stand as written, because every other verdict claims
// more than the evidence supports — 'excluded' above all.
export const coverageBlocksVerdict = (
  coverage: ScreeningEvidenceCoverage,
  verdict: ScreeningVerdict
): boolean => coverage !== 'full-text' && verdict !== 'not-evaluated' && verdict !== 'needs-review'

export const evaluateScreeningFreshness = ({
  stored,
  current
}: ScreeningFreshnessInput): ScreeningFreshness => {
  const reasons: ScreeningNamedReason[] = []
  if (stored) {
    if (stored.identity.ruleRevision !== current.ruleRevision) reasons.push('rule-changed')
    if (stored.identity.inputDigest !== current.inputDigest) reasons.push('input-changed')
    if (stored.identity.policyKey !== current.policyKey) reasons.push('model-changed')
    if (coverageBlocksVerdict(current.evidenceCoverage, stored.verdict))
      reasons.push('missing-evidence')
  } else if (current.evidenceCoverage === 'unavailable') {
    // Nothing has been decided and there is nothing to decide from: the record stays unprocessed, and
    // the missing evidence is still named rather than left as a bare blank.
    reasons.push('missing-evidence')
  }
  if (current.inputChars > current.inputCharBudget) reasons.push('input-too-long')
  if (stored?.verdict === 'needs-review') reasons.push('uncertain')

  const identityMatches =
    stored !== null &&
    stored.identity.ruleRevision === current.ruleRevision &&
    stored.identity.inputDigest === current.inputDigest &&
    stored.identity.policyKey === current.policyKey
  const stale =
    stored !== null &&
    (!identityMatches || coverageBlocksVerdict(current.evidenceCoverage, stored.verdict))

  return {
    current: identityMatches,
    reasons,
    stale,
    review: stored !== null && (stored.verdict === 'needs-review' || stale)
  }
}

export type ScreeningCoverageGuardResult = {
  verdict: ScreeningVerdict
  // True when the guard changed the verdict: the stored row then differs from the model's own answer,
  // which is why the raw output is kept beside it instead of being overwritten.
  degraded: boolean
  reason: ScreeningNamedReason | null
}

// The decision-time half of 拿不到全文 ⇒ 不确定，绝不 excluded. Applied before a verdict is stored, so the
// rule cannot be bypassed by a later read path forgetting to check.
export const applyEvidenceCoverage = (
  verdict: ScreeningVerdict,
  coverage: ScreeningEvidenceCoverage
): ScreeningCoverageGuardResult => {
  // Nothing was decided, so a coverage level cannot turn it into a decision.
  if (verdict === 'not-evaluated') return { verdict, degraded: false, reason: null }
  if (coverage === 'full-text') return { verdict, degraded: false, reason: null }
  // No evidence at all: the record is unprocessed rather than uncertain — an honest "we have not
  // looked", which the unprocessed count reports, instead of a decision that happens to be unsure.
  if (coverage === 'unavailable') {
    return { verdict: 'not-evaluated', degraded: true, reason: 'missing-evidence' }
  }
  // Abstract-only / metadata-only: uncertain, never an exclusion and never a settled inclusion.
  return {
    verdict: 'needs-review',
    degraded: verdict !== 'needs-review',
    reason: 'missing-evidence'
  }
}

// Which decision a person acts on today: the override when there is one (a person's decision outranks
// the model's), the AI verdict otherwise. Pure so the layering is testable without a database, and
// one-directional: nothing here can write back to the AI verdict.
export const resolveEffectiveDecision = (
  verdict: ScreeningVerdict,
  override: ScreeningOverride | null | undefined
): { effective: ScreeningVerdict; source: 'ai' | 'override' } => {
  if (!override) return { effective: verdict, source: 'ai' }
  return {
    effective: override.decision === 'include' ? 'included' : 'excluded',
    source: 'override'
  }
}

// One row of the coverage list: what was actually read for a record, what was decided, and whether that
// decision is still current.
export type ScreeningCoverageEntry = {
  verdict: ScreeningVerdict
  coverage: ScreeningEvidenceCoverage
  fresh: boolean
}

export type ScreeningCoverageSummary = {
  searchedCount: number
  candidateCount: number
  // Candidates that produced a decision (included / excluded / needs-review).
  assessedCount: number
  // candidateCount − assessedCount, always computed: the未处理量 is stated, never inferred from a
  // missing row.
  unprocessedCount: number
  // uncertain ∪ stale.
  reviewCount: number
  verdictCounts: Record<ScreeningVerdict, number>
  coverageCounts: Record<ScreeningEvidenceCoverage, number>
}

const emptyCounts = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>

// The coverage list a "we screened everything" claim is checked against. The nesting is asserted rather
// than trusted: totals that do not nest are exactly what makes such a claim unverifiable.
export const summarizeScreeningCoverage = (input: {
  searchedCount: number
  candidateCount: number
  entries: readonly ScreeningCoverageEntry[]
}): ScreeningCoverageSummary => {
  const { searchedCount, candidateCount, entries } = input
  if (!Number.isInteger(searchedCount) || searchedCount < 0) {
    throw new Error(`searchedCount must be a non-negative integer, got ${searchedCount}.`)
  }
  if (!Number.isInteger(candidateCount) || candidateCount < 0) {
    throw new Error(`candidateCount must be a non-negative integer, got ${candidateCount}.`)
  }
  // candidateCount ≤ searchedCount: a screen cannot have considered more records than it searched.
  if (candidateCount > searchedCount) {
    throw new Error(
      `candidateCount (${candidateCount}) exceeds searchedCount (${searchedCount}); a screen cannot consider more records than it searched.`
    )
  }
  if (entries.length > candidateCount) {
    throw new Error(
      `The coverage list has ${entries.length} entries but only ${candidateCount} candidates; decisions cannot outnumber candidates.`
    )
  }

  const verdictCounts = emptyCounts<ScreeningVerdict>(SCREENING_VERDICTS)
  const coverageCounts = emptyCounts<ScreeningEvidenceCoverage>(SCREENING_EVIDENCE_COVERAGES)
  let reviewCount = 0
  for (const entry of entries) {
    verdictCounts[entry.verdict] += 1
    coverageCounts[entry.coverage] += 1
    // An unprocessed entry is neither uncertain nor stale — it has no decision to be stale — so it must
    // not land in the review queue. Counting it here is exactly how a review queue and an unprocessed
    // count start disagreeing.
    if (entry.verdict === 'needs-review' || (entry.verdict !== 'not-evaluated' && !entry.fresh)) {
      reviewCount += 1
    }
  }

  const assessedCount =
    verdictCounts.included + verdictCounts.excluded + verdictCounts['needs-review']

  return {
    searchedCount,
    candidateCount,
    assessedCount,
    unprocessedCount: candidateCount - assessedCount,
    reviewCount,
    verdictCounts,
    coverageCounts
  }
}
