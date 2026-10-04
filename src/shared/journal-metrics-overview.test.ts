import { describe, expect, it } from 'vitest'

import {
  buildJournalMetricsOverview,
  journalMetricKinds,
  selectClaimWithAlternatives,
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
      source: 'Journal Citation Reports',
      // One claim for that year => nothing hidden. The field is present and empty, never omitted.
      alternatives: []
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

  it('honours the ceiling the same way as the floor, inclusively at the boundary', () => {
    const journalsWithFactors = [
      { id: 'high', normalizedName: 'high', issn: null },
      { id: 'edge', normalizedName: 'edge', issn: null },
      { id: 'low', normalizedName: 'low', issn: null }
    ]
    const overview = buildJournalMetricsOverview({
      journals: journalsWithFactors,
      claims: [
        claim({ journalId: 'high', kind: 'impact-factor', value: '30.0', numericValue: 30 }),
        claim({ journalId: 'edge', kind: 'impact-factor', value: '10.0', numericValue: 10 }),
        claim({ journalId: 'low', kind: 'impact-factor', value: '4.0', numericValue: 4 })
      ],
      filter: { maxImpactFactor: 10 }
    })

    // The bound is inclusive on both sides: a value exactly at the ceiling stays in.
    expect(overview.rows.map((row) => row.name)).toEqual(['edge', 'low'])
    expect(overview.counts).toEqual({
      total: 3,
      matched: 2,
      missingMetric: 0,
      valueNotNumeric: 0,
      notMatching: 1
    })
  })

  it('applies both bounds together, so a range narrows the same way a single bound does', () => {
    const journalsWithFactors = [
      { id: 'too-high', normalizedName: 'too-high', issn: null },
      { id: 'in-range', normalizedName: 'in-range', issn: null },
      { id: 'too-low', normalizedName: 'too-low', issn: null },
      { id: 'not-a-number', normalizedName: 'not-a-number', issn: null }
    ]
    const overview = buildJournalMetricsOverview({
      journals: journalsWithFactors,
      claims: [
        claim({ journalId: 'too-high', kind: 'impact-factor', value: '20', numericValue: 20 }),
        claim({ journalId: 'in-range', kind: 'impact-factor', value: '12', numericValue: 12 }),
        claim({ journalId: 'too-low', kind: 'impact-factor', value: '2', numericValue: 2 }),
        claim({
          journalId: 'not-a-number',
          kind: 'impact-factor',
          value: 'n/a',
          numericValue: null
        })
      ],
      filter: { minImpactFactor: 5, maxImpactFactor: 15 }
    })

    expect(overview.rows.map((row) => row.name)).toEqual(['in-range'])
    // Both ends are "outside the bounds", never "missing": the four buckets still add up to the total.
    expect(overview.counts).toEqual({
      total: 4,
      matched: 1,
      missingMetric: 0,
      valueNotNumeric: 1,
      notMatching: 2
    })
    const { total, matched, missingMetric, valueNotNumeric, notMatching } = overview.counts
    expect(matched + missingMetric + valueNotNumeric + notMatching).toBe(total)
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

describe('display names and aliases (R2-U4)', () => {
  it('shows the spelling the source used, and falls back to the normalized form', () => {
    const overview = buildJournalMetricsOverview({
      claims: [],
      journals: [
        { id: 'a', normalizedName: 'nature', displayName: 'Nature', issn: null },
        { id: 'b', normalizedName: 'nature london', issn: null }
      ]
    })

    expect(overview.rows.map((row) => row.name)).toEqual(['Nature', 'nature london'])
  })

  it('attaches each alias to the journal it resolves to, and an empty list to every other', () => {
    const overview = buildJournalMetricsOverview({
      claims: [],
      journals: [
        { id: 'a', normalizedName: 'nature', displayName: 'Nature', issn: null },
        { id: 'b', normalizedName: 'cell', issn: null }
      ],
      aliases: [
        { normalizedName: 'the lancet', journalId: 'a', createdVia: 'explicit-merge' },
        { normalizedName: 'nature london', journalId: 'a', createdVia: 'explicit-merge' }
      ]
    })

    const aliasesById = Object.fromEntries(overview.rows.map((row) => [row.journalId, row.aliases]))
    // Sorted, so two snapshots of one library cannot disagree about the order of the same names.
    expect(aliasesById.a).toEqual(['nature london', 'the lancet'])
    expect(aliasesById.b).toEqual([])
  })
})

// R2-U4 follow-up (V11/IC1): a merge can leave TWO claims for the same kind in the same year. The screen used
// to print whichever had the newer `fetchedAt` and say nothing, so the reader could not know the year held a
// second value from a second source. Selection is unchanged; the losers now travel with the cell.
describe('same year, more than one claim (never silently one)', () => {
  const contestedClaims = [
    claim({
      journalId: 'nature',
      kind: 'impact-factor',
      value: '64.8',
      numericValue: 64.8,
      year: 2023,
      source: 'Journal Citation Reports',
      fetchedAt: 900
    }),
    claim({
      journalId: 'nature',
      kind: 'impact-factor',
      value: '16.6',
      numericValue: 16.6,
      year: 2023,
      source: '期刊指标库',
      fetchedAt: 10
    })
  ]

  it('hands both claims to the cell, each keeping its own source', () => {
    const overview = buildJournalMetricsOverview({
      journals: [{ id: 'nature', normalizedName: 'nature', issn: null }],
      claims: contestedClaims
    })
    const cell = overview.rows[0].cells['impact-factor']

    expect(cell.state).toBe('known')
    if (cell.state !== 'known') throw new Error('unreachable')
    // The deterministic pick is still the newest `fetchedAt`...
    expect(cell.value).toBe('64.8')
    expect(cell.source).toBe('Journal Citation Reports')
    // ...and the one it would have hidden is right there, with its own source and its own number.
    expect(cell.alternatives).toEqual([{ value: '16.6', numericValue: 16.6, source: '期刊指标库' }])
  })

  it('does not call a re-import a conflict: same value + same source is one fact', () => {
    const overview = buildJournalMetricsOverview({
      journals: [{ id: 'nature', normalizedName: 'nature', issn: null }],
      claims: [
        claim({
          journalId: 'nature',
          kind: 'impact-factor',
          value: '64.8',
          year: 2023,
          fetchedAt: 900
        }),
        claim({
          journalId: 'nature',
          kind: 'impact-factor',
          value: '64.8',
          year: 2023,
          fetchedAt: 100
        }),
        claim({
          journalId: 'nature',
          kind: 'impact-factor',
          value: '64.8',
          year: 2023,
          fetchedAt: 5
        })
      ]
    })
    const cell = overview.rows[0].cells['impact-factor']

    if (cell.state !== 'known') throw new Error('unreachable')
    expect(cell.alternatives).toEqual([])
  })

  it('keeps claims from OTHER years out of the conflict list', () => {
    const { claim: selected, alternatives } = selectClaimWithAlternatives(
      [
        ...contestedClaims,
        claim({
          journalId: 'nature',
          kind: 'impact-factor',
          value: '50.5',
          numericValue: 50.5,
          year: 2022,
          source: 'Journal Citation Reports',
          fetchedAt: 999
        })
      ],
      'impact-factor'
    )

    expect(selected?.year).toBe(2023)
    // 2022 is a different year's fact, not a competitor for 2023 — it must not be listed here.
    expect(alternatives.map((entry) => entry.value)).toEqual(['16.6'])
  })

  it('orders alternates deterministically, so one library cannot render two ways', () => {
    const { alternatives } = selectClaimWithAlternatives(
      [
        claim({
          journalId: 'j',
          kind: 'impact-factor',
          value: '64.8',
          numericValue: 64.8,
          year: 2023,
          source: 'z-source',
          fetchedAt: 900
        }),
        claim({
          journalId: 'j',
          kind: 'impact-factor',
          value: '16.6',
          numericValue: 16.6,
          year: 2023,
          source: 'b-source',
          fetchedAt: 10
        }),
        claim({
          journalId: 'j',
          kind: 'impact-factor',
          value: '16.6',
          numericValue: 16.6,
          year: 2023,
          source: 'b-source',
          fetchedAt: 11
        })
      ],
      'impact-factor'
    )

    // Sorted by source then value, and the duplicate (same value + same source) appears once.
    expect(alternatives).toEqual([{ value: '16.6', numericValue: 16.6, source: 'b-source' }])
  })

  it('still reports unknown (not a conflict) when the year holds nothing', () => {
    expect(selectClaimWithAlternatives([], 'impact-factor')).toEqual({
      claim: null,
      alternatives: []
    })
  })
})
