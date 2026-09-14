import { describe, expect, it, vi } from 'vitest'

import type { ReviewEvidenceAttachment } from '../../shared/review-evidence'
import type { SearchEvidenceLine } from '../../shared/search-evidence'
import type { SearchEvidenceService } from '../search/search-evidence'
import { createReviewEvidenceService, type ReviewEvidencePolicy } from './review-evidence-service'

const line: SearchEvidenceLine = {
  schemaVersion: 1,
  projectId: 'project-a',
  sessionId: 'session-a',
  messageId: 'message-2',
  role: 'agent',
  capturedAt: '2026-09-14T10:00:00.000Z',
  query: 'sin csv',
  terms: ['sin', 'csv'],
  snippet: 'wrote sin(x) values',
  fingerprint: `sha256:${'a'.repeat(64)}`
}

const attachment: ReviewEvidenceAttachment = {
  schemaVersion: 1,
  id: 'pin-1',
  reviewId: 'review-1',
  projectId: 'project-a',
  sessionId: 'session-a',
  messageId: 'message-2',
  role: 'agent',
  fingerprint: line.fingerprint,
  query: 'sin csv',
  terms: ['sin', 'csv'],
  snippet: 'wrote sin(x) values',
  capturedAt: '2026-09-14T10:00:00.000Z'
}

const harness = (
  overrides: {
    // `null` means "no such review"; omitting the field means the default review.
    review?: { id: string; projectId: string; sessionId: string } | null
    verify?: Awaited<ReturnType<SearchEvidenceService['verify']>>
    existing?: ReviewEvidenceAttachment[]
  } = {}
): {
  service: ReturnType<typeof createReviewEvidenceService>
  reviews: ReviewEvidencePolicy
  searchEvidence: { verify: ReturnType<typeof vi.fn> }
} => {
  const reviewRow =
    overrides.review === undefined
      ? { id: 'review-1', projectId: 'project-a', sessionId: 'session-a' }
      : overrides.review
  const reviews: ReviewEvidencePolicy = {
    findReviewById: vi.fn(async () => reviewRow ?? undefined),
    listReviewEvidence: vi.fn(async () => overrides.existing ?? []),
    appendReviewEvidence: vi.fn(async () => attachment)
  }
  const searchEvidence = {
    verify: vi.fn(
      async () => overrides.verify ?? { status: 'verified' as const, fingerprint: line.fingerprint }
    )
  }

  return {
    service: createReviewEvidenceService({ reviews, searchEvidence }),
    reviews,
    searchEvidence
  }
}

describe('review evidence attach', () => {
  it('verifies the block before pinning it, and stores what the line says', async () => {
    const { service, reviews, searchEvidence } = harness()

    const result = await service.attach({ action: 'attach', reviewId: 'review-1', line })

    expect(searchEvidence.verify).toHaveBeenCalledWith(line)
    expect(result).toEqual({ status: 'attached', evidence: attachment })
    expect(reviews.appendReviewEvidence).toHaveBeenCalledWith({
      reviewId: 'review-1',
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'message-2',
      role: 'agent',
      fingerprint: line.fingerprint,
      query: 'sin csv',
      terms: ['sin', 'csv'],
      snippet: 'wrote sin(x) values',
      capturedAt: new Date('2026-09-14T10:00:00.000Z')
    })
  })

  it('refuses a review that does not exist', async () => {
    const { service } = harness({ review: null })

    await expect(service.attach({ action: 'attach', reviewId: 'review-1', line })).resolves.toEqual(
      {
        status: 'rejected',
        reason: 'review-not-found'
      }
    )
  })

  it('refuses to file a pin onto another project or another session', async () => {
    const otherProject = harness({
      review: { id: 'review-1', projectId: 'project-b', sessionId: 'session-a' }
    })
    await expect(
      otherProject.service.attach({ action: 'attach', reviewId: 'review-1', line })
    ).resolves.toEqual({ status: 'rejected', reason: 'project-mismatch' })

    const otherSession = harness({
      review: { id: 'review-1', projectId: 'project-a', sessionId: 'session-b' }
    })
    await expect(
      otherSession.service.attach({ action: 'attach', reviewId: 'review-1', line })
    ).resolves.toEqual({ status: 'rejected', reason: 'session-mismatch' })
  })

  it('refuses a line whose block no longer verifies, carrying the reason', async () => {
    const { service, reviews } = harness({
      verify: { status: 'unavailable', reason: 'fingerprint-mismatch' }
    })

    await expect(service.attach({ action: 'attach', reviewId: 'review-1', line })).resolves.toEqual(
      {
        status: 'rejected',
        reason: 'not-verifiable',
        evidenceReason: 'fingerprint-mismatch'
      }
    )
    // Nothing is stored when the pin cannot be verified.
    expect(reviews.appendReviewEvidence).not.toHaveBeenCalled()
  })

  it('refuses to pin the same block twice', async () => {
    const { service, reviews } = harness({ existing: [attachment] })

    await expect(service.attach({ action: 'attach', reviewId: 'review-1', line })).resolves.toEqual(
      {
        status: 'rejected',
        reason: 'already-attached'
      }
    )
    expect(reviews.appendReviewEvidence).not.toHaveBeenCalled()
  })
})

describe('review evidence listing', () => {
  it('lists what is pinned to the given reviews, and routes by action', async () => {
    const { service, reviews } = harness({ existing: [attachment] })

    await expect(service.handle({ action: 'list', reviewIds: ['review-1'] })).resolves.toEqual({
      attachments: [attachment]
    })
    expect(reviews.listReviewEvidence).toHaveBeenCalledWith(['review-1'])
  })

  it('asks for nothing when no reviews are named', async () => {
    const { service, reviews } = harness()

    await expect(service.list([])).resolves.toEqual({ attachments: [] })
    expect(reviews.listReviewEvidence).toHaveBeenCalledWith([])
  })
})
