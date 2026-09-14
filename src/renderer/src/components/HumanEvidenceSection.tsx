// Human-pinned evidence for a review.
//
// The checks above this section are what the reviewer model claimed. These rows are what a person
// pinned, each carrying the fingerprint of the block as it was stored when it was pinned — so a reader
// can tell the two apart and recheck the second kind. Kept as its own section for exactly that reason.

import { useCallback, useEffect, useState } from 'react'
import { Fingerprint } from 'lucide-react'
import { useLanguage } from '@/i18n'
import { Button } from '@/components/ui/button'

import type { ReviewEvidenceAttachment } from '../../../shared/review-evidence'
import type { SearchEvidenceReason } from '../../../shared/search-evidence'

type HumanEvidenceSectionProps = {
  reviewId: string
}

type VerificationState =
  | { state: 'idle' }
  | { state: 'verifying' }
  | { state: 'verified' }
  | { state: 'unavailable'; reason: SearchEvidenceReason }

export const HumanEvidenceSection = ({
  reviewId
}: HumanEvidenceSectionProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [attachments, setAttachments] = useState<ReviewEvidenceAttachment[] | undefined>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [verification, setVerification] = useState<Record<string, VerificationState>>({})

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      try {
        const response = await window.api.reviewer.evidence({
          action: 'list',
          reviewIds: [reviewId]
        })
        if (cancelled) return
        setAttachments('attachments' in response ? response.attachments : [])
      } catch {
        // A list that could not be read must not render as "nothing is pinned".
        if (!cancelled) setLoadFailed(true)
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [reviewId])

  const verify = useCallback(async (attachment: ReviewEvidenceAttachment): Promise<void> => {
    setVerification((current) => ({ ...current, [attachment.id]: { state: 'verifying' } }))

    try {
      const response = await window.api.search.evidence({
        action: 'verify',
        line: {
          schemaVersion: attachment.schemaVersion,
          projectId: attachment.projectId,
          sessionId: attachment.sessionId,
          messageId: attachment.messageId,
          role: attachment.role,
          capturedAt: attachment.capturedAt,
          query: attachment.query,
          terms: attachment.terms,
          snippet: attachment.snippet,
          fingerprint: attachment.fingerprint
        }
      })

      setVerification((current) => ({
        ...current,
        [attachment.id]:
          response.status === 'verified'
            ? { state: 'verified' }
            : { state: 'unavailable', reason: response.reason }
      }))
    } catch {
      setVerification((current) => ({
        ...current,
        [attachment.id]: { state: 'unavailable', reason: 'session-unavailable' }
      }))
    }
  }, [])

  const verificationLabel = (status: VerificationState): string | undefined => {
    if (status.state === 'verified') return t('reviewer.evidenceVerified')
    if (status.state === 'unavailable') {
      return status.reason === 'fingerprint-mismatch'
        ? t('reviewer.evidenceChanged')
        : t('reviewer.evidenceMissing')
    }

    return undefined
  }

  if (loadFailed) {
    // Say the list could not be read rather than showing an empty section that reads as "none".
    return <p className="mt-2 text-[11px] text-text-400">{t('reviewer.evidenceUnreadable')}</p>
  }

  if (!attachments) return <></>

  return (
    <div
      className="mt-2 rounded-md border border-border-300/40 p-2"
      data-testid="review-human-evidence"
    >
      <div className="flex items-center gap-1 text-[11px] font-medium text-text-300">
        <Fingerprint className="size-3" />
        {t('reviewer.humanEvidence')}
      </div>

      {attachments.length === 0 ? (
        <p className="mt-1 text-[11px] text-text-400">{t('reviewer.evidenceEmpty')}</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {attachments.map((attachment) => {
            const status = verification[attachment.id] ?? { state: 'idle' as const }
            const label = verificationLabel(status)

            return (
              <li
                key={attachment.id}
                className="text-[11px] text-text-300"
                data-testid="review-human-evidence-row"
              >
                <span className="block truncate">{attachment.snippet}</span>
                <span className="block truncate text-text-400">
                  {t('reviewer.evidenceQuery')}: {attachment.query}
                  {attachment.terms.length > 0 ? ` (${attachment.terms.join(', ')})` : ''}
                </span>
                <span className="block truncate font-mono text-[10px] text-text-400">
                  {attachment.fingerprint}
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    disabled={status.state === 'verifying'}
                    data-testid="review-human-evidence-verify"
                    onClick={() => void verify(attachment)}
                  >
                    {t('reviewer.evidenceVerify')}
                  </Button>
                  {label ? (
                    <span data-testid="review-human-evidence-status" className="text-text-400">
                      {label}
                    </span>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
