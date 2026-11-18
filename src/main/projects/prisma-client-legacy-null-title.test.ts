import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from './prisma-client'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ps-legacy-null-title-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// A project row written by an early build can carry a NULL `caseTitle`. The current column is NOT NULL, so
// Prisma fails the whole read with "found incompatible value of null" and the home screen loses every
// project. Ensuring the schema has to repair those rows, not just create the column.
describe('project schema repair for legacy NULL case titles', () => {
  it('backfills NULL caseTitle rows so the project list can be read', async () => {
    const legacy = createProjectDbClient(root)
    await legacy.$executeRawUnsafe(
      `CREATE TABLE "Project" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "caseTitle" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    )
    await legacy.$executeRawUnsafe(
      `INSERT INTO "Project" ("id", "name", "caseTitle") VALUES ('legacy-1', '旧项目', NULL)`
    )
    await legacy.$disconnect()

    const client = createProjectDbClient(root)
    await ensureProjectSchema(client)

    const rows = await client.project.findMany({ select: { id: true, caseTitle: true } })
    expect(rows).toEqual([{ id: 'legacy-1', caseTitle: '' }])

    // The repair is a one-time backfill, not a per-read patch: a second ensure must change nothing.
    await ensureProjectSchema(client)
    const again = await client.project.findMany({ select: { id: true, caseTitle: true } })
    expect(again).toEqual([{ id: 'legacy-1', caseTitle: '' }])

    await client.$disconnect()
  })
})
