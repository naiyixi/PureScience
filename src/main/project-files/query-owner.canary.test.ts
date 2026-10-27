import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectFilesQueryOwner } from './query-owner'
import { sharedLoopHeldWindows } from '../diagnostics/loop-held-windows'

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
    // The CPU half of the same window. Its verdict is whatever the machine did, so only the shape and the
    // vocabulary are pinned here; the verdicts themselves are pinned with an injected source below.
    expect(typeof fields.cpuMs).toBe('number')
    expect(typeof fields.cpuShare).toBe('number')
    expect(['cpu-bound-in-process', 'no-cpu-in-process', 'inconclusive']).toContain(
      fields.attribution as string
    )
  })

  it('says the listFiles window spent no CPU here when the machine was gone, and not why', async () => {
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
    // A suspended machine: the wall clock climbs 600 ms, the process burns nothing at all. Both numbers have to
    // be injected — a real `Date.now()` makes the window as short as the mocked reads, and a zero-length window
    // is `inconclusive` by design, which would make this test pass for the wrong reason.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValue(1_600)
    const cpu = vi.fn().mockReturnValue({ user: 0, system: 0 })
    const owner = new ProjectFilesQueryOwner(
      () => Promise.resolve(client as never),
      '/tmp/does-not-matter',
      () => true,
      cpu
    )

    try {
      await owner.listFiles({
        projectId: 'project-a',
        collection: { kind: 'uploads' },
        limit: 10,
        omitOrigins: true
      } as never)
    } finally {
      nowSpy.mockRestore()
    }

    const [message, fields] = warnSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('listFiles segments were slow')
    expect(fields).toMatchObject({
      totalMs: 600,
      cpuMs: 0,
      cpuShare: 0,
      attribution: 'no-cpu-in-process'
    })
    // Sampled twice around the same window, at the same instant as the two clock readings.
    expect(cpu).toHaveBeenCalledTimes(2)
  })

  // The held/own split reaches this line through the wall-clock bridge, and that is the half a unit test of the
  // bridge cannot prove: the timer measures with `Date.now()`, the ring is written in `performance.now()`, and
  // nothing is injected on either side. Reading the fields back off the emitted line is what makes a deleted
  // spread visible — calling the bridge directly would stay green with the call site gone.
  it('reports the part of its own wall-clock window the loop was held for', async () => {
    process.env.PURESCIENCE_DB_CANARY = '1'
    // The ring drops anything shorter than its own jitter floor (200 ms), so the recorded window is a real one.
    // It also stays clear of that floor: a window of exactly 200 was dropped once, because
    // `(start + 220) - (start + 20)` can land a hair under 200 in floating point. And it is offset into the
    // read, which outlasts it, so the wall clock's whole-millisecond reading cannot clip its tail.
    const heldMs = 250
    const client = {
      $queryRawUnsafe: vi.fn(async () => []),
      managedFile: {
        findMany: vi.fn(async () => {
          // Recorded from inside the read, so the held window sits wholly inside the measured one.
          const start = performance.now()
          sharedLoopHeldWindows.record(start + 20, start + 20 + heldMs)
          await new Promise((resolve) => setTimeout(resolve, heldMs + 70))
          return []
        }),
        count: vi.fn(async () => 0)
      }
    }
    const owner = new ProjectFilesQueryOwner(
      () => Promise.resolve(client as never),
      '/tmp/does-not-matter',
      () => true
    )

    await owner.listFiles({
      projectId: 'project-a',
      collection: { kind: 'uploads' },
      limit: 10,
      omitOrigins: true
    } as never)

    const [message, fields] = warnSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('listFiles segments were slow')
    // The two halves partition the window the line already reports, so a reader never has to add them up from
    // a different clock — and `ownMs` is what remains after the held part, not a second opinion about it.
    expect(fields.heldMs).toBe(heldMs)
    expect(fields.ownMs).toBe(Math.round(fields.totalMs as number) - heldMs)
  })

  // The other slow line in this class reads through a different query, so the spread has to be proven per call
  // site: pinning the fields on one line says nothing about the other.
  it('reports the held part on the project-file kinds line too', async () => {
    process.env.PURESCIENCE_DB_CANARY = '1'
    // Same shape as the case above, for the same reasons: clear of the 200 ms jitter floor (a window of
    // exactly 200 can be dropped by floating-point subtraction) and offset into a read that outlasts it.
    const heldMs = 250
    const client = {
      $queryRawUnsafe: vi.fn(async (query: string) => {
        // The canary (`SELECT 1`) fires first but is only awaited after the window has closed, so slowing it
        // would put the held window outside the measured span and prove nothing. Slow the read itself.
        if (!String(query).includes('SELECT 1')) {
          const start = performance.now()
          sharedLoopHeldWindows.record(start + 20, start + 20 + heldMs)
          await new Promise((resolve) => setTimeout(resolve, heldMs + 70))
        }
        return []
      }),
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

    await owner.listProjectFileKinds({ projectIds: ['project-a'] })

    const [message, fields] = warnSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('project file kinds read was slow')
    expect(fields.heldMs).toBe(heldMs)
    expect(fields.ownMs).toBe(Math.round(fields.totalMs as number) - heldMs)
  })
})
