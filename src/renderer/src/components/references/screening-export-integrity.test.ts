// The export gate's pure half (B1). These are the three things a file must never get wrong, and each is
// cheaper to pin here than through a rendered panel: which verdicts belong to the range, which records
// hold the export back, and the fact that an unknown class is reported rather than dropped.

import { describe, expect, it } from 'vitest'

import type { ReferenceIntegritySummary } from '../../../../shared/references-integrity'
import {
  buildScreeningExportIntegrityBlock,
  type ScreeningExportIntegrityLabels
} from './screening-export-integrity'

const labels: ScreeningExportIntegrityLabels = {
  header: 'Citation integrity',
  scope: 'stored verdicts only',
  counts: ({ checked, total, gaps }) => `${checked} of ${total} checked · gaps ${gaps}`,
  none: 'No gaps.',
  gapHeader: 'Verdicts still unknown',
  gapLine: ({ citationKey, doi, reasonLabel }) => `${citationKey} (${doi}) — ${reasonLabel}`,
  reasonLabels: {
    'never-checked': 'never checked',
    unavailable: 'the check could not reach the registry',
    stale: 'the check is old enough to need repeating'
  }
}

const summary = (
  overrides: Partial<ReferenceIntegritySummary> = {}
): ReferenceIntegritySummary => ({
  retracted: [],
  gaps: [],
  checked: 0,
  total: 0,
  ...overrides
})

describe('buildScreeningExportIntegrityBlock', () => {
  it('reports only the verdicts that belong to the range, in the range’s own order', () => {
    const result = buildScreeningExportIntegrityBlock({
      summary: summary({
        retracted: [
          {
            referenceId: 'ref-b',
            citationKey: 'key-b',
            doi: '10.1000/b',
            checkedAt: '2026-10-01T00:00:00.000Z',
            noticeUrls: []
          }
        ],
        gaps: [
          // Out of range: the file says nothing about a record it does not name.
          {
            referenceId: 'ref-outside',
            citationKey: 'key-outside',
            doi: '10.1000/z',
            reason: 'never-checked'
          },
          { referenceId: 'ref-a', citationKey: 'key-a', doi: '10.1000/a', reason: 'unavailable' },
          { referenceId: 'ref-b', citationKey: 'key-b', doi: '10.1000/b', reason: 'stale' }
        ],
        checked: 2,
        total: 3
      }),
      includedReferenceIds: ['ref-a', 'ref-b'],
      labels
    })

    expect(result.held.map((entry) => entry.referenceId)).toEqual(['ref-b'])
    expect(result.block).toContain('2 of 3 checked · gaps 2')
    expect(result.block).toContain('Verdicts still unknown: 2')
    // Range order, not summary order.
    const first = result.block.indexOf('key-a (10.1000/a)')
    const second = result.block.indexOf('key-b (10.1000/b)')
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
    expect(result.block).not.toContain('key-outside')
  })

  it('writes a no-gaps line instead of staying silent, so a clean file is distinguishable from an unchecked one', () => {
    const result = buildScreeningExportIntegrityBlock({
      summary: summary({ checked: 4, total: 4 }),
      includedReferenceIds: ['ref-a'],
      labels
    })

    expect(result.held).toEqual([])
    expect(result.block).toContain('4 of 4 checked · gaps 0')
    expect(result.block).toContain('No gaps.')
    expect(result.block).not.toContain('Verdicts still unknown')
  })

  it('reports an unrecognised reason under the least-assuming label rather than dropping the record', () => {
    const result = buildScreeningExportIntegrityBlock({
      summary: summary({
        gaps: [
          {
            referenceId: 'ref-a',
            citationKey: 'key-a',
            doi: '10.1000/a',
            // A verdict written by a future build: it is still not a clean one.
            reason: 'verdict-from-a-newer-build' as never
          }
        ],
        checked: 1,
        total: 1
      }),
      includedReferenceIds: ['ref-a'],
      labels
    })

    expect(result.block).toContain('key-a (10.1000/a) — never checked')
    expect(result.block).toContain('gaps 1')
  })
})
