import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { ReferenceRepository } from './repository'

let storageRoot: string | undefined
let client: PrismaClient | undefined

const createRepository = async (): Promise<ReferenceRepository> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'purescience-doi-integrity-'))
  client = createProjectDbClient(storageRoot)
  await ensureProjectSchema(client)
  return new ReferenceRepository(() => Promise.resolve(client as PrismaClient))
}

afterEach(async () => {
  await client?.$disconnect()
  client = undefined
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('reference DOI integrity', () => {
  it('stores the verdict with the fields that make it auditable', async () => {
    const repository = await createRepository()
    const reference = await repository.createReference({
      projectId: 'project-1',
      citationKey: 'Retracted2020',
      title: 'A paper that was retracted',
      authors: [],
      doi: '10.1000/retracted'
    })

    // Never checked is distinct from checked-and-clean.
    expect(await repository.getDoiIntegrity(reference.id)).toBeUndefined()

    await repository.recordDoiIntegrity(reference.id, {
      doi: '10.1000/retracted',
      status: 'retracted',
      checkedAt: '2026-10-28T00:00:00.000Z',
      sourceUrl: 'https://api.crossref.org/works/10.1000%2Fretracted',
      notices: [
        { kind: 'retraction', doi: '10.1000/notice', url: 'https://doi.org/10.1000/notice' }
      ]
    })

    const stored = await repository.getDoiIntegrity(reference.id)
    expect(stored).toEqual({
      status: 'retracted',
      checkedAt: '2026-10-28T00:00:00.000Z',
      sourceUrl: 'https://api.crossref.org/works/10.1000%2Fretracted',
      notices: [
        { kind: 'retraction', doi: '10.1000/notice', url: 'https://doi.org/10.1000/notice' }
      ]
    })
  })

  // The honesty rule survives storage: an unreachable registry is recorded as `unavailable`, so a later
  // reader cannot mistake "we never got an answer" for "nothing was found".
  it('records an unavailable lookup as unavailable, not as clean', async () => {
    const repository = await createRepository()
    const reference = await repository.createReference({
      projectId: 'project-1',
      citationKey: 'Offline2021',
      title: 'A paper checked while offline',
      authors: [],
      doi: '10.1000/offline'
    })

    await repository.recordDoiIntegrity(reference.id, {
      doi: '10.1000/offline',
      status: 'unavailable',
      checkedAt: '2026-10-28T01:00:00.000Z',
      sourceUrl: 'https://api.crossref.org/works/10.1000%2Foffline',
      notices: [],
      error: 'getaddrinfo ENOTFOUND api.crossref.org'
    })

    const stored = await repository.getDoiIntegrity(reference.id)
    expect(stored?.status).toBe('unavailable')
    expect(stored?.notices).toEqual([])
  })

  it('overwrites an older verdict with the newer one', async () => {
    const repository = await createRepository()
    const reference = await repository.createReference({
      projectId: 'project-1',
      citationKey: 'Rechecked2022',
      title: 'A paper rechecked later',
      authors: [],
      doi: '10.1000/rechecked'
    })

    const base = {
      doi: '10.1000/rechecked',
      checkedAt: '2026-10-01T00:00:00.000Z',
      sourceUrl: 'https://api.crossref.org/works/10.1000%2Frechecked',
      notices: []
    }
    await repository.recordDoiIntegrity(reference.id, { ...base, status: 'clean' })
    await repository.recordDoiIntegrity(reference.id, {
      ...base,
      status: 'corrected',
      checkedAt: '2026-10-28T00:00:00.000Z',
      notices: [{ kind: 'correction', doi: '10.1000/corr', url: 'https://doi.org/10.1000/corr' }]
    })

    const stored = await repository.getDoiIntegrity(reference.id)
    expect(stored?.status).toBe('corrected')
    expect(stored?.checkedAt).toBe('2026-10-28T00:00:00.000Z')
  })

  // The export gate reads this list. The three reasons must stay distinguishable: a reference never
  // checked needs an action, one whose lookup failed needs a retry, one that is stale needs a refresh —
  // reporting them as one bucket tells the reader to redo everything, which is how a gate gets ignored.
  it('lists exactly the references an export cannot vouch for', async () => {
    const repository = await createRepository()
    const now = new Date('2026-10-28T00:00:00.000Z')

    const make = async (citationKey: string, doi: string | undefined): Promise<string> => {
      const reference = await repository.createReference({
        projectId: 'project-gaps',
        citationKey,
        title: citationKey,
        authors: [],
        ...(doi ? { doi } : {})
      })
      return reference.id
    }

    const neverChecked = await make('NeverChecked', '10.1000/never')
    const unavailable = await make('Unavailable', '10.1000/unavailable')
    const stale = await make('Stale', '10.1000/stale')
    const fresh = await make('Fresh', '10.1000/fresh')
    const retractedButChecked = await make('Retracted', '10.1000/retracted')
    // No DOI at all: an export cannot check what has no identifier, so it is not a gap.
    await make('NoDoi', undefined)

    const stamp = (
      iso: string
    ): {
      doi: string
      checkedAt: string
      sourceUrl: string
      notices: never[]
    } => ({
      doi: '',
      checkedAt: iso,
      sourceUrl: 'https://api.crossref.org/works/x',
      notices: []
    })

    await repository.recordDoiIntegrity(unavailable, {
      ...stamp('2026-10-27T00:00:00.000Z'),
      doi: '10.1000/unavailable',
      status: 'unavailable'
    })
    await repository.recordDoiIntegrity(stale, {
      ...stamp('2026-09-01T00:00:00.000Z'),
      doi: '10.1000/stale',
      status: 'clean'
    })
    await repository.recordDoiIntegrity(fresh, {
      ...stamp('2026-10-27T00:00:00.000Z'),
      doi: '10.1000/fresh',
      status: 'clean'
    })
    // A retracted-but-checked reference is not a *gap*: the verdict exists and is auditable. Whether to
    // block on it is a different decision, taken by the caller that sees the status.
    await repository.recordDoiIntegrity(retractedButChecked, {
      ...stamp('2026-10-27T00:00:00.000Z'),
      doi: '10.1000/retracted',
      status: 'retracted'
    })

    const gaps = await repository.listIntegrityGaps('project-gaps', {
      maxAgeDays: 30,
      now: () => now
    })

    const byKey = new Map(gaps.map((gap) => [gap.citationKey, gap.reason]))
    expect(byKey.get('NeverChecked')).toBe('never-checked')
    expect(byKey.get('Unavailable')).toBe('unavailable')
    expect(byKey.get('Stale')).toBe('stale')
    expect(byKey.has('Fresh')).toBe(false)
    expect(byKey.has('Retracted')).toBe(false)
    expect(byKey.has('NoDoi')).toBe(false)
    expect(gaps.find((gap) => gap.citationKey === 'NeverChecked')?.referenceId).toBe(neverChecked)
  })

  // The export gate reads this summary and must not touch the network. A retracted reference is a decision
  // (refuse and name it); a gap is an instruction (check / retry / refresh) — the two are reported apart so
  // the surface can act on each without re-deriving the difference.
  it('summarizes a project without any network access', async () => {
    const repository = await createRepository()
    const make = async (citationKey: string, doi: string | undefined): Promise<string> => {
      const reference = await repository.createReference({
        projectId: 'project-summary',
        citationKey,
        title: citationKey,
        authors: [],
        ...(doi ? { doi } : {})
      })
      return reference.id
    }

    const retractedId = await make('Retracted', '10.1000/retracted')
    const cleanId = await make('Clean', '10.1000/clean')
    await make('NeverChecked', '10.1000/never')
    await make('NoDoi', undefined)

    const stamp = (iso: string): { checkedAt: string; sourceUrl: string } => ({
      checkedAt: iso,
      sourceUrl: 'https://api.crossref.org/works/x'
    })

    await repository.recordDoiIntegrity(retractedId, {
      doi: '10.1000/retracted',
      status: 'retracted',
      ...stamp('2026-10-27T00:00:00.000Z'),
      notices: [
        { kind: 'retraction', doi: '10.1000/notice', url: 'https://doi.org/10.1000/notice' }
      ]
    })
    await repository.recordDoiIntegrity(cleanId, {
      doi: '10.1000/clean',
      status: 'clean',
      ...stamp('2026-10-27T00:00:00.000Z'),
      notices: []
    })

    const summary = await repository.summarizeIntegrity('project-summary')
    expect(summary.retracted).toEqual([
      {
        referenceId: retractedId,
        citationKey: 'Retracted',
        doi: '10.1000/retracted',
        checkedAt: '2026-10-27T00:00:00.000Z',
        noticeUrls: ['https://doi.org/10.1000/notice']
      }
    ])
    // 3 DOI-bearing references (NoDoi excluded), 2 already checked.
    expect(summary.total).toBe(3)
    expect(summary.checked).toBe(2)
    expect(summary.gaps.map((gap) => gap.citationKey)).toEqual(['NeverChecked'])
  })
})
