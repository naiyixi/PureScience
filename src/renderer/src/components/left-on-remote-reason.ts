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

// Two sentences exist for each limit reason: one that names the threshold, one that does not. The
// second is not a fallback for a bug — entries harvested before the threshold was recorded carry no
// `limit_mb`, and printing "100 MB" there would state a limit that was never in force for that job.
const REASON_KEYS_WITH_LIMIT: Record<string, ZhKey> = {
  exceeds_max_file_mb: 'jobDetail.leftOnRemoteReasonFileLimitIs',
  exceeds_max_total_mb: 'jobDetail.leftOnRemoteReasonTotalLimitIs'
}

/**
 * Sizes in this payload are already MB, so they are printed as MB rather than re-derived from bytes:
 * at most one decimal, no trailing ".0". The file's size and the limit it ran into then come out in
 * the same shape, which is the whole point of showing the limit at all.
 */
export const formatMegabytes = (megabytes: number): string => String(Number(megabytes.toFixed(1)))

/**
 * Human-readable label for a `left_on_remote[].reason` value.
 *
 * Known reasons are translated through the dictionary; unknown ones fall through unchanged so a newer
 * harvest (or a hand-written payload) never has its reason silently swallowed. When the entry recorded
 * the threshold it ran into (`limitMb`), the sentence names it: "over the limit" without the number
 * leaves the reader unable to tell how far over — or what to raise.
 */
export const leftOnRemoteReasonLabel = (
  reason: string,
  t: (key: ZhKey, vars?: Record<string, string | number>) => string,
  limitMb?: number
): string => {
  const withLimit = REASON_KEYS_WITH_LIMIT[reason]
  if (withLimit && typeof limitMb === 'number' && Number.isFinite(limitMb)) {
    return t(withLimit, { limit: formatMegabytes(limitMb) })
  }
  const key = REASON_KEYS[reason]
  return key ? t(key) : reason
}
