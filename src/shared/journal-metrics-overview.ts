// The journal-metric screening view (R2-U3), as a pure function.
//
// Three rules shape this file, and each exists because the alternative looks like a working screen:
//   * every number is shown WITH the year and the source it came from — a metric without them is a claim
//     nobody can check, so a cell carries all three or it is `unknown`;
//   * a missing metric is `unknown`, never 0 and never blank — "we have not imported this journal's impact
//     factor" and "its impact factor is zero" are different facts, and only one of them is true here;
//   * a value that cannot be compared numerically is not compared: the number used for filtering is
//     `numericValue`, which the store computed when the row was written (`null` when the source's text is
//     not a number). Re-parsing the display text here would be a second rule that drifts from that one.
//
// Every journal lands in exactly one count bucket, so the screen can always account for the difference
// between "the filter matched nothing" and "there are no journals": total = matched + missing + notNumeric
// + notMatching.

import { KNOWN_JOURNAL_METRIC_KINDS } from './journal-metrics'
import { journalDisplayName } from './journal-merge'

// One claim about one journal, as the store keeps it. `fetchedAt` stays loose because it is a Date in the
// main process and a string once it has travelled over the RPC boundary; the tie-break below reads both.
export type JournalMetricClaim = {
  journalId: string
  kind: string
  value: string
  numericValue: number | null
  year: number
  source: string
  fetchedAt: number | string | Date
}

export type JournalIdentityRow = {
  id: string
  normalizedName: string
  // The spelling the source used, when the record has one (R2-U4). Optional because rows created before the
  // column existed have none — the surface falls back to the normalized form rather than showing a blank.
  displayName?: string | null
  issn: string | null
}

// One alias row: a spelling that resolves to a journal (written only by an explicit merge).
export type JournalAliasRow = {
  normalizedName: string
  journalId: string
  createdVia: string
}

export type JournalMetricsFilter = {
  // A value of the `cas-partition` kind, e.g. 一区 / Q1. Compared after trimming and case-folding, because
  // the same partition is printed in several type systems (the store keeps the source's own spelling).
  partition?: string
  minImpactFactor?: number
  maxImpactFactor?: number
  // Restricts the comparison to claims from one year. When absent, each journal is judged on its most
  // recent claim for that kind — and the panel must show which year that was.
  year?: number
}

export type JournalMetricCell =
  | {
      state: 'known'
      value: string
      numericValue: number | null
      year: number
      source: string
    }
  | { state: 'unknown' }

export type JournalOverviewRow = {
  journalId: string
  name: string
  issn: string | null
  // The other spellings that resolve to this journal (a merge's record). Empty for a journal nobody merged.
  aliases: string[]
  // Keyed by metric kind. Kinds the library knows about are always present (as `unknown` when absent), so a
  // column cannot vanish just because nobody imported that kind yet.
  cells: Record<string, JournalMetricCell>
}

export type JournalOverviewCounts = {
  total: number
  matched: number
  // No claim of the kind the filter asks about: shown as 未知/unknown, never as 0.
  missingMetric: number
  // The claim exists but its value is not a number (e.g. "n/a"), so a numeric filter cannot judge it.
  valueNotNumeric: number
  // The value is known and comparable, and the filter's bounds excluded it.
  notMatching: number
}

export type JournalMetricsOverview = {
  rows: JournalOverviewRow[]
  counts: JournalOverviewCounts
  // The kinds actually rendered, so the panel and this function cannot disagree about the table's columns.
  kinds: string[]
}

// What the read channel hands the renderer: the journal identities and every claim, unfiltered. Filtering is
// the pure function above, so the filter can change many times without another round trip — and so the same
// function is what the tests and the real-machine reading both check.
export type JournalMetricLibrary = {
  journals: JournalIdentityRow[]
  claims: JournalMetricClaim[]
  // Every alias in the library, so the panel can show which older spellings resolve to which journal without
  // a second round trip. Absent aliases are an empty list, never an omitted field.
  aliases: JournalAliasRow[]
}

const fold = (value: string): string => value.trim().toLowerCase()

const timeOf = (value: number | string | Date): number => {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value

  return new Date(value).getTime()
}

// The claim a journal is judged on for one kind: the most recent year, and among equally recent years the
// one fetched last. Deterministic, so the same database always produces the same screen.
export const selectLatestClaim = (
  claims: readonly JournalMetricClaim[],
  kind: string,
  year?: number
): JournalMetricClaim | null => {
  let best: JournalMetricClaim | null = null
  for (const claim of claims) {
    if (claim.kind !== kind) continue
    if (year !== undefined && claim.year !== year) continue
    if (best === null) {
      best = claim
      continue
    }
    if (claim.year > best.year) {
      best = claim
      continue
    }
    if (claim.year === best.year && timeOf(claim.fetchedAt) > timeOf(best.fetchedAt)) best = claim
  }

  return best
}

export const journalMetricKinds = (claims: readonly JournalMetricClaim[]): string[] => {
  const kinds = new Set<string>(KNOWN_JOURNAL_METRIC_KINDS)
  for (const claim of claims) kinds.add(claim.kind)

  return [...kinds].sort()
}

const cellOf = (claim: JournalMetricClaim | null): JournalMetricCell =>
  claim === null
    ? { state: 'unknown' }
    : {
        state: 'known',
        value: claim.value,
        numericValue: claim.numericValue,
        year: claim.year,
        source: claim.source
      }

const withinBounds = (numericValue: number, filter: JournalMetricsFilter): boolean => {
  if (filter.minImpactFactor !== undefined && numericValue < filter.minImpactFactor) return false
  if (filter.maxImpactFactor !== undefined && numericValue > filter.maxImpactFactor) return false

  return true
}

export const buildJournalMetricsOverview = (input: {
  journals: readonly JournalIdentityRow[]
  claims: readonly JournalMetricClaim[]
  aliases?: readonly JournalAliasRow[]
  filter?: JournalMetricsFilter
}): JournalMetricsOverview => {
  const filter = input.filter ?? {}
  const aliasRows = input.aliases ?? []
  const kinds = journalMetricKinds(input.claims)
  const partition = filter.partition ? fold(filter.partition) : undefined
  const asksNumbers = filter.minImpactFactor !== undefined || filter.maxImpactFactor !== undefined
  const rows: JournalOverviewRow[] = []
  const counts: JournalOverviewCounts = {
    total: 0,
    matched: 0,
    missingMetric: 0,
    valueNotNumeric: 0,
    notMatching: 0
  }

  for (const journal of input.journals) {
    const claims = input.claims.filter((claim) => claim.journalId === journal.id)
    const cells: Record<string, JournalMetricCell> = {}
    for (const kind of kinds) cells[kind] = cellOf(selectLatestClaim(claims, kind, filter.year))

    counts.total += 1
    // Only the kinds the filter actually asks about can exclude a journal; a filter about partitions says
    // nothing about impact factors, so it must not silently drop journals for lacking one.
    let verdict: keyof Omit<JournalOverviewCounts, 'total'> = 'matched'
    if (partition !== undefined) {
      const claim = selectLatestClaim(claims, 'cas-partition', filter.year)
      if (claim === null) verdict = 'missingMetric'
      else if (fold(claim.value) !== partition) verdict = 'notMatching'
    }
    if (verdict === 'matched' && asksNumbers) {
      const claim = selectLatestClaim(claims, 'impact-factor', filter.year)
      if (claim === null) verdict = 'missingMetric'
      else if (claim.numericValue === null) verdict = 'valueNotNumeric'
      else if (!withinBounds(claim.numericValue, filter)) verdict = 'notMatching'
    }
    counts[verdict] += 1
    if (verdict === 'matched') {
      rows.push({
        journalId: journal.id,
        // The source's own spelling when the record kept one; the normalized form otherwise. Never blank.
        name: journalDisplayName(journal),
        issn: journal.issn,
        aliases: aliasRows
          .filter((alias) => alias.journalId === journal.id)
          .map((alias) => alias.normalizedName)
          .sort(),
        cells
      })
    }
  }

  rows.sort((left, right) => left.name.localeCompare(right.name))

  return { rows, counts, kinds }
}
