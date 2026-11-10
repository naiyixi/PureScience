// Staleness detection for persisted reviews, kept free of electron/IPC imports so it is directly
// unit-testable and usable from any loader (IPC handler, CLI, future batch job).

import type { ReviewWithChecks, TurnScope } from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { resolveTurnScopeWithArtifactDigests } from './artifact-digest'
import type { ArtifactVersionContentResolver } from './host-sdk'
import { isTurnScopeStale } from './scope'

// How many recompositions this call actually ran versus how many reviews asked for one. Reported by the
// load path so a later reading can tell "sixty reviews cost sixty recomputations" from "sixty reviews
// cost thirty-three" without re-deriving it from the review list.
type StaleReviewScopeStats = {
  scopeComputations: number
  scopeReuses: number
}

// Marks each completed review whose audited turn no longer matches its current scope (e.g. an artifact
// was edited after the review ran). A deleted Session has no live evidence to recompute; a failure while
// reading an active Session's evidence instead fails closed as stale. Running/error reviews have no
// verdict to invalidate.
export const flagStaleReviews = async (
  reviews: ReviewWithChecks[],
  session: PersistedChatSession | undefined,
  artifactStorageRoot: string,
  resolveArtifactVersion?: ArtifactVersionContentResolver,
  stats?: StaleReviewScopeStats
): Promise<ReviewWithChecks[]> => {
  if (reviews.length === 0 || !session) return reviews
  const currentSession = session

  // A review's current scope depends only on (Session, scope.turnMessageId, scope.messageBranchId), and a
  // real Session hands this function many reviews over the same few turns: a fix-loop re-review is grouped
  // under the ORIGINAL turn id but flags against the same recomposed scope, and one measured Session held
  // 60 completed reviews across 33 distinct (turn, branch) pairs. Without sharing, each of those re-reads
  // and re-hashes the same artifact bytes and repeats the same version queries — the flag pass has been
  // measured at 52 s on one load. Keyed by exactly the inputs the recomposition depends on, so two reviews
  // share a result only when they would have been recomputed from identical inputs.
  const scopeByTurn = new Map<string, Promise<TurnScope>>()

  // Sequential across reviews: resolveTurnScopeWithArtifactDigests already bounds concurrency *within*
  // one scope, but a Promise.all here would multiply that by the number of reviews and could exhaust
  // file descriptors on a session with a long review history (then fail-open, hiding staleness).
  const flagged: ReviewWithChecks[] = []
  for (const review of reviews) {
    flagged.push(
      await flagOne(
        review,
        currentSession,
        artifactStorageRoot,
        scopeByTurn,
        resolveArtifactVersion,
        stats
      )
    )
  }
  return flagged
}

// The key a recomposition is shared under. Both parts are read from the STORED scope (not from the
// review row's turnMessageId), because that is what the recomposition is resolved against.
const scopeKey = (review: ReviewWithChecks): string =>
  `${review.scope.turnMessageId}\u0000${review.scope.messageBranchId ?? ''}`

// Recomputes one review's scope and returns it with a DEFINITIVE stale flag (true/false) on success.
// A non-complete review has no verdict to invalidate. A completed review that cannot be recomputed is
// explicitly stale: continuing to present its old verdict as current would be a false audit claim.
const flagOne = async (
  review: ReviewWithChecks,
  session: PersistedChatSession,
  artifactStorageRoot: string,
  scopeByTurn: Map<string, Promise<TurnScope>>,
  resolveArtifactVersion?: ArtifactVersionContentResolver,
  stats?: StaleReviewScopeStats
): Promise<ReviewWithChecks> => {
  if (review.lifecycle !== 'complete') return review
  const key = scopeKey(review)
  let current = scopeByTurn.get(key)
  if (current) {
    // A rejected recomposition stays in the map on purpose: the same turn with the same evidence fails
    // the same way, and every review on it must fail closed rather than be presented as current.
    if (stats) stats.scopeReuses += 1
  } else {
    if (stats) stats.scopeComputations += 1
    // Recompute against the turn the stored scope was actually resolved for, not review.turnMessageId:
    // a fix-loop re-review is grouped under the ORIGINAL turn id but its scope belongs to the correction
    // turn, so using review.turnMessageId would resolve a different turn and mark it stale every time.
    current = resolveTurnScopeWithArtifactDigests(
      session,
      review.scope.turnMessageId,
      artifactStorageRoot,
      resolveArtifactVersion,
      review.scope.messageBranchId
    )
    scopeByTurn.set(key, current)
  }
  try {
    const resolved = await current
    return { ...review, stale: isTurnScopeStale(review.scope, resolved) }
  } catch {
    return { ...review, stale: true }
  }
}

export type { StaleReviewScopeStats }
