// Knowledge retrieval fusion (v2.6.0 A1). Two ranked lists go in — the lexical hits the incremental
// index produced, and the semantic hits an embedding source produced — and one list comes out where
// every row says *why* it is there.
//
// Rules this module keeps:
//   1. A row's origin is never guessed. `matchedBy` is 'lexical', 'semantic' or 'both', decided by
//      which lists the row appeared in; a semantic row that lexical also found is 'both', not
//      'semantic', so a reader can tell coincidence from agreement.
//   2. Ordering is deterministic. Scores are computed from the ranks/scores the ports reported and
//      ties break on the citation key, so the same two lists always fuse into the same answer — no
//      clock, no map iteration order, no random tie-break.
//   3. Fusion never invents a hit. It only merges rows the ports actually returned; a row present in
//      neither list cannot appear here.

import type { KnowledgeLocator } from './knowledge'

/** A stable identity for "the same span of the same source", used to join the two lists. */
export const knowledgeHitKey = (sourceId: string, locator: KnowledgeLocator): string => {
  if (locator.kind === 'file') return `${sourceId}|file:${locator.path}:${locator.startLine}`
  if (locator.kind === 'pdf') return `${sourceId}|pdf:${locator.path}:${locator.page}`
  return `${sourceId}|url:${locator.url}`
}

export type KnowledgeFusionRow = {
  sourceId: string
  label: string
  locator: KnowledgeLocator
  /** 0-based position in the lexical list, when the lexical index returned this row. */
  lexicalRank?: number
  /** The semantic source's own score for this row, when it returned one. */
  semanticScore?: number
}

export type KnowledgeFusedHit = {
  sourceId: string
  label: string
  locator: KnowledgeLocator
  matchedBy: 'lexical' | 'semantic' | 'both'
  /** The fused score the ordering used; reported so a caller can see why a row ranked where it did. */
  score: number
}

export type KnowledgeFusionOptions = {
  limit?: number
  /** Weights are reported with the result so the recipe is visible rather than implied. */
  lexicalWeight?: number
  semanticWeight?: number
}

export type KnowledgeFusionResult = {
  hits: KnowledgeFusedHit[]
  counts: { lexical: number; semantic: number; both: number }
  recipe: { lexicalWeight: number; semanticWeight: number; lexicalScore: 'inverse-rank' }
}

const DEFAULT_LEXICAL_WEIGHT = 1
const DEFAULT_SEMANTIC_WEIGHT = 1

/** Rank 0 scores 1, rank 1 scores 1/2, rank n scores 1/(n+1) — independent of any clock. */
const inverseRank = (rank: number): number => 1 / (rank + 1)

export const fuseKnowledgeHits = (
  lexical: readonly KnowledgeFusionRow[],
  semantic: readonly KnowledgeFusionRow[],
  options: KnowledgeFusionOptions = {}
): KnowledgeFusionResult => {
  const lexicalWeight = options.lexicalWeight ?? DEFAULT_LEXICAL_WEIGHT
  const semanticWeight = options.semanticWeight ?? DEFAULT_SEMANTIC_WEIGHT

  const merged = new Map<string, KnowledgeFusedHit & { key: string }>()
  const counts = { lexical: 0, semantic: 0, both: 0 }

  for (const row of lexical) {
    const key = knowledgeHitKey(row.sourceId, row.locator)
    const rank = row.lexicalRank ?? 0
    merged.set(key, {
      key,
      sourceId: row.sourceId,
      label: row.label,
      locator: row.locator,
      matchedBy: 'lexical',
      score: lexicalWeight * inverseRank(rank)
    })
    counts.lexical += 1
  }

  for (const row of semantic) {
    const key = knowledgeHitKey(row.sourceId, row.locator)
    const semanticPart = semanticWeight * (row.semanticScore ?? 0)
    const existing = merged.get(key)
    if (existing) {
      existing.matchedBy = 'both'
      existing.score += semanticPart
      counts.both += 1
    } else {
      merged.set(key, {
        key,
        sourceId: row.sourceId,
        label: row.label,
        locator: row.locator,
        matchedBy: 'semantic',
        score: semanticPart
      })
      counts.semantic += 1
    }
  }

  const all = [...merged.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    // Deterministic tie-break on the citation key, so equal scores never depend on insertion order.
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  })

  const limited =
    typeof options.limit === 'number' && options.limit >= 0 ? all.slice(0, options.limit) : all

  return {
    hits: limited.map(({ key: _key, ...hit }) => hit),
    counts,
    recipe: { lexicalWeight, semanticWeight, lexicalScore: 'inverse-rank' }
  }
}
