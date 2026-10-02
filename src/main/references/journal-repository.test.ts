import { describe, expect, it, vi } from 'vitest'

import { JournalRepository, normalizeJournalName } from './journal-repository'

// The two properties this file protects are the ones that would silently corrupt the library if they broke:
// an uncertain identity must stay uncertain (no fuzzy merge, no invented journal), and a metric correction
// must add a row instead of overwriting what a source said. Both are semantics, so they are pinned against a
// stub client; the migration's real-DB behaviour is verified by running the app twice against one root.

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

type StubClient = {
  journal: {
    findUnique: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
  }
  journalMetric: {
    create: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
  }
  journals: JournalRow[]
  metrics: Array<Record<string, unknown>>
}

const stubClient = (seed: JournalRow[] = []): StubClient => {
  const journals = [...seed]
  const metrics: Array<Record<string, unknown>> = []
  let nextId = 1
  const client = {
    journal: {
      findUnique: vi.fn(
        async ({ where }: { where: { issn: string } }) =>
          journals.find((row) => row.issn === where.issn) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: { normalizedName: string } }) =>
        journals.filter((row) => row.normalizedName === where.normalizedName)
      ),
      create: vi.fn(async ({ data }: { data: Omit<JournalRow, 'id'> }) => {
        const row = { id: `j${nextId++}`, ...data } as JournalRow
        journals.push(row)
        return row
      })
    },
    journalMetric: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `m${nextId++}`, ...data }
        metrics.push(created)
        return { id: created.id }
      }),
      findFirst: vi.fn(
        async ({
          where,
          select
        }: {
          where: Record<string, unknown>
          select?: Record<string, boolean>
        }) => {
          const found =
            metrics.find((entry) =>
              Object.entries(where).every(([key, value]) => entry[key] === value)
            ) ?? null
          if (!found || !select) return found

          // Honour the projection like the engine does: the repository asks for an id and must get one.
          return Object.fromEntries(
            Object.keys(select).map((key) => [key, (found as Record<string, unknown>)[key]])
          )
        }
      ),
      findMany: vi.fn(async ({ where }: { where: { journalId: string } }) =>
        metrics.filter((row) => row.journalId === where.journalId)
      )
    },
    journals,
    metrics
  }

  return client
}

const build = (seed: JournalRow[] = []): { client: StubClient; repository: JournalRepository } => {
  const client = stubClient(seed)
  const repository = new JournalRepository({ getClient: async () => client as never })

  return { client, repository }
}

const row = (over: Partial<JournalRow>): JournalRow => ({
  id: 'j0',
  normalizedName: 'nature',
  issn: null,
  issnL: null,
  eissn: null,
  publisher: null,
  homepage: null,
  createdVia: 'by-issn',
  ...over
})

describe('normalizeJournalName', () => {
  it('folds case, punctuation and spacing — and nothing else', () => {
    expect(normalizeJournalName('  Nature   Communications ')).toBe('nature communications')
    expect(normalizeJournalName('J. Biol. Chem.')).toBe('j biol chem')
    expect(normalizeJournalName('München Medical Weekly')).toBe('munchen medical weekly')
  })

  it('keeps two genuinely different venues apart (no stemming, no token sorting)', () => {
    expect(normalizeJournalName('Nature')).not.toBe(normalizeJournalName('Nature Communications'))
    expect(normalizeJournalName('Cell Stem Cell')).not.toBe(normalizeJournalName('Stem Cell'))
  })

  it('keeps non-Latin names usable instead of folding them away', () => {
    // Regression, found on the real machine: an ASCII-only class turned every one of these into the empty
    // string, so a Chinese-named journal could never be registered or matched — and a table with the
    // 期刊名称 header this product maps imported zero rows, each refused as "requires a usable venue name".
    expect(normalizeJournalName('中华医学杂志')).toBe('中华医学杂志')
    expect(normalizeJournalName('中国科学：生命科学')).toBe('中国科学 生命科学')
    // Full-width and half-width punctuation are one boundary (the same argument as the diacritics above),
    // and Chinese book-title marks are punctuation, not part of the name.
    const fullWidth = normalizeJournalName('中国科学：生命科学')
    const halfWidth = normalizeJournalName('中国科学:生命科学')
    expect(fullWidth).toBe(halfWidth)
    expect(normalizeJournalName('《中华医学杂志》')).toBe('中华医学杂志')
    // Compatibility forms fold, so one full-width number is one number.
    expect(normalizeJournalName('Journal ２０２４')).toBe('journal 2024')
    // A blank name still normalizes to nothing, which is what the "usable venue name" guard must catch.
    expect(normalizeJournalName('   ')).toBe('')
  })
})

describe('resolveJournal', () => {
  it('links by ISSN when the journal is registered under that identifier', async () => {
    const { repository } = build([row({ id: 'j-nature', issn: '0028-0836' })])

    await expect(
      repository.resolveJournal({ issn: '0028-0836', venue: 'Nature' })
    ).resolves.toEqual({
      journalId: 'j-nature',
      match: 'by-issn'
    })
  })

  it('accepts a printed ISSN with or without the dash, and refuses a malformed one', async () => {
    const { repository, client } = build([row({ id: 'j-nature', issn: '0028-0836' })])

    await expect(repository.resolveJournal({ issn: '00280836', venue: 'Nature' })).resolves.toEqual(
      {
        journalId: 'j-nature',
        match: 'by-issn'
      }
    )
    // A repaired identifier would be a fabricated one: "0028-083" is not an ISSN, so it resolves nothing by
    // identifier — and the name fallback then links the reference to the journal already registered as
    // "nature". Both halves matter: the malformed ISSN is refused, and the reference is still identified.
    await expect(repository.resolveJournal({ issn: '0028-083', venue: 'Nature' })).resolves.toEqual(
      {
        journalId: 'j-nature',
        match: 'by-normalized-name'
      }
    )
    expect(client.journal.create).not.toHaveBeenCalled()
  })

  it('falls back to an exact normalized name match, and reports when there is none', async () => {
    const { repository, client } = build([row({ id: 'j-nature', issn: '0028-0836' })])

    await expect(repository.resolveJournal({ venue: 'nature' })).resolves.toEqual({
      journalId: 'j-nature',
      match: 'by-normalized-name'
    })
    // No exact match ⇒ NO journal is invented for a bare name; the failure is named instead.
    await expect(repository.resolveJournal({ venue: 'Nature Neuroscience' })).resolves.toEqual({
      journalId: null,
      match: 'no-issn'
    })
    expect(client.journal.create).not.toHaveBeenCalled()
  })

  it('refuses to pick when one name matches several journals', async () => {
    const { repository } = build([
      row({ id: 'j-a', normalizedName: 'the lancet', issn: '0140-6736' }),
      row({ id: 'j-b', normalizedName: 'the lancet', issn: '1474-547X' })
    ])

    await expect(repository.resolveJournal({ venue: 'The Lancet' })).resolves.toEqual({
      journalId: null,
      match: 'ambiguous'
    })
  })

  it('reports no-issn when there is nothing to resolve with', async () => {
    const { repository } = build()

    await expect(repository.resolveJournal({ venue: '   ' })).resolves.toEqual({
      journalId: null,
      match: 'no-issn'
    })
    await expect(repository.resolveJournal({})).resolves.toEqual({
      journalId: null,
      match: 'no-issn'
    })
  })

  it('reports name-not-exact when an identifier is present but that journal is not registered yet', async () => {
    const { repository, client } = build()

    await expect(
      repository.resolveJournal({ issn: '0028-0836', venue: 'Nature' })
    ).resolves.toEqual({
      journalId: null,
      match: 'name-not-exact'
    })
    expect(client.journal.create).not.toHaveBeenCalled()
  })
})

describe('upsertByIssn', () => {
  it('produces one row for the same ISSN written twice, and keeps how the identity was established', async () => {
    const { repository, client } = build()

    const first = await repository.upsertByIssn({ issn: '0028-0836', venue: 'Nature' })
    const second = await repository.upsertByIssn({ issn: '00280836', venue: 'Nature (London)' })

    expect(second.id).toBe(first.id)
    expect(client.journals).toHaveLength(1)
    expect(client.journal.create).toHaveBeenCalledTimes(1)
    expect(first.createdVia).toBe('by-issn')
  })

  it('refuses to invent an identifier when none is well-formed', async () => {
    const { repository } = build()

    await expect(repository.upsertByIssn({ issn: 'n/a', venue: 'Nature' })).rejects.toThrow(/ISSN/)
  })
})

describe('findMetric', () => {
  it('recognises an identical claim and answers null for a different one', async () => {
    const { repository } = build()

    await repository.appendMetric({
      journalId: 'j-nature',
      kind: 'impact-factor',
      value: '48.5',
      year: 2024,
      source: 'JCR 2024'
    })

    await expect(
      repository.findMetric({
        journalId: 'j-nature',
        kind: 'impact-factor',
        value: '48.5',
        year: 2024,
        source: 'JCR 2024'
      })
    ).resolves.toEqual({ id: expect.any(String) })
    // A different value is a different claim — both are kept, so this must NOT be read as the same row.
    await expect(
      repository.findMetric({
        journalId: 'j-nature',
        kind: 'impact-factor',
        value: '50.5',
        year: 2024,
        source: 'JCR 2024'
      })
    ).resolves.toBeNull()
    // Same number, different year: also a different claim.
    await expect(
      repository.findMetric({
        journalId: 'j-nature',
        kind: 'impact-factor',
        value: '48.5',
        year: 2023,
        source: 'JCR 2024'
      })
    ).resolves.toBeNull()
  })
})

describe('appendMetric', () => {
  it('adds a row per claim: correcting a value does not overwrite the earlier one', async () => {
    const { repository, client } = build()

    await repository.appendMetric({
      journalId: 'j-nature',
      kind: 'impact-factor',
      value: '48.5',
      year: 2023,
      source: 'JCR 2023'
    })
    await repository.appendMetric({
      journalId: 'j-nature',
      kind: 'impact-factor',
      value: '50.5',
      year: 2024,
      source: 'JCR 2024'
    })

    expect(client.metrics).toHaveLength(2)
    expect(client.metrics.map((entry) => entry.value)).toEqual(['48.5', '50.5'])
    // Numeric mirror only for values that are unambiguously numbers; a quartile keeps only its text.
    expect(client.metrics[0].numericValue).toBe(48.5)
  })

  it('refuses an undated or unsourced metric instead of storing a number that cannot be labelled', async () => {
    const { repository } = build()

    await expect(
      repository.appendMetric({
        journalId: 'j',
        kind: 'impact-factor',
        value: '48.5',
        year: Number.NaN,
        source: 'JCR'
      })
    ).rejects.toThrow(/year/)
    await expect(
      repository.appendMetric({
        journalId: 'j',
        kind: 'impact-factor',
        value: '48.5',
        year: 2024,
        source: '  '
      })
    ).rejects.toThrow(/source/)
    await expect(
      repository.appendMetric({
        journalId: 'j',
        kind: 'impact-factor',
        value: '   ',
        year: 2024,
        source: 'JCR'
      })
    ).rejects.toThrow(/value/)
  })

  it('keeps a non-numeric value as text without inventing a number for it', async () => {
    const { repository, client } = build()

    await repository.appendMetric({
      journalId: 'j-nature',
      kind: 'jcr-quartile',
      value: 'Q1',
      year: 2024,
      source: 'JCR 2024'
    })

    expect(client.metrics[0].value).toBe('Q1')
    expect(client.metrics[0].numericValue).toBeNull()
  })
})
