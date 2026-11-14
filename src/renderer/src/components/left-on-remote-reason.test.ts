import { describe, expect, it } from 'vitest'

import type { ZhKey } from '@/i18n/zh'
import { en } from '@/i18n/en'
import { leftOnRemoteReasonLabel } from './left-on-remote-reason'

// The harvest's three reason enums (src/main/compute/harvest-classifier.ts). Kept as a literal list here
// so that adding a fourth reason in the classifier and forgetting its label fails this test rather than
// shipping a raw identifier to the panel.
const HARVEST_REASONS = ['residency_remote', 'exceeds_max_file_mb', 'exceeds_max_total_mb'] as const

const t = (key: ZhKey): string => en[key]

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
})
