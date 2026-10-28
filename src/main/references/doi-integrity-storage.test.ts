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
})
