import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from './prisma-client'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ps-journal-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// P0-10③ first step: the slow `SELECT 1` canary (median 47 ms, p90 346 ms) has the shape of readers waiting
// behind a writer's journal lock. WAL removes that wait; this test pins the pragma on a real SQLite file so a
// later refactor cannot silently drop it back to the default rollback journal.
describe('project database journal mode', () => {
  it('runs in WAL with a busy timeout after the schema is ensured', async () => {
    const client = createProjectDbClient(root)
    await ensureProjectSchema(client)

    const journal = (await client.$queryRawUnsafe('PRAGMA journal_mode')) as {
      journal_mode: string
    }[]
    const busy = (await client.$queryRawUnsafe('PRAGMA busy_timeout')) as { timeout: number }[]

    expect(journal[0]?.journal_mode.toLowerCase()).toBe('wal')
    expect(Number(busy[0]?.timeout)).toBe(5000)
    // The sidecar file is the visible consequence: anything that copies the database must account for it.
    expect(existsSync(join(root, 'purescience.db-wal'))).toBe(true)

    await client.$disconnect()
  })
})
