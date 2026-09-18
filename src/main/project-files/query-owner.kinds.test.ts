import { describe, expect, it, vi } from 'vitest'

import { ProjectFilesQueryOwner } from './query-owner'

// The batched kinds read exists so the Home page's chips cost one engine round-trip instead of one per visible
// project (measured: 48 slow reads at startup, and U11 showed every query in the process queues behind the same
// engine). These pin the shape of that single query and the per-project semantics.
const buildOwner = (
  rows: unknown[]
): { owner: ProjectFilesQueryOwner; raw: ReturnType<typeof vi.fn> } => {
  const raw = vi.fn(async () => rows)
  const client = { $queryRawUnsafe: raw }
  const owner = new ProjectFilesQueryOwner(
    () => Promise.resolve(client as never),
    '/tmp/does-not-matter',
    () => true
  )
  return { owner, raw }
}

describe('ProjectFilesQueryOwner.listProjectFileKinds', () => {
  it('answers for many projects in one query and derives kinds per project', async () => {
    const { owner, raw } = buildOwner([
      { projectId: 'project-a', displayName: 'newest.png', sortAtMs: 9 },
      { projectId: 'project-a', displayName: 'older.pdf', sortAtMs: 8 },
      { projectId: 'project-b', displayName: 'notes.csv', sortAtMs: 7 }
    ])

    const summaries = await owner.listProjectFileKinds({ projectIds: ['project-a', 'project-b'] })

    expect(raw).toHaveBeenCalledTimes(1)
    expect(summaries).toEqual([
      { projectId: 'project-a', kinds: ['PNG', 'PDF'] },
      { projectId: 'project-b', kinds: ['CSV'] }
    ])
    // The newest-first rule still decides which kinds survive the cap, so the query must return sortAtMs.
    const [sql, ...parameters] = raw.mock.calls[0] as [string, ...unknown[]]
    expect(sql).toContain(
      'ROW_NUMBER() OVER (PARTITION BY projectId ORDER BY sortAtMs DESC, seq DESC)'
    )
    expect(sql).toContain('deletedAt IS NULL')
    expect(parameters.slice(0, 2)).toEqual(['project-a', 'project-b'])
  })

  it('reports an empty kind list for a project with no files, and reads nothing for no projects', async () => {
    const { owner, raw } = buildOwner([])
    await expect(owner.listProjectFileKinds({ projectIds: ['project-a'] })).resolves.toEqual([
      { projectId: 'project-a', kinds: [] }
    ])
    expect(raw).toHaveBeenCalledTimes(1)

    const empty = buildOwner([])
    await expect(empty.owner.listProjectFileKinds({ projectIds: [] })).resolves.toEqual([])
    expect(empty.raw).not.toHaveBeenCalled()
  })

  it('deduplicates projects, rejects blank identifiers and caps the batch', async () => {
    const { owner, raw } = buildOwner([])

    await owner.listProjectFileKinds({ projectIds: ['project-a', 'project-a'] })
    const [, ...parameters] = raw.mock.calls[0] as [string, ...unknown[]]
    expect(parameters.slice(0, 1)).toEqual(['project-a'])

    await expect(owner.listProjectFileKinds({ projectIds: ['  '] })).rejects.toThrow(
      /projectId is required/
    )
    await expect(
      owner.listProjectFileKinds({ projectIds: Array.from({ length: 101 }, (_, i) => `p-${i}`) })
    ).rejects.toThrow(/at most 100/)
  })
})
