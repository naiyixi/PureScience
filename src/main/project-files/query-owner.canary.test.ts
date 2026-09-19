import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectFilesQueryOwner } from './query-owner'

// U11 proved a slow read here can be waiting on the shared Prisma engine rather than on its own query, and the
// only way to tell those apart is the canary: a trivial `SELECT 1` started at the same moment and awaited
// after the read. It is a second trip into the very queue it measures, so these pin both halves of the
// bargain — off by default (no extra query, no extra log line) and, when switched on, paying for the canary
// and reporting it.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }))
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn() })
}))

const buildOwner = (
  rows: unknown[]
): { owner: ProjectFilesQueryOwner; raw: ReturnType<typeof vi.fn>; client: unknown } => {
  const raw = vi.fn(async () => rows)
  const client = {
    $queryRawUnsafe: raw,
    managedFile: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0)
    }
  }
  const owner = new ProjectFilesQueryOwner(
    () => Promise.resolve(client as never),
    '/tmp/does-not-matter',
    () => true
  )
  return { owner, raw, client }
}

afterEach(() => {
  delete process.env.PURESCIENCE_DB_CANARY
  warnSpy.mockClear()
})

describe('ProjectFilesQueryOwner engine-queue canary', () => {
  it('costs nothing when the canary is off: one query, no report', async () => {
    const { owner, raw } = buildOwner([])

    await owner.listProjectFileKinds({ projectIds: ['project-a'] })

    expect(raw).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('pays for a second trivial query and reports its latency when the canary is on', async () => {
    process.env.PURESCIENCE_DB_CANARY = '1'
    const { owner, raw } = buildOwner([
      { projectId: 'project-a', displayName: 'newest.png', sortAtMs: 9 }
    ])

    await expect(owner.listProjectFileKinds({ projectIds: ['project-a'] })).resolves.toEqual([
      { projectId: 'project-a', kinds: ['PNG'] }
    ])

    const sqls = raw.mock.calls.map(([sql]) => sql as string)
    expect(sqls).toHaveLength(2)
    // The canary starts first and is awaited after the read — that ordering is what makes it a reading of the
    // queue the read itself sat in.
    expect(sqls[0]).toBe('SELECT 1')
    expect(sqls[1]).toContain('ROW_NUMBER() OVER (PARTITION BY projectId')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [message, fields] = warnSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('project file kinds read was slow')
    expect(typeof fields.dbCanaryMs).toBe('number')
    expect(fields.dbCanaryMs as number).toBeGreaterThanOrEqual(0)
  })

  it('carries the canary on the listFiles report too, and leaves the page untouched', async () => {
    process.env.PURESCIENCE_DB_CANARY = '1'
    const rows = [
      {
        seq: 2,
        source: 'artifact',
        sourceFileId: 'artifact-1',
        sourceVersionId: 'version-1',
        checksum: null,
        projectId: 'project-a',
        sessionId: 'session-a',
        messageId: null,
        displayName: 'table.csv',
        storageKey: 'artifacts/table.csv',
        mimeType: 'text/csv',
        sizeBytes: BigInt(1024),
        mtimeMs: BigInt(1),
        sortAtMs: BigInt(2),
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
        deleteOperationId: null
      }
    ]
    const raw = vi.fn(async () => [])
    const client = {
      $queryRawUnsafe: raw,
      managedFile: { findMany: vi.fn(async () => rows), count: vi.fn(async () => 1) }
    }
    const owner = new ProjectFilesQueryOwner(
      () => Promise.resolve(client as never),
      '/tmp/does-not-matter',
      () => true
    )

    const page = await owner.listFiles({
      projectId: 'project-a',
      collection: { kind: 'uploads' },
      limit: 10,
      omitOrigins: true
    } as never)

    expect(page.totalCount).toBe(1)
    expect(page.items).toHaveLength(1)
    expect(raw.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual(['SELECT 1'])
    const [message, fields] = warnSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('listFiles segments were slow')
    expect(typeof fields.dbCanaryMs).toBe('number')
    expect(fields.rows).toBe(1)
  })
})
