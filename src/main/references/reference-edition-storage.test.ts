import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { ReferenceRepository } from './repository'

// The edition column is additive: a record imported from RIS carries `ET 2`, and a database created
// before this column existed must gain it without losing what it already holds. Both halves are pinned
// here against the app's own schema bootstrap and a real SQLite file — a mocked delegate cannot show
// that the DDL and the generated client agree.

let roots: string[] = []

const createClient = async (): Promise<ReturnType<typeof createProjectDbClient>> => {
  const root = await mkdtemp(join(tmpdir(), 'purescience-reference-edition-'))
  roots.push(root)
  const client = createProjectDbClient(root)
  await ensureProjectSchema(client)
  return client
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

const createBook = async (client: ReturnType<typeof createProjectDbClient>) => {
  const repository = new ReferenceRepository(async () => client as never)
  return repository.createReference({
    projectId: 'proj-edition',
    title: '机器学习方法',
    authors: [{ name: '李航' }],
    publisher: '清华大学出版社',
    edition: '2',
    year: 2012,
    itemType: 'book',
    citationKey: 'Li2012'
  })
}

describe('reference edition storage', () => {
  it('stores the edition statement and reads it back through the record mapping', async () => {
    const client = await createClient()
    const created = await createBook(client)
    expect(created.edition).toBe('2')

    const repository = new ReferenceRepository(async () => client as never)
    const [read] = await repository.listReferences('proj-edition')
    expect(read?.edition).toBe('2')
  })

  it('adds the column to a database that predates it; rows written before it read as no edition', async () => {
    const client = await createClient()
    const created = await createBook(client)

    // The shape of an installation from before this column: drop it, then let the app's own bootstrap
    // run again, which is exactly what happens on the first launch after an upgrade.
    await client.$executeRawUnsafe('ALTER TABLE "Reference" DROP COLUMN "edition"')
    await ensureProjectSchema(client)

    const repository = new ReferenceRepository(async () => client as never)
    const read = await repository.getReference(created.id)
    // The row survived the migration and the new column is empty on it: "no edition recorded" is not
    // the same reading as "the edition was lost".
    expect(read?.title).toBe('机器学习方法')
    expect(read?.edition).toBeUndefined()
  })
})
