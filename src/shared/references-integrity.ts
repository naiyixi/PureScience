// The vocabulary of a stored DOI-integrity verdict, shared by the three surfaces that have to agree on
// it: the main process records it, the preload contract carries it, and the export gate writes it into a
// file. One name list, because a second copy is a second vocabulary that drifts — and the drift here
// would be a `unavailable` check being reported as if it were a clean one.
//
// The three gap reasons ask for three different actions, which is why they are never merged:
//
//   * `never-checked`  — nobody asked Crossref about this DOI; run the check.
//   * `unavailable`    — someone did, and the answer never arrived. NOT the same as clean.
//   * `stale`          — an answer exists but is older than the horizon the reader is entitled to trust.

export const REFERENCE_INTEGRITY_GAP_REASONS = ['never-checked', 'unavailable', 'stale'] as const

export type ReferenceIntegrityGapReason = (typeof REFERENCE_INTEGRITY_GAP_REASONS)[number]

// Which Crossref field produced a verdict. One name list, because the surfacing layer prints it: a stored
// verdict that cannot say which field judged it is a claim nobody can audit, and the four fields do not
// carry the same weight (`relation` is Crossref's own cross-link, `title-label` is the publisher's label).
export const REFERENCE_INTEGRITY_EVIDENCES = [
  'relation',
  'update-to',
  'reverse-update',
  'title-label',
  'none'
] as const

export type ReferenceIntegrityEvidence = (typeof REFERENCE_INTEGRITY_EVIDENCES)[number]

export type ReferenceIntegrityRetraction = {
  referenceId: string
  citationKey: string
  doi: string
  checkedAt: string
  noticeUrls: readonly string[]
  /** The field that decided the verdict; absent on rows written before the four-signal check existed. */
  evidence?: ReferenceIntegrityEvidence
}

export type ReferenceIntegrityGap = {
  referenceId: string
  citationKey: string
  doi: string
  reason: ReferenceIntegrityGapReason
  checkedAt?: string
}

/** What a read of the stored verdicts answers — zero network, so an export never waits on Crossref. */
export type ReferenceIntegritySummary = {
  /** Records inside the project whose stored verdict says retracted. */
  retracted: readonly ReferenceIntegrityRetraction[]
  /** Records whose verdict is unknown, in the three shapes above. */
  gaps: readonly ReferenceIntegrityGap[]
  /** Records that have a stored verdict at all (a subset of `total`). */
  checked: number
  /** Every record in the project that carries a DOI — the denominator, gaps included. */
  total: number
}

/** What the explicit check answers: it egresses, so it reports what it actually reached. */
export type ReferenceIntegrityCheckSummary = {
  checked: number
  unavailable: number
  retracted: number
  gaps: readonly { citationKey: string; doi: string; reason: ReferenceIntegrityGapReason }[]
}
