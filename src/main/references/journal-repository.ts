import type { PrismaClient } from '@prisma/client'

import { normalizeIssn, normalizeJournalName } from '../../shared/journal-identity'

// The name rule lives in shared because the import path has to judge a row's identity before the repository
// is called; re-exported here so the socket this file has always offered stays where callers expect it.
export { normalizeJournalName }

// Only the delegates this repository needs, typed to the subset so it stays unit-testable with a lightweight
// mock instead of a real engine-backed client (the same convention as ReferenceClient).
export type JournalClient = Pick<PrismaClient, 'journal' | 'journalMetric'>

// Journals as first-class entities (R2). Two decisions here are load-bearing and are the reason this file
// is separate from the reference repository:
//
//   * an identity that is not certain is not an identity. `resolveJournal` never invents a journal from a
//     bare venue string: it matches by identifier, then by exact normalized name, and otherwise reports a
//     NAMED failure with no id. Creating a row for every unparsed venue would turn a typo into a journal and
//     a failed parse into a silent "no journal".
//   * metrics are history, not properties. `appendMetric` never updates: a correction is a new row, so what
//     was claimed when, by whom, stays readable. A metric without a year or a source is refused outright,
//     because an undated, unsourced number is not a fact (R2-U3 must be able to print "which year, which
//     source", and a missing metric must render as unknown — never as 0).

export type JournalMatch =
  | 'by-issn'
  | 'by-normalized-name'
  // No identifier and no usable name: there is nothing to resolve with.
  | 'no-issn'
  // A name was given but matched no existing journal exactly. Matching is never fuzzy: two venues whose
  // names merely look alike are two venues.
  | 'name-not-exact'
  // The normalized name matched more than one journal: refuse to pick rather than merge.
  | 'ambiguous'

export type JournalRecord = {
  id: string
  normalizedName: string
  issn: string | null
  createdVia: string
}

export type JournalIdentity = {
  issn?: string | null
  issnL?: string | null
  eissn?: string | null
  venue?: string | null
  publisher?: string | null
  homepage?: string | null
}

const JOURNAL_SELECT = { id: true, normalizedName: true, issn: true, createdVia: true } as const

// The lazy-client seam every repository in this module uses: the engine client arrives on first use so a
// schema-ensure failure can recover.
export type JournalRepositoryOptions = {
  getClient: () => Promise<JournalClient>
}

export class JournalRepository {
  constructor(private readonly options: JournalRepositoryOptions) {}

  private getClient(): Promise<JournalClient> {
    return this.options.getClient()
  }

  // Upserts by identifier: the same ISSN twice produces one row (R2-U1 acceptance ①), and an existing row
  // keeps its createdVia so the record of how the identity was established survives later name refreshes.
  async upsertByIssn(identity: JournalIdentity & { venue: string }): Promise<JournalRecord> {
    const client = await this.getClient()
    const issn = normalizeIssn(identity.issn) ?? normalizeIssn(identity.issnL)
    if (!issn) throw new Error('upsertByIssn requires a well-formed ISSN; refusing to invent one')
    const normalizedName = normalizeJournalName(identity.venue)
    if (!normalizedName) throw new Error('upsertByIssn requires a usable venue name')

    const existing = await client.journal.findUnique({ where: { issn }, select: JOURNAL_SELECT })
    if (existing) return existing

    return client.journal.create({
      data: {
        normalizedName,
        issn,
        issnL: normalizeIssn(identity.issnL) ?? null,
        eissn: normalizeIssn(identity.eissn) ?? null,
        publisher: identity.publisher?.trim() || null,
        homepage: identity.homepage?.trim() || null,
        createdVia: 'by-issn'
      },
      select: JOURNAL_SELECT
    })
  }

  // Upserts by exact normalized name. Only for callers that are registering a journal they can name AND
  // source (e.g. importing a metric list); the reference-resolution path below deliberately does not use it.
  async upsertByNormalizedName(
    identity: JournalIdentity & { venue: string }
  ): Promise<JournalRecord> {
    const client = await this.getClient()
    const normalizedName = normalizeJournalName(identity.venue)
    if (!normalizedName) throw new Error('upsertByNormalizedName requires a usable venue name')

    const matches = await client.journal.findMany({
      where: { normalizedName },
      select: JOURNAL_SELECT
    })
    if (matches.length > 1) {
      // Never pick one of several: that is the silent merge this repository exists to prevent.
      throw new Error(
        `journal name "${identity.venue}" matches ${matches.length} journals; resolve it explicitly instead of merging`
      )
    }
    if (matches[0]) return matches[0]

    const issn = normalizeIssn(identity.issn) ?? normalizeIssn(identity.issnL)
    return client.journal.create({
      data: {
        normalizedName,
        issn: issn ?? null,
        issnL: normalizeIssn(identity.issnL) ?? null,
        eissn: normalizeIssn(identity.eissn) ?? null,
        publisher: identity.publisher?.trim() || null,
        homepage: identity.homepage?.trim() || null,
        createdVia: 'by-normalized-name'
      },
      select: JOURNAL_SELECT
    })
  }

  // Resolution used when a reference is stored. Identifier first, then an exact name match — and when
  // neither identifies the venue, the CALLER gets a named reason and a null id, not a fabricated journal.
  async resolveJournal(
    identity: JournalIdentity
  ): Promise<{ journalId: string | null; match: JournalMatch }> {
    const client = await this.getClient()
    const issn = normalizeIssn(identity.issn) ?? normalizeIssn(identity.issnL)
    if (issn) {
      const byIssn = await client.journal.findUnique({ where: { issn }, select: JOURNAL_SELECT })
      if (byIssn) return { journalId: byIssn.id, match: 'by-issn' }
    }

    const normalizedName = identity.venue ? normalizeJournalName(identity.venue) : ''
    if (!normalizedName) return { journalId: null, match: 'no-issn' }

    const matches = await client.journal.findMany({
      where: { normalizedName },
      select: JOURNAL_SELECT
    })
    if (matches.length > 1) return { journalId: null, match: 'ambiguous' }
    if (matches[0]) return { journalId: matches[0].id, match: 'by-normalized-name' }

    // An identifier that is not in the library yet is not a match either: the journal has not been
    // registered, so this reference stays unlinked and the venue text remains what a surface shows.
    return { journalId: null, match: issn ? 'name-not-exact' : 'no-issn' }
  }

  // Append-only. Correcting a value means adding a row: an UPDATE would erase what the source said before.
  async appendMetric(input: {
    journalId: string
    kind: string
    value: string
    year: number
    source: string
    note?: string
  }): Promise<{ id: string }> {
    const client = await this.getClient()
    const kind = input.kind?.trim()
    const value = input.value?.trim()
    const source = input.source?.trim()
    if (!kind) throw new Error('appendMetric requires a kind')
    if (!value) throw new Error('appendMetric requires a value; a missing metric is not a zero')
    // Both are required by the schema and by the doctrine: an undated or unsourced number cannot be printed
    // with the year and source it came from, so it must not be stored at all.
    if (!Number.isInteger(input.year)) throw new Error('appendMetric requires an integer year')
    if (!source) throw new Error('appendMetric requires a source')

    const numeric = Number(value.replace(/,/g, ''))
    const numericValue =
      value !== '' && Number.isFinite(numeric) && /^[\d.,]+$/.test(value) ? numeric : null

    const row = await client.journalMetric.create({
      data: {
        journalId: input.journalId,
        kind,
        value,
        numericValue,
        year: input.year,
        source,
        note: input.note?.trim() || null
      },
      select: { id: true }
    })

    return row
  }

  // Reads one claim back by value. The import path uses it so re-importing the same table is a no-op
  // instead of stacking identical rows — an append-only table that keeps identical claims would make every
  // later count depend on how many times someone ran the import.
  async findMetric(input: {
    journalId: string
    kind: string
    value: string
    year: number
    source: string
  }): Promise<{ id: string } | null> {
    const client = await this.getClient()

    return client.journalMetric.findFirst({
      where: {
        journalId: input.journalId,
        kind: input.kind.trim(),
        value: input.value.trim(),
        year: input.year,
        source: input.source.trim()
      },
      select: { id: true }
    })
  }

  // The whole point of the separate table: a surface can show every claim ever made about one journal.
  async listMetrics(
    journalId: string,
    kind?: string
  ): Promise<
    Array<{ kind: string; value: string; year: number; source: string; fetchedAt: Date }>
  > {
    const client = await this.getClient()

    return client.journalMetric.findMany({
      where: { journalId, ...(kind ? { kind } : {}) },
      orderBy: [{ kind: 'asc' }, { year: 'desc' }],
      select: { kind: true, value: true, year: true, source: true, fetchedAt: true }
    })
  }
}
