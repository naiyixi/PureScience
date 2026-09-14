import { useCallback, useState } from 'react'

import type { TranslationKey } from '@/i18n/languages'

import type { GlobalSearchHit } from '../../../../shared/global-search'
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
  capture: (hit: GlobalSearchHit, query: string) => Promise<void>
  verify: (line: SearchEvidenceLine) => Promise<void>
  reset: () => void
}

export const useSearchEvidence = (t: (key: TranslationKey) => string): SearchEvidenceController => {
  const [status, setStatus] = useState<SearchEvidenceStatus>({ state: 'idle' })

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

  const reset = useCallback((): void => setStatus({ state: 'idle' }), [])

  return { status, capture, verify, reset }
}
