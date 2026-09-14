import type {
  ReviewEvidenceAttachment,
  ReviewEvidenceAttachRequest,
  ReviewEvidenceAttachResult,
  ReviewEvidenceListResult,
  ReviewEvidenceRequest,
  ReviewEvidenceResponse
} from '../../shared/review-evidence'
import type { SearchEvidenceLine } from '../../shared/search-evidence'
import type { SearchEvidenceService } from '../search/search-evidence'

// Pins a verified search-hit line to a review.
//
// A pin is stored only after the app re-verifies the block against the transcript — the same check the
// palette offers — so a stored pin always describes a block that matched at the moment it was pinned.
// Ownership is read from the review itself: a pin cannot be filed onto another project's or another
// session's review, and the same block cannot be pinned to one review twice by fingerprint.

export type ReviewEvidencePolicy = {
  findReviewById(
    reviewId: string
  ): Promise<{ id: string; projectId: string; sessionId: string } | undefined>
  listReviewEvidence(reviewIds: readonly string[]): Promise<ReviewEvidenceAttachment[]>
  appendReviewEvidence(input: {
    reviewId: string
    projectId: string
    sessionId: string
    messageId: string
    fingerprint: string
    query: string
    terms: readonly string[]
    snippet: string
    capturedAt: Date
  }): Promise<ReviewEvidenceAttachment>
}

export type ReviewEvidenceService = {
  attach(request: ReviewEvidenceAttachRequest): Promise<ReviewEvidenceAttachResult>
  list(reviewIds: readonly string[]): Promise<ReviewEvidenceListResult>
  handle(request: ReviewEvidenceRequest): Promise<ReviewEvidenceResponse>
}

export const createReviewEvidenceService = (deps: {
  reviews: ReviewEvidencePolicy
  searchEvidence: Pick<SearchEvidenceService, 'verify'>
}): ReviewEvidenceService => {
  const attach = async (
    request: ReviewEvidenceAttachRequest
  ): Promise<ReviewEvidenceAttachResult> => {
    const line: SearchEvidenceLine = request.line

    const review = await deps.reviews.findReviewById(request.reviewId)
    if (!review) return { status: 'rejected', reason: 'review-not-found' }
    // The review's own ownership decides, not the caller's claim.
    if (review.projectId !== line.projectId)
      return { status: 'rejected', reason: 'project-mismatch' }
    if (review.sessionId !== line.sessionId) {
      return { status: 'rejected', reason: 'session-mismatch' }
    }

    const verification = await deps.searchEvidence.verify(line)
    if (verification.status !== 'verified') {
      return { status: 'rejected', reason: 'not-verifiable', evidenceReason: verification.reason }
    }

    const existing = await deps.reviews.listReviewEvidence([request.reviewId])
    if (existing.some((pin) => pin.fingerprint === line.fingerprint)) {
      return { status: 'rejected', reason: 'already-attached' }
    }

    const evidence = await deps.reviews.appendReviewEvidence({
      reviewId: request.reviewId,
      projectId: line.projectId,
      sessionId: line.sessionId,
      messageId: line.messageId,
      fingerprint: line.fingerprint,
      query: line.query,
      terms: line.terms,
      snippet: line.snippet,
      capturedAt: new Date(line.capturedAt)
    })

    return { status: 'attached', evidence }
  }

  const list = async (reviewIds: readonly string[]): Promise<ReviewEvidenceListResult> => ({
    attachments: await deps.reviews.listReviewEvidence(reviewIds)
  })

  return {
    attach,
    list,
    handle: async (request) =>
      request.action === 'attach' ? attach(request) : list(request.reviewIds)
  }
}
