// Evidence a person pinned to a review.
//
// Deliberately separate from `ReviewCheck.evidence`, which is what the reviewer model itself claimed.
// A reader of an audit trail must be able to tell a model's assertion from a human's pinned block, and
// the pin has to carry the means to check it: the fingerprint is computed by the app from the stored
// block under the published `SEARCH_EVIDENCE_HASH_RECIPE`, and attaching re-verifies it first, so a pin
// always describes a block that matched at the moment it was pinned.

import type { SearchEvidenceLine, SearchEvidenceReason } from './search-evidence'

export const REVIEW_EVIDENCE_SCHEMA_VERSION = 1

export type ReviewEvidenceAttachment = {
  schemaVersion: typeof REVIEW_EVIDENCE_SCHEMA_VERSION
  id: string
  reviewId: string
  projectId: string
  sessionId: string
  messageId: string
  fingerprint: string
  query: string
  terms: string[]
  snippet: string
  capturedAt: string
}

export type ReviewEvidenceAttachRequest = {
  action: 'attach'
  reviewId: string
  // The captured line itself: it already carries the project, session, message, fingerprint and the
  // query that found the block — so a pin cannot claim one thing and store another.
  line: SearchEvidenceLine
}

export type ReviewEvidenceListRequest = {
  action: 'list'
  reviewIds: readonly string[]
}

export type ReviewEvidenceRequest = ReviewEvidenceAttachRequest | ReviewEvidenceListRequest

// Named refusals: an attach either happens or says exactly why it did not.
export type ReviewEvidenceRejectionReason =
  // No such review in this database.
  | 'review-not-found'
  // The review belongs to a different project than the pin claims.
  | 'project-mismatch'
  // The review is about another session than the block being pinned.
  | 'session-mismatch'
  // The same block, by fingerprint, is already pinned to this review.
  | 'already-attached'
  // The block does not currently hash to the fingerprint being pinned (reason carries why: edited,
  // missing, truncated, unreadable).
  | 'not-verifiable'

export type ReviewEvidenceAttachResult =
  | { status: 'attached'; evidence: ReviewEvidenceAttachment }
  | {
      status: 'rejected'
      reason: ReviewEvidenceRejectionReason
      // Present for `not-verifiable`: the search-evidence reason behind the refusal.
      evidenceReason?: SearchEvidenceReason
    }

export type ReviewEvidenceListResult = {
  attachments: ReviewEvidenceAttachment[]
}

export type ReviewEvidenceResponse = ReviewEvidenceAttachResult | ReviewEvidenceListResult

// Rendered wherever a pin is shown next to model-written checks, so the two voices are never merged.
export const REVIEW_EVIDENCE_KIND = 'human-pinned' as const
