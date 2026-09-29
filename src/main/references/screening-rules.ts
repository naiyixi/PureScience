import { createHash } from 'node:crypto'

import type { ScreeningCriterion } from '../../shared/references-screening'

// Rule content: how an inclusion / exclusion rule set is serialized, hashed, and compared. Kept apart
// from the repository so "two revisions state the same rule" is a property that can be asserted without
// a database — and apart from the decision semantics, which are about a verdict rather than a rule.
//
// Canonical form matters more than it looks: the hash is what makes a revision verifiable and what lets
// an append notice that nothing changed. If reordering the same criteria produced a new hash, a save that
// only reordered rows would look like a rule change and stale every decision in the collection.

// Criteria are ordered by id, and only the two fields that mean something are serialized. Text is kept
// byte-for-byte (it is quoted in evidence, so normalizing it would break the citation it supports).
export const canonicalCriteria = (criteria: readonly ScreeningCriterion[]): ScreeningCriterion[] =>
  criteria
    .map((criterion) => ({ id: criterion.id.trim(), text: criterion.text }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))

export const serializeScreeningCriteria = (criteria: readonly ScreeningCriterion[]): string =>
  JSON.stringify(canonicalCriteria(criteria))

export const serializeScreeningRule = (
  inclusion: readonly ScreeningCriterion[],
  exclusion: readonly ScreeningCriterion[]
): string =>
  JSON.stringify({
    inclusion: canonicalCriteria(inclusion),
    exclusion: canonicalCriteria(exclusion)
  })

// sha256 of the canonical rule JSON, hex. Compared, never interpreted: it exists so two revisions can be
// proven identical (or not) without diffing criteria by hand.
export const screeningRuleContentHash = (
  inclusion: readonly ScreeningCriterion[],
  exclusion: readonly ScreeningCriterion[]
): string =>
  createHash('sha256').update(serializeScreeningRule(inclusion, exclusion), 'utf8').digest('hex')

// Parses a stored criteria column. A row that does not parse, or that holds anything other than the
// expected shape, reads as "no criteria written" rather than as a partly-invented rule set.
export const parseScreeningCriteria = (value: string): ScreeningCriterion[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter(
      (entry): entry is { id: string; text: string } =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === 'string' &&
        typeof (entry as { text?: unknown }).text === 'string'
    )
    .map((entry) => ({ id: entry.id, text: entry.text }))
}

// The revision a new append gets: one past the newest, so revisions are contiguous and a rule change is
// always a new row. An empty history starts at 1 (a revision is 1-based, never 0).
export const nextRuleRevision = (latestRevision: number | null): number =>
  latestRevision === null ? 1 : latestRevision + 1
