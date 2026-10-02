import { describe, expect, it } from 'vitest'

import {
  buildJournalMetricsOverview,
  journalMetricKinds,
  selectLatestClaim,
  type JournalMetricClaim
} from './journal-metrics-overview'

const claim = (
  over: Partial<JournalMetricClaim> & { journalId: string; kind: string }
): JournalMetricClaim => ({
  value: '1',
  numericValue: 1,
  year: 2023,
  source: 'Journal Citation Reports',
  fetchedAt: 1,
  ...over
})

describe('selectLatestClaim', () => {
  it('takes the most recent year, not the most recently inserted row', () => {
    const claims = [
      claim({ journalId: 'j', kind: 'impact-factor', year: 2022, value: '50.5', fetchedAt: 900 }),
      claim({ journalId: 'j', kind: 'impact-factor', year: 2023, value: '64.8', fetchedAt: 10 })
    ]

    expect(selectLatestClaim(claims, 'impact-factor')?.year).toBe(2023)
    expect(selectLatestClaim(claims, 'impact-factor')?.value).toBe('64.8')
  })

  it('breaks a tie between two claims of the same year on fetchedAt, deterministically', () => {
    const claims = [
      claim({ journalId: 'j', kind: 'impact-factor', year: 2023, value: '64.8', fetchedAt: 1_000 }),
      claim({ journalId: 'j', kind: 'impact-factor', year: 2023, value: '70.0', fetchedAt: 2_000 })
    ]

    expect(selectLatestClaim(claims, 'impact-factor')?.value).toBe('70.0')
    // Order of the input must not change the answer.
    expect(selectLatestClaim([...claims].reverse(), 'impact-factor')?.value).toBe('70.0')
  })

  it('accepts a Date, a number and an ISO string for fetchedAt (the same claim crosses the RPC boundary)', () => {
    const claims = [
      claim({
        journalId: 'j',
        kind: 'impact-factor',
        year: 2023,
        value: 'old',
        fetchedAt: '2026-10-02T00:00:00.000Z'
      }),
      claim({
        journalId: 'j',
        kind: 'impact-factor',
        year: 2023,
        value: 'new',
        fetchedAt: new Date('2026-10-03T00:00:00.000Z')
      })
    ]

    expect(selectLatestClaim(claims, 'impact-factor')?.value).toBe('new')
  })

  it('restricts to one year when asked', () => {
    const claims = [
      claim({ journalId: 'j', kind: 'impact-factor', year: 2022, value: '50.5' }),
      claim({ journalId: 'j', kind: 'impact-factor', year: 2023, value: '64.8' })
    ]

    expect(selectLatestClaim(claims, 'impact-factor', 2022)?.value).toBe('50.5')
  })
})

describe('buildJournalMetricsOverview', () => {
  const journals = [
    { id: 'nature', normalizedName: 'nature', issn: '0028-0836' },
    { id: 'nat-comms', normalizedName: 'nature communications', issn: '2041-1723' },
    { id: 'silent', normalizedName: 'journal with no metrics', issn: null }
  ]

  it('shows a missing metric as unknown — never as zero, never as blank', () => {
    const overview = buildJournalMetricsOverview({
      journals: [journals[2]],
      claims: []
    })
    const row = overview.rows[0]

    expect(row.cells['impact-factor']).toEqual({ state: 'unknown' })
    // Every kind the library knows about is a column, so a kind nobody imported cannot vanish.
    expect(overview.kinds).toEqual(
      expect.arrayContaining([
        'impact-factor',
        'jcr-quartile',
        'cas-partition',
        'cas-top',
        'acceptance-rate'
      ])
    )
  })

  it('carries value, year and source together for every number', () => {
    const overview = buildJournalMetricsOverview({
      journals: [journals[0]],
      claims: [
        claim({
          journalId: 'nature',
          kind: 'impact-factor',
          value: '64.8',
          numericValue: 64.8,
          year: 2023,
          source: 'Journal Citation Reports'
        })
      ]
    })

    expect(overview.rows[0].cells['impact-factor']).toEqual({
      state: 'known',
      value: '64.8',
      numericValue: 64.8,
      year: 2023,
      source: 'Journal Citation Reports'
    })
  })

  it('filters by partition and keeps the counts reconcilable', () => {
    const overview = buildJournalMetricsOverview({
      journals,
      claims: [
        claim({ journalId: 'nature', kind: 'cas-partition', value: '一区' }),
        claim({ journalId: 'nat-comms', kind: 'cas-partition', value: '二区' })
      ],
      filter: { partition: '一区' }
    })

    expect(overview.rows.map((row) => row.name)).toEqual(['nature'])
    expect(overview.counts).toEqual({
      total: 3,
      matched: 1,
      missingMetric: 1, // the journal with no claims at all
      valueNotNumeric: 0,
      notMatching: 1 // 二区
    })
    const { total, matched, missingMetric, valueNotNumeric, notMatching } = overview.counts
    expect(matched + missingMetric + valueNotNumeric + notMatching).toBe(total)
  })

  it('never compares a value that is not a number, and says how many it could not judge', () => {
    const overview = buildJournalMetricsOverview({
      journals,
      claims: [
        claim({ journalId: 'nature', kind: 'impact-factor', value: '64.8', numericValue: 64.8 }),
        // The store recorded no numeric mirror for this one, so a numeric filter must not guess a value.
        claim({ journalId: 'nat-comms', kind: 'impact-factor', value: 'n/a', numericValue: null })
      ],
      filter: { minImpactFactor: 10 }
    })

    expect(overview.rows.map((row) => row.name)).toEqual(['nature'])
    expect(overview.counts.valueNotNumeric).toBe(1)
    expect(overview.counts.notMatching).toBe(0)
    expect(overview.counts.missingMetric).toBe(1)
  })

  it('excludes a comparable value that falls outside the bounds as notMatching, not as missing', () => {
    const overview = buildJournalMetricsOverview({
      journals: [journals[1]],
      claims: [
        claim({ journalId: 'nat-comms', kind: 'impact-factor', value: '5.0', numericValue: 5 })
      ],
      filter: { minImpactFactor: 10 }
    })

    expect(overview.rows).toEqual([])
    expect(overview.counts).toEqual({
      total: 1,
      matched: 0,
      missingMetric: 0,
      valueNotNumeric: 0,
      notMatching: 1
    })
  })

  it('a partition filter never drops a journal for lacking an impact factor', () => {
    const overview = buildJournalMetricsOverview({
      journals: [journals[0]],
      claims: [claim({ journalId: 'nature', kind: 'cas-partition', value: '一区' })],
      filter: { partition: '一区' }
    })

    expect(overview.rows.map((row) => row.name)).toEqual(['nature'])
    expect(overview.counts.matched).toBe(1)
  })

  it('lists every kind present in the data beside the known ones', () => {
    expect(
      journalMetricKinds([claim({ journalId: 'j', kind: 'society-ranking', value: 'A*' })])
    ).toEqual(expect.arrayContaining(['society-ranking', 'impact-factor']))
  })
})
