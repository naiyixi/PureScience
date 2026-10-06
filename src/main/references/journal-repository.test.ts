import { describe, expect, it, vi } from 'vitest'

import { JournalRepository, normalizeJournalName } from './journal-repository'

// The two properties this file protects are the ones that would silently corrupt the library if they broke:
// an uncertain identity must stay uncertain (no fuzzy merge, no invented journal), and a metric correction
// must add a row instead of overwriting what a source said. Both are semantics, so they are pinned against a
// stub client; the migration's real-DB behaviour is verified by running the app twice against one root.

type JournalRow = {
  id: string
  normalizedName: string
  displayName: string | null
  issn: string | null
  issnL: string | null
  eissn: string | null
  publisher: string | null
  homepage: string | null
  createdVia: string
}

type AliasRow = {
  id: string
  normalizedName: string
  journalId: string
  createdVia: string
  mergedFromJournalId: string | null
}

type ReferenceRow = { id: string; journalId: string | null; journalMatch: string | null }

type StubClient = {
  journal: {
    findUnique: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
  }
  journalMetric: {
    create: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
  }
  journalAlias: {
    findUnique: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
  }
  reference: { updateMany: ReturnType<typeof vi.fn> }
  $transaction: ReturnType<typeof vi.fn>
  journals: JournalRow[]
  metrics: Array<Record<string, unknown>>
  aliases: AliasRow[]
  references: ReferenceRow[]
}

const stubClient = (seed: JournalRow[] = [], referenceSeed: ReferenceRow[] = []): StubClient => {
  const journals = [...seed]
  const metrics: Array<Record<string, unknown>> = []
  const aliases: AliasRow[] = []
  const references = [...referenceSeed]
  let nextId = 1
  const client = {
    journal: {
      findUnique: vi.fn(async ({ where }: { where: { issn?: string; id?: string } }) => {
        if (where.id !== undefined) return journals.find((row) => row.id === where.id) ?? null

        return journals.find((row) => row.issn === where.issn) ?? null
      }),
      findMany: vi.fn(async ({ where }: { where: { normalizedName: string } }) =>
        journals.filter((row) => row.normalizedName === where.normalizedName)
      ),
      create: vi.fn(async ({ data }: { data: Omit<JournalRow, 'id'> }) => {
        const row = { id: `j${nextId++}`, ...data } as JournalRow
        journals.push(row)
        return row
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<JournalRow> }) => {
          const row = journals.find((entry) => entry.id === where.id)
          if (!row) throw new Error(`no journal ${where.id}`)
          Object.assign(row, data)
          return row
        }
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = journals.findIndex((entry) => entry.id === where.id)
        if (index === -1) throw new Error(`no journal ${where.id}`)

        return journals.splice(index, 1)[0]
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
      ),
      // The merge's re-attribution, with the engine's own return shape (`{ count }`) so the caller cannot
      // accidentally invent a total.
      updateMany: vi.fn(
        async ({
          where,
          data
        }: {
          where: { journalId: string }
          data: Record<string, unknown>
        }) => {
          const affected = metrics.filter((row) => row.journalId === where.journalId)
          for (const entry of affected) Object.assign(entry, data)

          return { count: affected.length }
        }
      )
    },
    journalAlias: {
      findUnique: vi.fn(async ({ where }: { where: { normalizedName: string } }) => {
        const found = aliases.find((row) => row.normalizedName === where.normalizedName)

        return found ? { ...found } : null
      }),
      findMany: vi.fn(async () => aliases.map((row) => ({ ...row }))),
      create: vi.fn(async ({ data }: { data: Partial<Omit<AliasRow, 'id'>> }) => {
        const row: AliasRow = {
          id: `a${nextId++}`,
          normalizedName: data.normalizedName ?? '',
          journalId: data.journalId ?? '',
          createdVia: data.createdVia ?? 'explicit-merge',
          mergedFromJournalId: data.mergedFromJournalId ?? null
        }
        aliases.push(row)
        return row
      }),
      updateMany: vi.fn(
        async ({
          where,
          data
        }: {
          where: { journalId: string }
          data: Record<string, unknown>
        }) => {
          const affected = aliases.filter((row) => row.journalId === where.journalId)
          for (const entry of affected) Object.assign(entry, data)

          return { count: affected.length }
        }
      ),
      delete: vi.fn(async ({ where }: { where: { normalizedName: string } }) => {
        const index = aliases.findIndex((row) => row.normalizedName === where.normalizedName)
        if (index < 0) throw new Error('alias not found')

        return { ...aliases.splice(index, 1)[0] }
      })
    },
    reference: {
      updateMany: vi.fn(
        async ({
          where,
          data
        }: {
          where: { journalId: string }
          data: Record<string, unknown>
        }) => {
          const affected = references.filter((row) => row.journalId === where.journalId)
          for (const entry of affected) Object.assign(entry, data)

          return { count: affected.length }
        }
      )
    },
    // The engine's interactive transaction, reduced to what the repository needs: one callback, one client.
    $transaction: vi.fn(async (run: (client: unknown) => Promise<unknown>) => run(client)),
    journals,
    metrics,
    aliases,
    references
  }

  return client
}

const build = (
  seed: JournalRow[] = [],
  referenceSeed: ReferenceRow[] = []
): { client: StubClient; repository: JournalRepository } => {
  const client = stubClient(seed, referenceSeed)
  const repository = new JournalRepository({ getClient: async () => client as never })

  return { client, repository }
}

const row = (over: Partial<JournalRow>): JournalRow => ({
  id: 'j0',
  normalizedName: 'nature',
  displayName: 'Nature',
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

describe('aliases (R2-U4)', () => {
  it('resolves a merged-away spelling to the surviving journal, and never ahead of a journal own name', async () => {
    const { repository, client } = build([row({ id: 'j-nature', normalizedName: 'nature' })])
    client.aliases.push({
      id: 'a1',
      normalizedName: 'nature london',
      journalId: 'j-nature',
      createdVia: 'explicit-merge',
      mergedFromJournalId: 'j-old'
    })

    await expect(repository.resolveJournal({ venue: 'Nature (London)' })).resolves.toEqual({
      journalId: 'j-nature',
      match: 'by-alias'
    })
    // A journal's own current name always beats an alias, so a merge can never shadow a live journal.
    await expect(repository.resolveJournal({ venue: 'Nature' })).resolves.toEqual({
      journalId: 'j-nature',
      match: 'by-normalized-name'
    })
    // And an unknown name is still an unknown name: the alias table does not turn it into a match.
    await expect(repository.resolveJournal({ venue: 'Nature Neuroscience' })).resolves.toEqual({
      journalId: null,
      match: 'no-issn'
    })
  })

  it('refuses to register a second identity under a spelling that is already an alias', async () => {
    const { repository, client } = build()
    client.aliases.push({
      id: 'a1',
      normalizedName: 'nature london',
      journalId: 'j-nature',
      createdVia: 'explicit-merge',
      mergedFromJournalId: 'j-old'
    })

    await expect(repository.upsertByNormalizedName({ venue: 'Nature (London)' })).rejects.toThrow(
      /alias/
    )
    expect(client.journals).toHaveLength(0)
  })
})

describe('removeJournalAlias (the merge’s other half)', () => {
  const merged = async (): Promise<{ client: StubClient; repository: JournalRepository }> => {
    const built = build(
      [
        row({ id: 'j-nature', normalizedName: 'nature', displayName: 'Nature', issn: '0028-0836' }),
        row({ id: 'j-london', normalizedName: 'nature london', displayName: 'Nature (London)' })
      ],
      [{ id: 'r1', journalId: 'j-london', journalMatch: 'by-normalized-name' }]
    )
    await built.repository.appendMetric({
      journalId: 'j-london',
      kind: 'impact-factor',
      value: '64.8',
      year: 2023,
      source: 'JCR'
    })
    await built.repository.mergeJournals({
      sourceJournalId: 'j-london',
      targetJournalId: 'j-nature'
    })
    return built
  }

  it('releases the name and says which journal it came from', async () => {
    const { client, repository } = await merged()

    const result = await repository.removeJournalAlias({ normalizedName: 'nature london' })

    expect(result).toEqual({
      ok: true,
      normalizedName: 'nature london',
      journalId: 'j-nature',
      // The alias records the merge that wrote it, so the surface can name where the name came from.
      mergedFromJournalId: 'j-london'
    })
    expect(client.aliases).toEqual([])
  })

  it('refuses by name when there is no such alias', async () => {
    const { repository } = await merged()

    expect(await repository.removeJournalAlias({ normalizedName: 'never merged' })).toEqual({
      ok: false,
      reason: 'alias-not-found',
      detail: 'no alias named never merged'
    })
  })

  it('leaves the numbers where the merge put them — releasing a name is not undoing a merge', async () => {
    const { client, repository } = await merged()

    await repository.removeJournalAlias({ normalizedName: 'nature london' })

    // The merge re-attributed these rows and recorded no former journal on them, so there is nothing to move
    // back. A "split" that quietly moved them would be inventing an attribution nobody ever recorded.
    expect(client.metrics[0]?.journalId).toBe('j-nature')
    expect(client.references[0]?.journalId).toBe('j-nature')
    expect(client.journals.map((entry) => entry.id)).toEqual(['j-nature'])
  })
})

describe('mergeJournals (R2-U4)', () => {
  it('moves metrics, references and aliases onto the survivor and keeps the old spelling resolving there', async () => {
    const { repository, client } = build(
      [
        row({ id: 'j-nature', normalizedName: 'nature', displayName: 'Nature', issn: '0028-0836' }),
        row({ id: 'j-london', normalizedName: 'nature london', displayName: 'Nature (London)' })
      ],
      [{ id: 'r1', journalId: 'j-london', journalMatch: 'by-normalized-name' }]
    )
    await repository.appendMetric({
      journalId: 'j-london',
      kind: 'impact-factor',
      value: '64.8',
      year: 2023,
      source: 'JCR'
    })

    const result = await repository.mergeJournals({
      sourceJournalId: 'j-london',
      targetJournalId: 'j-nature'
    })

    expect(result).toEqual({
      ok: true,
      sourceJournalId: 'j-london',
      targetJournalId: 'j-nature',
      alias: 'nature london',
      movedMetrics: 1,
      movedReferences: 1,
      movedAliases: 0
    })
    // The source row is gone; its name lives on as an alias, not as a second journal.
    expect(client.journals.map((entry) => entry.id)).toEqual(['j-nature'])
    expect(client.metrics[0].journalId).toBe('j-nature')
    // The re-attributed reference says WHY it is linked now, rather than keeping a name match that no longer
    // explains the link.
    expect(client.references[0]).toEqual({
      id: 'r1',
      journalId: 'j-nature',
      journalMatch: 'merged'
    })
    expect(client.aliases).toEqual([
      {
        id: expect.any(String),
        normalizedName: 'nature london',
        journalId: 'j-nature',
        createdVia: 'explicit-merge',
        mergedFromJournalId: 'j-london'
      }
    ])
    await expect(repository.resolveJournal({ venue: 'Nature (London)' })).resolves.toEqual({
      journalId: 'j-nature',
      match: 'by-alias'
    })
  })

  it('keeps the surviving spelling, and adopts the merged one only when the survivor has none', async () => {
    const kept = build([
      row({ id: 'j-a', normalizedName: 'alpha', displayName: 'Alpha' }),
      row({ id: 'j-b', normalizedName: 'beta', displayName: 'Beta' })
    ])
    await kept.repository.mergeJournals({ sourceJournalId: 'j-b', targetJournalId: 'j-a' })
    expect(kept.client.journals[0].displayName).toBe('Alpha')

    const blank = build([
      row({ id: 'j-a', normalizedName: 'alpha', displayName: null }),
      row({ id: 'j-b', normalizedName: 'beta', displayName: 'Beta' })
    ])
    await blank.repository.mergeJournals({ sourceJournalId: 'j-b', targetJournalId: 'j-a' })
    expect(blank.client.journals[0].displayName).toBe('Beta')
  })

  it('refuses a self merge, a missing source and a missing target by name — and changes nothing', async () => {
    const { repository, client } = build([row({ id: 'j-nature' })])

    await expect(
      repository.mergeJournals({ sourceJournalId: 'j-nature', targetJournalId: 'j-nature' })
    ).resolves.toEqual({
      ok: false,
      reason: 'self-merge',
      detail: 'a journal cannot be merged into itself'
    })
    await expect(
      repository.mergeJournals({ sourceJournalId: 'ghost', targetJournalId: 'j-nature' })
    ).resolves.toMatchObject({ ok: false, reason: 'source-not-found' })
    await expect(
      repository.mergeJournals({ sourceJournalId: 'j-nature', targetJournalId: 'ghost' })
    ).resolves.toMatchObject({ ok: false, reason: 'target-not-found' })
    expect(client.journals).toHaveLength(1)
    expect(client.aliases).toHaveLength(0)
    expect(client.journal.delete).not.toHaveBeenCalled()
  })

  it('refuses when the spelling already names a third journal instead of taking that name away', async () => {
    const { repository, client } = build([
      row({ id: 'j-nature', normalizedName: 'nature' }),
      row({ id: 'j-london', normalizedName: 'nature london' }),
      row({ id: 'j-third', normalizedName: 'third' })
    ])
    client.aliases.push({
      id: 'a1',
      normalizedName: 'nature london',
      journalId: 'j-third',
      createdVia: 'explicit-merge',
      mergedFromJournalId: 'j-old'
    })

    const result = await repository.mergeJournals({
      sourceJournalId: 'j-london',
      targetJournalId: 'j-nature'
    })

    expect(result).toMatchObject({ ok: false, reason: 'alias-conflict' })
    // A refusal must not leave half a merge behind: nothing moved and the third journal still owns the name.
    expect(client.journals.map((entry) => entry.id).sort()).toEqual([
      'j-london',
      'j-nature',
      'j-third'
    ])
    expect(client.aliases[0].journalId).toBe('j-third')
    expect(client.journal.delete).not.toHaveBeenCalled()
  })
})
