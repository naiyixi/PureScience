// Turning a triaged collection into an EXPORT RANGE (S4). One question, answered once: given a
// collection's screening lines, which records may a GB/T 7714 export contain, and what must the receipt
// say about the ones it leaves out.
//
// Two rules, both from the plan's red lines, are the whole reason this is a module instead of a
// `.filter()` at the call site:
//
//   1. the range is the EFFECTIVE verdict — a person's override outranks the AI's own answer — so a
//      record the model called uncertain is exported when a reviewer included it, and a record the model
//      called included is NOT exported when a reviewer excluded it;
//   2. nothing leaves the surface silently: the records that stay out are counted per state (the same
//      four states the panel shows) AND per named reason, and the counts are carried WITH the range, so
//      a receipt cannot be built by subtracting rows a caller happens to be holding.
//
// Pure and renderer-safe (it imports the closed vocabulary and nothing else), so the range rule is
// assertable without a database, a model or a window.

import {
  SCREENING_NAMED_REASONS,
  SCREENING_VERDICTS,
  type ScreeningItemView,
  type ScreeningNamedReason,
  type ScreeningRuleRevision,
  type ScreeningVerdict
} from './references-screening'

// The one scope this export knows. Named (rather than a boolean) because the range is something the
// surface has to STATE, and because the file name and the receipt both carry it.
export const SCREENING_EXPORT_SCOPE = 'included-only' as const
export type ScreeningExportScopeKind = typeof SCREENING_EXPORT_SCOPE

export type ScreeningExportScope = {
  kind: ScreeningExportScopeKind
  collectionId: string
  // The records the export may contain, in the order the lines arrived (stable, so two reads of the
  // same ledger produce the same list).
  includedReferenceIds: string[]
  includedCount: number
  // Every record in the collection, exported or not: includedCount + notExportedCount === totalCount,
  // asserted below rather than left as an arithmetic hope.
  totalCount: number
  notExportedCount: number
  // The effective verdict of each NON-exported record. 'included' is present and always 0 (a record
  // included by its effective verdict is, by definition, exported) — the key stays so a caller can
  // render the four states without special cases.
  notExportedCounts: Record<ScreeningVerdict, number>
  // The named reasons behind the non-exported records (a stale decision, a changed rule, missing
  // evidence …). The named-reason vocabulary is closed, so this record is exhaustive.
  notExportedByReason: Record<ScreeningNamedReason, number>
  // 人工覆盖优先于 AI 原判, both directions, counted apart from the totals:
  //  * includedByOverrideCount — in the export only because a person included what the AI had not;
  //  * notExportedByOverrideCount — out of the export because a person excluded it (whatever the AI
  //    said). This is the number that makes "the file contains only what a reviewer accepted" checkable.
  includedByOverrideCount: number
  notExportedByOverrideCount: number
  // The rule revision the range was computed against. Null when the collection has no revision yet —
  // in which case every line is unprocessed and the export range is empty, which is stated rather than
  // silently exporting the whole collection.
  ruleRevision: number | null
  ruleContentHash: string | null
}

const emptyVerdictCounts = (): Record<ScreeningVerdict, number> =>
  Object.fromEntries(SCREENING_VERDICTS.map((verdict) => [verdict, 0])) as Record<
    ScreeningVerdict,
    number
  >

const emptyReasonCounts = (): Record<ScreeningNamedReason, number> =>
  Object.fromEntries(SCREENING_NAMED_REASONS.map((reason) => [reason, 0])) as Record<
    ScreeningNamedReason,
    number
  >

export const buildScreeningExportScope = (input: {
  collectionId: string
  rule: ScreeningRuleRevision | null
  items: readonly ScreeningItemView[]
}): ScreeningExportScope => {
  const includedReferenceIds: string[] = []
  const notExportedCounts = emptyVerdictCounts()
  const notExportedByReason = emptyReasonCounts()
  let includedByOverrideCount = 0
  let notExportedByOverrideCount = 0

  for (const item of input.items) {
    const { effective, verdict, effectiveSource } = item.decision
    if (effective === 'included') {
      includedReferenceIds.push(item.referenceId)
      // The AI's own verdict was anything but include: the human layer is what put this record in the
      // export, and the receipt says so (never presenting a person's decision as the model's).
      if (verdict !== 'included') includedByOverrideCount += 1
      continue
    }
    notExportedCounts[effective] += 1
    if (effectiveSource === 'override') notExportedByOverrideCount += 1
    // Named reasons travel with the exclusion: "we left it out" is only reviewable if it can say why.
    for (const reason of item.freshness.reasons) notExportedByReason[reason] += 1
  }

  const includedCount = includedReferenceIds.length
  const notExportedCount = input.items.length - includedCount

  return {
    kind: SCREENING_EXPORT_SCOPE,
    collectionId: input.collectionId,
    includedReferenceIds,
    includedCount,
    totalCount: input.items.length,
    notExportedCount,
    notExportedCounts,
    notExportedByReason,
    includedByOverrideCount,
    notExportedByOverrideCount,
    ruleRevision: input.rule?.revision ?? null,
    ruleContentHash: input.rule?.contentHash ?? null
  }
}

// The four-state breakdown of what stayed out, in vocabulary order, with zero-count states kept: a
// surface that hid an empty bucket could not distinguish "none" from "we forgot to ask".
export const screeningExportNotExportedBreakdown = (
  scope: ScreeningExportScope
): { verdict: ScreeningVerdict; count: number }[] =>
  SCREENING_VERDICTS.map((verdict) => ({ verdict, count: scope.notExportedCounts[verdict] }))

// The named reasons behind what stayed out, zero-count reasons dropped (there is nothing to explain).
export const screeningExportReasonBreakdown = (
  scope: ScreeningExportScope
): { reason: ScreeningNamedReason; count: number }[] =>
  SCREENING_NAMED_REASONS.filter((reason) => scope.notExportedByReason[reason] > 0).map(
    (reason) => ({
      reason,
      count: scope.notExportedByReason[reason]
    })
  )

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

// The file the export writes, named so the file itself carries the trace: the scope it was built to
// ("included-only"), the collection, the rule revision it was judged against, the citation style and the
// day. A bibliography on someone's desktop is then attributable to a revision, not to a mood.
export const screeningExportFileName = (input: {
  collectionName: string
  styleId: string
  revision: number | null
  generatedAt: number
}): string => {
  const collection = slug(input.collectionName) || 'collection'
  const style = slug(input.styleId) || 'style'
  const revision = input.revision === null ? 'r-unknown' : `r${input.revision}`
  const date = new Date(input.generatedAt).toISOString().slice(0, 10)
  return `references-${collection}-${SCREENING_EXPORT_SCOPE}-${revision}-${style}-${date}.txt`
}
