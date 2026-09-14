import { useCallback, useRef, useState } from 'react'

import type { TranslationKey } from '@/i18n/languages'

import type { GlobalSearchHit } from '../../../../shared/global-search'
import type { ReviewEvidenceRejectionReason } from '../../../../shared/review-evidence'
import {
  formatSearchEvidenceLine,
  type SearchEvidenceLine,
  type SearchEvidenceReason
} from '../../../../shared/search-evidence'

import { evidenceLabels, evidenceTermsForQuery } from './search-evidence-labels'

// Turns a search hit into a line someone else can check, then rechecks it on demand.
//
// Copying is the point: the line only leaves the app through the clipboard, and it is produced by the
// main process from the stored block, so what is copied is never the palette's own copy of the text.

export type SearchEvidenceStatus =
  | { state: 'idle' }
  | { state: 'busy'; hitKey: string }
  | { state: 'captured'; hitKey: string; line: SearchEvidenceLine }
  | { state: 'verified'; hitKey: string }
  | { state: 'unavailable'; hitKey: string; reason: SearchEvidenceReason }

export type SearchEvidenceController = {
  status: SearchEvidenceStatus
  pinStatus: ReviewPinStatus
  capture: (hit: GlobalSearchHit, query: string) => Promise<void>
  verify: (line: SearchEvidenceLine) => Promise<void>
  beginPin: (line: SearchEvidenceLine) => Promise<void>
  pin: (reviewId: string) => Promise<void>
  reset: () => void
}

// Pinning a captured line to a review. Kept apart from the capture/verify status above: copying a line
// and filing it into an audit trail are different acts, and a failure in one must not read as a state
// of the other.
export type ReviewPinStatus =
  | { state: 'idle' }
  | { state: 'loading'; line: SearchEvidenceLine }
  | { state: 'no-reviews'; line: SearchEvidenceLine }
  | {
      state: 'choosing'
      line: SearchEvidenceLine
      reviews: readonly { id: string; createdAt: number; turnMessageId: string }[]
    }
  | { state: 'pinned'; reviewId: string; messageId: string }
  | { state: 'rejected'; reason: ReviewEvidenceRejectionReason; messageId: string }
  | { state: 'failed'; messageId: string }

export const useSearchEvidence = (t: (key: TranslationKey) => string): SearchEvidenceController => {
  const [status, setStatus] = useState<SearchEvidenceStatus>({ state: 'idle' })
  const [pinStatus, setPinStatus] = useState<ReviewPinStatus>({ state: 'idle' })
  // The line awaiting a review choice. Held in a ref so `pin` never has to re-derive it.
  const pinLineRef = useRef<SearchEvidenceLine | undefined>(undefined)

  const capture = useCallback(
    async (hit: GlobalSearchHit, query: string): Promise<void> => {
      // Only a message hit is a block that can be fingerprinted; files and references have their own
      // fingerprints, so the action is not offered for them at all.
      if (hit.scope !== 'messages' || !hit.sessionId) return

      const hitKey = `${hit.scope}:${hit.id}`
      setStatus({ state: 'busy', hitKey })
      const response = await window.api.search.evidence({
        action: 'capture',
        projectId: hit.projectId,
        sessionId: hit.sessionId,
        messageId: hit.id,
        query,
        terms: evidenceTermsForQuery(query),
        ...(hit.matches[0] ? { snippet: hit.matches[0].snippet } : {})
      })

      if (response.status !== 'captured') {
        setStatus({ state: 'unavailable', hitKey, reason: response.reason })
        return
      }

      await navigator.clipboard?.writeText(
        formatSearchEvidenceLine(response.line, evidenceLabels(t))
      )
      setStatus({ state: 'captured', hitKey, line: response.line })
    },
    [t]
  )

  const verify = useCallback(async (line: SearchEvidenceLine): Promise<void> => {
    const hitKey = `messages:${line.messageId}`
    setStatus({ state: 'busy', hitKey })
    const response = await window.api.search.evidence({ action: 'verify', line })

    setStatus(
      response.status === 'verified'
        ? { state: 'verified', hitKey }
        : { state: 'unavailable', hitKey, reason: response.reason }
    )
  }, [])

  const attachToReview = useCallback(
    async (reviewId: string, line: SearchEvidenceLine): Promise<void> => {
      try {
        const response = await window.api.reviewer.evidence({ action: 'attach', reviewId, line })

        if ('status' in response) {
          if (response.status === 'attached') {
            setPinStatus({ state: 'pinned', reviewId, messageId: line.messageId })
            return
          }
          if (response.status === 'rejected') {
            setPinStatus({
              state: 'rejected',
              reason: response.reason,
              messageId: line.messageId
            })
            return
          }
        }

        setPinStatus({ state: 'failed', messageId: line.messageId })
      } catch {
        setPinStatus({ state: 'failed', messageId: line.messageId })
      }
    },
    []
  )

  // Files the line into a review of the block's own session. The reviews are read from that session,
  // never from a caller-supplied id, so a pin cannot be aimed at an unrelated review.
  const beginPin = useCallback(
    async (line: SearchEvidenceLine): Promise<void> => {
      pinLineRef.current = line
      setPinStatus({ state: 'loading', line })
      try {
        const reviews = await window.api.reviewer.getForSession({
          projectId: line.projectId,
          appSessionId: line.sessionId
        })

        if (reviews.length === 0) {
          setPinStatus({ state: 'no-reviews', line })
          return
        }

        const [only] = reviews
        if (reviews.length === 1 && only) {
          await attachToReview(only.id, line)
          return
        }

        setPinStatus({
          state: 'choosing',
          line,
          reviews: reviews.map((review) => ({
            id: review.id,
            createdAt: review.createdAt,
            turnMessageId: review.turnMessageId
          }))
        })
      } catch {
        setPinStatus({ state: 'failed', messageId: line.messageId })
      }
    },
    [attachToReview]
  )

  const pin = useCallback(
    async (reviewId: string): Promise<void> => {
      const line = pinLineRef.current
      if (!line) return

      await attachToReview(reviewId, line)
    },
    [attachToReview]
  )

  const reset = useCallback((): void => {
    setStatus({ state: 'idle' })
    setPinStatus({ state: 'idle' })
  }, [])

  return { status, pinStatus, capture, verify, beginPin, pin, reset }
}
