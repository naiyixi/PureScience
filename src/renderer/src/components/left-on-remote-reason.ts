import type { ZhKey } from '@/i18n/zh'

// The harvest records WHY a file stayed on the remote host as a machine enum — 'residency_remote',
// 'exceeds_max_file_mb', 'exceeds_max_total_mb' (src/main/compute/harvest-classifier.ts). The payload keeps
// those identifiers verbatim on purpose: they are what an agent chains against and what the evidence
// documents quote. Putting them in front of a reader unchanged, though, hands a scientist a code
// identifier where a sentence belongs.
//
// A reason this build does not know is shown exactly as received rather than replaced by a generic
// phrase: "some reason" would claim to explain something it does not, while the raw value at least stays
// checkable against the job's own record.
const REASON_KEYS: Record<string, ZhKey> = {
  residency_remote: 'jobDetail.leftOnRemoteReasonResidency',
  exceeds_max_file_mb: 'jobDetail.leftOnRemoteReasonFileLimit',
  exceeds_max_total_mb: 'jobDetail.leftOnRemoteReasonTotalLimit'
}

/**
 * Human-readable label for a `left_on_remote[].reason` value.
 *
 * Known reasons are translated through the dictionary; unknown ones fall through unchanged so a newer
 * harvest (or a hand-written payload) never has its reason silently swallowed.
 */
export const leftOnRemoteReasonLabel = (
  reason: string,
  t: (key: ZhKey, vars?: Record<string, string | number>) => string
): string => {
  const key = REASON_KEYS[reason]
  return key ? t(key) : reason
}
