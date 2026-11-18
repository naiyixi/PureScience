import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from './prisma-client'

// Runs the real repair against a COPY of this machine's project database (57 projects, 56 of them with a
// NULL title in the file the previous build left behind). Run explicitly with VITEST_LOCAL=1.
const REAL_DB = join(process.env.HOME ?? '', '.purescience-project', 'purescience.db')

describe.skipIf(!process.env.VITEST_LOCAL)('repair against the real project file', () => {
  it('turns every NULL case title into an empty string', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ps-real-repair-'))
    await copyFile(REAL_DB, join(root, 'purescience.db'))
    const client = createProjectDbClient(root)
    const before = await client.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS n FROM "Project" WHERE "caseTitle" IS NULL`
    )
    await ensureProjectSchema(client)
    const after = await client.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS n FROM "Project" WHERE "caseTitle" IS NULL`
    )
    const rows = await client.project.findMany({ select: { id: true, caseTitle: true }, take: 3 })
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
    console.log(`nulls before=${before[0]?.n} after=${after[0]?.n} sample=${JSON.stringify(rows)}`)
    expect(Number(before[0]?.n)).toBeGreaterThan(0)
    expect(Number(after[0]?.n)).toBe(0)
  })
})
