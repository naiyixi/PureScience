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
  storageRoot = await mkdtemp(join(tmpdir(), 'purescience-reading-status-'))
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

// B3 against a real SQLite file: the additive column has to exist on a database created by the runtime DDL
// (not by Prisma), a record that predates the layer must read as unread, and the mark must survive a re-read
// instead of only living in the surface that made it.
describe('reference reading state storage', () => {
  it('starts every record unread and keeps the mark with the time it was made', async () => {
    const repository = await createRepository()
    const reference = await repository.createReference({
      projectId: 'project-1',
      citationKey: 'Unmarked2020',
      title: 'A record nobody has marked',
      authors: []
    })

    // Nothing stored: the row is unread by contract, not by a default written at create time.
    expect(reference.readingStatus).toBeUndefined()
    expect(reference.readingStatusUpdatedAt).toBeUndefined()

    const reading = await repository.setReadingStatus(reference.id, 'reading')
    expect(reading.readingStatus).toBe('reading')
    expect(typeof reading.readingStatusUpdatedAt).toBe('number')

    const read = await repository.setReadingStatus(reference.id, 'read')
    expect(read.readingStatus).toBe('read')

    // Re-read from storage: the mark is on the row, not in memory.
    const stored = await repository.getReference(reference.id)
    expect(stored?.readingStatus).toBe('read')
    expect(stored?.readingStatusUpdatedAt).toBeGreaterThan(0)
  })

  it('keeps one record’s mark away from its neighbours', async () => {
    const repository = await createRepository()
    const marked = await repository.createReference({
      projectId: 'project-1',
      citationKey: 'Marked2021',
      title: 'Marked read',
      authors: []
    })
    const untouched = await repository.createReference({
      projectId: 'project-1',
      citationKey: 'Untouched2021',
      title: 'Never marked',
      authors: []
    })

    await repository.setReadingStatus(marked.id, 'read')

    const rows = await repository.listReferences('project-1')
    const byKey = new Map(rows.map((row) => [row.citationKey, row]))
    expect(byKey.get('Marked2021')?.readingStatus).toBe('read')
    expect(byKey.get('Untouched2021')?.readingStatus).toBeUndefined()
    expect(untouched.readingStatus).toBeUndefined()
  })
})
