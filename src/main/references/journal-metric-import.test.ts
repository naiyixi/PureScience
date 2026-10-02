import { describe, expect, it, vi } from 'vitest'

import {
  createJournalMetricImportOwner,
  type JournalMetricImportOwner
} from './journal-metric-import'
import { JournalRepository, type JournalClient } from './journal-repository'
import type { JournalMetricImportRow } from '../../shared/journal-metrics'

// The import path is tested against the REAL JournalRepository over a stub engine client, not against a
// hand-written fake of the repository: what the report says about a row depends on what the repository
// decides (identifier identity, exact-name reuse, ambiguity), and a fake of those decisions would let the two
// drift while the test stayed green.

type JournalRow = {
  id: string
  normalizedName: string
  issn: string | null
  issnL: string | null
  eissn: string | null
  publisher: string | null
  homepage: string | null
  createdVia: string
}

type MetricRow = {
  id: string
  journalId: string
  kind: string
  value: string
  year: number
  source: string
  note?: string | null
}

type Stub = {
  journals: JournalRow[]
  metrics: MetricRow[]
  failAppend: { current: boolean }
}

const stub = (): { stub: Stub; client: JournalClient } => {
  const journals: JournalRow[] = []
  const metrics: MetricRow[] = []
  const failAppend = { current: false }
  let next = 1
  const client = {
    journal: {
      findUnique: vi.fn(
        async ({ where }: { where: { issn: string } }) =>
          journals.find((entry) => entry.issn === where.issn) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: { normalizedName: string } }) =>
        journals.filter((entry) => entry.normalizedName === where.normalizedName)
      ),
      create: vi.fn(async ({ data }: { data: Omit<JournalRow, 'id'> }) => {
        const created = { id: `j${next++}`, ...data }
        journals.push(created)
        return created
      })
    },
    journalMetric: {
      create: vi.fn(async ({ data }: { data: Omit<MetricRow, 'id'> }) => {
        if (failAppend.current) throw new Error('database is locked')
        const created = { id: `m${next++}`, ...data }
        metrics.push(created)
        return { id: created.id }
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Omit<MetricRow, 'id' | 'note'> }) =>
          metrics.find(
            (entry) =>
              entry.journalId === where.journalId &&
              entry.kind === where.kind &&
              entry.value === where.value &&
              entry.year === where.year &&
              entry.source === where.source
          ) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: { journalId: string } }) =>
        metrics.filter((entry) => entry.journalId === where.journalId)
      )
    }
  }

  return { stub: { journals, metrics, failAppend }, client: client as unknown as JournalClient }
}

const build = (): { engine: Stub; importMetrics: JournalMetricImportOwner['importMetrics'] } => {
  const created = stub()
  const repository = new JournalRepository({ getClient: async () => created.client })
  const owner = createJournalMetricImportOwner({ journals: repository })

  return { engine: created.stub, importMetrics: owner.importMetrics }
}

const row = (over: Partial<JournalMetricImportRow> = {}): JournalMetricImportRow => ({
  kind: 'impact-factor',
  value: '48.5',
  year: 2024,
  source: 'JCR 2024',
  ...over
})

const journalRow = (over: Partial<JournalRow>): JournalRow => ({
  id: 'j-x',
  normalizedName: 'the lancet',
  issn: null,
  issnL: null,
  eissn: null,
  publisher: null,
  homepage: null,
  createdVia: 'by-issn',
  ...over
})

describe('importMetrics', () => {
  it('attaches each row to a journal, registering the journal only once', async () => {
    const { engine, importMetrics } = build()

    const result = await importMetrics({
      rows: [
        { ...row(), journalName: 'Nature', issn: '0028-0836' },
        { ...row({ year: 2023, value: '45.5' }), journalName: 'Nature', issn: '0028-0836' },
        { ...row(), journalName: 'Cell' }
      ]
    })

    expect({
      imported: result.imported,
      skipped: result.skipped,
      journalsCreated: result.journalsCreated
    }).toEqual({ imported: 3, skipped: 0, journalsCreated: 2 })
    expect(engine.journals).toHaveLength(2)
    expect(engine.metrics).toHaveLength(3)
    expect(result.outcomes[0]).toMatchObject({
      index: 0,
      status: 'imported',
      journalMatch: 'by-issn',
      journalCreated: true
    })
    // The second row is the same journal, reached by identifier: no third journal, and no second creation.
    expect(result.outcomes[1]).toMatchObject({
      status: 'imported',
      journalMatch: 'by-issn',
      journalCreated: false
    })
    expect(result.outcomes[2]).toMatchObject({
      status: 'imported',
      journalMatch: 'by-normalized-name',
      journalCreated: true
    })
  })

  it('reuses a journal registered under a name, without inventing a second one for the same venue', async () => {
    const { engine, importMetrics } = build()

    const result = await importMetrics({
      rows: [
        { ...row(), journalName: '  Nature  ' },
        { ...row({ year: 2023 }), journalName: 'nature' }
      ]
    })

    expect(engine.journals).toHaveLength(1)
    expect(result.journalsCreated).toBe(1)
    expect(result.outcomes[1]).toMatchObject({
      status: 'imported',
      journalMatch: 'by-normalized-name'
    })
  })

  it('skips a repeated import instead of stacking the same claim twice', async () => {
    const { engine, importMetrics } = build()

    const first = await importMetrics({ rows: [{ ...row(), journalName: 'Nature' }] })
    const second = await importMetrics({ rows: [{ ...row(), journalName: 'Nature' }] })

    expect(first.imported).toBe(1)
    expect({ imported: second.imported, skipped: second.skipped }).toEqual({
      imported: 0,
      skipped: 1
    })
    expect(second.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'duplicate' })
    // Still one claim: a later statistics surface counts what the sources said, not how often the file was read.
    expect(engine.metrics).toHaveLength(1)
  })

  it('keeps a changed value as a new claim (append-only), never as an overwrite', async () => {
    const { engine, importMetrics } = build()

    await importMetrics({ rows: [{ ...row(), journalName: 'Nature' }] })
    const corrected = await importMetrics({
      rows: [{ ...row({ value: '50.5' }), journalName: 'Nature' }]
    })

    expect(corrected.imported).toBe(1)
    expect(engine.metrics.map((metric) => metric.value)).toEqual(['48.5', '50.5'])
  })

  it('reports every row it refuses, in order, and never reaches the store for them', async () => {
    const { engine, importMetrics } = build()

    const result = await importMetrics({
      rows: [
        { ...row(), journalName: 'Nature' },
        { ...row({ year: null }), journalName: 'Nature' },
        { ...row({ source: ' ' }), journalName: 'Nature' },
        { ...row({ value: '' }), journalName: 'Nature' },
        { ...row({ issn: '0028-083' }), journalName: 'Nature' },
        { ...row(), journalName: '  ' }
      ]
    })

    expect({ imported: result.imported, skipped: result.skipped }).toEqual({
      imported: 1,
      skipped: 5
    })
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      'imported',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'skipped'
    ])
    expect(
      result.outcomes
        .slice(1)
        .map((outcome) => (outcome.status === 'skipped' ? outcome.reason : 'imported'))
    ).toEqual(['no-year', 'no-source', 'no-value', 'bad-issn', 'name-missing'])
    // Nothing was written for the five refusals: the store holds exactly the rows the report called imported.
    expect(engine.metrics).toHaveLength(1)
    expect(engine.journals).toHaveLength(1)
  })

  it('refuses to pick when a name matches more than one journal', async () => {
    const { engine, importMetrics } = build()
    engine.journals.push(
      journalRow({ id: 'j-a', normalizedName: 'the lancet', issn: '0140-6736' }),
      journalRow({ id: 'j-b', normalizedName: 'the lancet', issn: '1474-547X' })
    )

    const result = await importMetrics({ rows: [{ ...row(), journalName: 'The Lancet' }] })

    expect(result.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'name-ambiguous' })
    expect(result.skipped).toBe(1)
    expect(engine.metrics).toHaveLength(0)
  })

  it('refuses a row whose identifier is not registered yet and that carries no name to register it with', async () => {
    const { engine, importMetrics } = build()

    const result = await importMetrics({ rows: [{ ...row(), issn: '0028-0836' }] })

    expect(result.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'name-missing' })
    expect(result.outcomes[0].status === 'skipped' && result.outcomes[0].detail).toMatch(
      /0028-0836 is not registered yet/
    )
    expect(engine.journals).toHaveLength(0)
  })

  it('aborts on a failure that is not a judgement about a row, instead of reporting it as one', async () => {
    const { engine, importMetrics } = build()
    engine.failAppend.current = true

    await expect(importMetrics({ rows: [{ ...row(), journalName: 'Nature' }] })).rejects.toThrow(
      /database is locked/
    )
  })

  it('imports a delimited table end to end, keeping the line numbers in the report', async () => {
    const { importMetrics } = build()
    const csv = [
      'Journal,ISSN,Kind,Value,Year,Source',
      'Nature,0028-0836,impact-factor,48.5,2024,JCR 2024',
      'Cell,,cas-partition,1区,2024,中科院分区表 2024',
      'Broken,,impact-factor,64.5,,JCR 2024'
    ].join('\n')

    const result = await importMetrics({ text: csv, format: 'csv' })

    expect({ imported: result.imported, skipped: result.skipped }).toEqual({
      imported: 2,
      skipped: 1
    })
    expect(result.outcomes.map((outcome) => outcome.line)).toEqual([2, 3, 4])
    expect(result.outcomes[2]).toMatchObject({ status: 'skipped', reason: 'no-year' })
  })
})
