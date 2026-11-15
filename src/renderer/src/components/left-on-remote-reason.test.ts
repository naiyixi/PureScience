import { describe, expect, it } from 'vitest'

import type { ZhKey } from '@/i18n/zh'
import { en } from '@/i18n/en'
import { formatMegabytes, leftOnRemoteReasonLabel } from './left-on-remote-reason'

// The harvest's three reason enums (src/main/compute/harvest-classifier.ts). Kept as a literal list here
// so that adding a fourth reason in the classifier and forgetting its label fails this test rather than
// shipping a raw identifier to the panel.
const HARVEST_REASONS = ['residency_remote', 'exceeds_max_file_mb', 'exceeds_max_total_mb'] as const

// Same interpolation the provider uses, so a sentence carrying `{limit}` is checked as the reader sees
// it rather than as the raw template.
const t = (key: ZhKey, vars?: Record<string, string | number>): string => {
  const text = en[key]
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  )
}

describe('leftOnRemoteReasonLabel', () => {
  it('translates every reason the harvest can write', () => {
    for (const reason of HARVEST_REASONS) {
      const label = leftOnRemoteReasonLabel(reason, t)
      expect(label).not.toBe(reason)
      expect(label.length).toBeGreaterThan(0)
    }
  })

  it('gives the three reasons three different sentences', () => {
    const labels = HARVEST_REASONS.map((reason) => leftOnRemoteReasonLabel(reason, t))
    expect(new Set(labels).size).toBe(HARVEST_REASONS.length)
  })

  it('shows an unknown reason exactly as received instead of inventing an explanation', () => {
    // A reason this build does not know (newer harvest, hand-written payload) must stay checkable
    // against the job's own record — a generic "some reason" would claim to explain it.
    expect(leftOnRemoteReasonLabel('exceeds_size_limit', t)).toBe('exceeds_size_limit')
    expect(leftOnRemoteReasonLabel('', t)).toBe('')
  })

  it('names the limit a file ran into, instead of only saying there was one', () => {
    // "Over the limit" answers nothing a reader can act on: how far over, and what would have to change?
    expect(leftOnRemoteReasonLabel('exceeds_max_file_mb', t, 100)).toBe(
      'Larger than the 100 MB per-file download limit'
    )
    expect(leftOnRemoteReasonLabel('exceeds_max_total_mb', t, 500)).toBe(
      'Would take this job past its 500 MB download total'
    )
  })

  it('keeps the limit-free sentence when the entry recorded no limit', () => {
    // Rows harvested before the threshold was recorded carry no number, and printing the default here
    // would state a limit that was never in force for that job.
    expect(leftOnRemoteReasonLabel('exceeds_max_file_mb', t)).toBe(
      'Larger than the per-file download limit'
    )
    expect(leftOnRemoteReasonLabel('exceeds_max_total_mb', t, Number.NaN)).toBe(
      'Over the download total for this job'
    )
  })

  it('never invents a limit for a reason that has no threshold', () => {
    // residency_remote is a choice, not a limit: a stray number must not turn it into one.
    const label = leftOnRemoteReasonLabel('residency_remote', t, 100)
    expect(label).toBe('Kept on the remote host on purpose')
    expect(label).not.toContain('100')
  })
})

describe('formatMegabytes', () => {
  it('prints the same shape for a size and the limit it is compared against', () => {
    expect(formatMegabytes(1204.4839)).toBe('1204.5')
    expect(formatMegabytes(1204)).toBe('1204')
    expect(formatMegabytes(100)).toBe('100')
    expect(formatMegabytes(0.049)).toBe('0')
  })
})
