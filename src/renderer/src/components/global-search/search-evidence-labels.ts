import type { TranslationKey } from '@/i18n/languages'

import type { SearchEvidenceReason, SearchEvidenceLabels } from '../../../../shared/search-evidence'
import { splitSearchTerms } from '../../../../shared/global-search'

// The label a reason renders as. Every reason says what happened — "unavailable" alone would leave the
// user unable to tell a missing block from an edited one.
export const EVIDENCE_REASON_LABEL_KEYS = {
  'message-not-found': 'gs.evidenceMissing',
  'fingerprint-mismatch': 'gs.evidenceChanged',
  'text-truncated': 'gs.evidenceTruncated',
  'session-unavailable': 'gs.evidenceUnreadable'
} as const satisfies Record<SearchEvidenceReason, TranslationKey>

export const evidenceReasonLabelKey = (reason: SearchEvidenceReason): TranslationKey =>
  EVIDENCE_REASON_LABEL_KEYS[reason]

// Terms are the same split the search itself used, so the line records how the block was actually found.
export const evidenceTermsForQuery = (query: string): string[] => splitSearchTerms(query)

export const evidenceLabels = (t: (key: TranslationKey) => string): SearchEvidenceLabels => ({
  header: t('gs.evidenceHeader'),
  query: t('gs.evidenceQuery'),
  terms: t('gs.evidenceTerms'),
  snippet: t('gs.evidenceSnippet'),
  fingerprint: t('gs.evidenceFingerprint')
})
