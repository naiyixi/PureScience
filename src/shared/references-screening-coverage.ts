// The coverage checklist (S5): one collection's corpus laid out so a reader can CHECK the coverage
// claim rather than trust it. Every number a surface shows here is derived from the collection's own
// screening lines, and every way those lines could fail to add up is reported instead of smoothed over.
//
// Three properties, each of which the plan makes non-negotiable:
//
//   1. 每篇恰属其一 — every reference lands in exactly ONE of the four evidence tiers
//      (full-text / abstract-only / metadata-only / unavailable). The four tier counts are therefore a
//      partition of the candidates, and "the four counts add up to the candidate count" is an
//      arithmetic fact the surface can assert, not a hope. A row whose coverage value is not one of the
//      four is NOT quietly bucketed: it is left out of the partition and named as a violation, which
//      makes the tier sum disagree with the candidate count — visible, exactly as it should be.
//
//   2. 未处理量显式 — the unprocessed references are enumerated by id, and the count is carried beside
//      them. "How much is left" is a list, never the absence of a row.
//
//   3. candidateCount ≤ searchedCount — where the two totals are carried, the nesting is VERIFIED here
//      (the domain layer throws on it; a read path reports it, because a surface that cannot render is
//      not a safer surface). Both totals travel with the checklist, so a caller can never show one
//      without the other.
//
// On the searched total: this build measures NO separate "how many hits did the search return" number.
// A screen runs over a collection, so the collection's members are simultaneously the searched corpus
// and the candidate set, and both totals are that one count — the constant SCREENING_SEARCHED_SCOPE
// names that scope so a surface cannot present it as a retrieval hit count the application does not
// keep. When a real retrieval count exists, it has one place to land and one comparison to satisfy.
//
// Pure and renderer-safe: it imports the closed vocabulary and nothing else, so the partition and the
// arithmetic are assertable without a database, a model or a window.

import {
  SCREENING_EVIDENCE_COVERAGES,
  type ScreeningEvidenceCoverage,
  type ScreeningItemView,
  type ScreeningVerdict
} from './references-screening'

// What the searched total actually counts. Named rather than implied: the alternative reading —
// "how many records did retrieval return" — is not something this application stores, and a surface
// may not imply it.
export const SCREENING_SEARCHED_SCOPE = 'collection-members' as const
export type ScreeningSearchedScope = typeof SCREENING_SEARCHED_SCOPE

// One tier's slice of the partition, with its members spelled out. A tier with no members is still
// present (count 0), because an empty tier is a fact — "none" — while a missing tier could not be told
// apart from "we forgot to ask".
export type ScreeningCoverageGroup = {
  coverage: ScreeningEvidenceCoverage
  count: number
  items: ScreeningCoverageItem[]
}

export type ScreeningCoverageItem = {
  referenceId: string
  // The stored AI verdict, unmodified. An item with a human override still reports the model's own
  // verdict here: the AI layer and the human layer stay apart everywhere in this codebase.
  verdict: ScreeningVerdict
  // verdict === 'not-evaluated': no assessment exists, which is the same definition the statistics use
  // (S4's unprocessedCount = candidates − assessed). Stated per item so the surface can mark it.
  unprocessed: boolean
}

export type ScreeningCoverageChecklist = {
  collectionId: string
  searchedScope: ScreeningSearchedScope
  searchedCount: number
  candidateCount: number
  // How many references were placed in a tier. Must equal candidateCount; when it does not, the
  // disagreement is in `violations` and `reconciled` is false.
  classifiedCount: number
  // The four tiers, in vocabulary order, always all four.
  groups: ScreeningCoverageGroup[]
  // Every candidate exactly once, in tier order: the list a "we looked at each of them" claim is
  // checked against.
  referenceIds: string[]
  unprocessedReferenceIds: string[]
  unprocessedCount: number
  // The unprocessed quantity is also cut by tier, so "what is still unprocessed, and on how much
  // evidence would it be decided" is answerable without re-deriving anything.
  unprocessedByCoverage: Record<ScreeningEvidenceCoverage, number>
  // candidateCount ≤ searchedCount.
  withinSearched: boolean
  // classifiedCount === candidateCount and the tier sum is intact.
  reconciled: boolean
  // Everything that did not add up, in words, so the surface shows a failed check instead of a total
  // that quietly means nothing. Empty for a healthy collection.
  violations: string[]
}

const countByCoverage = (
  entries: readonly { coverage: ScreeningEvidenceCoverage }[]
): Record<ScreeningEvidenceCoverage, number> =>
  entries.reduce(
    (counts, entry) => {
      counts[entry.coverage] += 1
      return counts
    },
    Object.fromEntries(SCREENING_EVIDENCE_COVERAGES.map((coverage) => [coverage, 0])) as Record<
      ScreeningEvidenceCoverage,
      number
    >
  )

const isKnownCoverage = (value: string): value is ScreeningEvidenceCoverage =>
  (SCREENING_EVIDENCE_COVERAGES as readonly string[]).includes(value)

const nonNegativeInteger = (value: number, label: string): string | null =>
  Number.isInteger(value) && value >= 0
    ? null
    : `${label} must be a non-negative integer, got ${String(value)}.`

export const buildScreeningCoverageChecklist = (input: {
  collectionId: string
  searchedCount: number
  candidateCount: number
  items: readonly ScreeningItemView[]
}): ScreeningCoverageChecklist => {
  const violations: string[] = []
  let countsUsable = true
  for (const [value, label] of [
    [input.searchedCount, 'searchedCount'],
    [input.candidateCount, 'candidateCount']
  ] as const) {
    const problem = nonNegativeInteger(value, label)
    if (problem) {
      violations.push(problem)
      countsUsable = false
    }
  }
  // The plan's nesting, verified rather than trusted: a screen cannot have considered more records
  // than it searched.
  if (input.candidateCount > input.searchedCount) {
    violations.push(
      `candidateCount (${input.candidateCount}) exceeds searchedCount (${input.searchedCount}); a screen cannot consider more records than it searched.`
    )
  }

  const groups: ScreeningCoverageGroup[] = SCREENING_EVIDENCE_COVERAGES.map((coverage) => ({
    coverage,
    count: 0,
    items: []
  }))
  const byCoverage = new Map(groups.map((group) => [group.coverage, group]))
  const seen = new Set<string>()
  const unprocessedByCoverage = Object.fromEntries(
    SCREENING_EVIDENCE_COVERAGES.map((coverage) => [coverage, 0])
  ) as Record<ScreeningEvidenceCoverage, number>

  for (const item of input.items) {
    const coverage: string = item.coverage
    if (!isKnownCoverage(coverage)) {
      // Left out of the partition on purpose: the tier counts then no longer add up to the candidate
      // count, which `reconciled` reports. Silently filing it somewhere would hide the defect.
      violations.push(
        `reference ${item.referenceId} carries coverage "${coverage}", which is not one of the four evidence tiers.`
      )
      continue
    }
    if (seen.has(item.referenceId)) {
      // 每篇恰属其一: a second row for the same reference would inflate a tier count.
      violations.push(
        `reference ${item.referenceId} appears more than once; each reference must belong to exactly one tier.`
      )
      continue
    }
    seen.add(item.referenceId)

    const unprocessed = item.decision.verdict === 'not-evaluated'
    const group = byCoverage.get(coverage)
    if (!group) continue
    group.items.push({ referenceId: item.referenceId, verdict: item.decision.verdict, unprocessed })
    group.count += 1
    if (unprocessed) unprocessedByCoverage[coverage] += 1
  }

  const classifiedCount = groups.reduce((sum, group) => sum + group.count, 0)
  if (classifiedCount !== input.candidateCount) {
    violations.push(
      `the four tiers add up to ${classifiedCount}, but there are ${input.candidateCount} candidates.`
    )
  }

  const unprocessedReferenceIds = groups.flatMap((group) =>
    group.items.filter((item) => item.unprocessed).map((item) => item.referenceId)
  )

  return {
    collectionId: input.collectionId,
    searchedScope: SCREENING_SEARCHED_SCOPE,
    searchedCount: input.searchedCount,
    candidateCount: input.candidateCount,
    classifiedCount,
    groups,
    referenceIds: [...seen],
    unprocessedReferenceIds,
    unprocessedCount: unprocessedReferenceIds.length,
    unprocessedByCoverage,
    withinSearched: countsUsable && input.candidateCount <= input.searchedCount,
    reconciled: classifiedCount === input.candidateCount,
    violations
  }
}

// The tier counts as a list, in vocabulary order — the same shape the export's breakdowns use, so a
// surface (or a test) reads all four tiers without special-casing the ones that happen to be empty.
export const screeningCoverageBreakdown = (
  checklist: ScreeningCoverageChecklist
): { coverage: ScreeningEvidenceCoverage; count: number }[] =>
  checklist.groups.map((group) => ({ coverage: group.coverage, count: group.count }))

// 未处理量 cut by tier: only the tiers that actually hold unprocessed work, because the others have
// nothing to explain. Kept as a function so the surface and the evidence record read one definition.
export const screeningUnprocessedBreakdown = (
  checklist: ScreeningCoverageChecklist
): { coverage: ScreeningEvidenceCoverage; count: number }[] =>
  SCREENING_EVIDENCE_COVERAGES.filter(
    (coverage) => checklist.unprocessedByCoverage[coverage] > 0
  ).map((coverage) => ({ coverage, count: checklist.unprocessedByCoverage[coverage] }))

// Re-derives the tier counts straight from the checklist's own membership lists. Nothing in production
// calls this: it exists so a test (and the acceptance archive) can compare what the surface PRINTS
// against a second, independent walk of the membership, rather than against the printed number again.
export const countScreeningCoverageItems = (
  checklist: ScreeningCoverageChecklist
): Record<ScreeningEvidenceCoverage, number> =>
  countByCoverage(
    checklist.groups.flatMap((group) => group.items.map(() => ({ coverage: group.coverage })))
  )
