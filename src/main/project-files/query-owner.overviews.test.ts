import { describe, expect, it, vi } from 'vitest'

import { ProjectFilesQueryOwner } from './query-owner'

// The batched overview read exists because the Home page's user-case section ranks every project that ran by
// what it produced: asking per project put four count queries per project into the same engine queue the rest
// of the page waits in. These pin that the batch costs two queries in total and answers per-project numbers
// identical to `getOverview`.
const buildOwner = (
  counts: unknown[],
  groups: unknown[]
): { owner: ProjectFilesQueryOwner; raw: ReturnType<typeof vi.fn> } => {
  const raw = vi.fn(async (sql: string) =>
    String(sql).includes('ManagedFileSessionSync') ? groups : counts
  )
  const client = { $queryRawUnsafe: raw }
  const owner = new ProjectFilesQueryOwner(
    () => Promise.resolve(client as never),
    '/tmp/does-not-matter',
    (projectId: string) => projectId !== 'incomplete'
  )
  return { owner, raw }
}

describe('ProjectFilesQueryOwner.getOverviews', () => {
  it('answers for many projects with two grouped queries', async () => {
    const { owner, raw } = buildOwner(
      [
        { projectId: 'project-a', totalCount: 6n, uploadCount: 1n, artifactCount: 5n },
        { projectId: 'project-b', totalCount: 2n, uploadCount: 0n, artifactCount: 2n }
      ],
      [{ projectId: 'project-a', artifactGroupCount: 2n }]
    )

    const entries = await owner.getOverviews({ projectIds: ['project-a', 'project-b'] })

    expect(raw).toHaveBeenCalledTimes(2)
    expect(entries).toEqual([
      {
        projectId: 'project-a',
        totalCount: 6,
        uploadCount: 1,
        artifactCount: 5,
        artifactGroupCount: 2,
        isIndexComplete: true
      },
      {
        projectId: 'project-b',
        totalCount: 2,
        uploadCount: 0,
        artifactCount: 2,
        artifactGroupCount: 0,
        isIndexComplete: true
      }
    ])
    const [countsSql, ...countsParameters] = raw.mock.calls[0] as [string, ...unknown[]]
    expect(countsSql).toContain('GROUP BY projectId')
    expect(countsSql).toContain('deletedAt IS NULL')
    expect(countsParameters).toEqual(['project-a', 'project-b'])
  })

  it('reports zeros for a project with no files instead of dropping it', async () => {
    const { owner } = buildOwner([], [])
    const entries = await owner.getOverviews({ projectIds: ['project-empty'] })

    expect(entries).toEqual([
      {
        projectId: 'project-empty',
        totalCount: 0,
        uploadCount: 0,
        artifactCount: 0,
        artifactGroupCount: 0,
        isIndexComplete: true
      }
    ])
  })

  it('carries the index-completeness answer per project, so a partial catalogue is never read as empty', async () => {
    const { owner } = buildOwner(
      [{ projectId: 'incomplete', totalCount: 3n, uploadCount: 0n, artifactCount: 3n }],
      []
    )
    const [entry] = await owner.getOverviews({ projectIds: ['incomplete'] })

    expect(entry?.isIndexComplete).toBe(false)
    expect(entry?.artifactCount).toBe(3)
  })

  it('deduplicates identifiers, rejects blanks and caps the batch', async () => {
    const { owner, raw } = buildOwner([], [])

    await owner.getOverviews({ projectIds: ['project-a', 'project-a'] })
    const [countsSql, ...parameters] = raw.mock.calls[0] as [string, ...unknown[]]
    expect(parameters).toEqual(['project-a'])
    expect(countsSql.match(/\?/g)).toHaveLength(1)

    await expect(owner.getOverviews({ projectIds: ['  '] })).rejects.toThrow()
    await expect(
      owner.getOverviews({ projectIds: Array.from({ length: 101 }, (_, index) => `p-${index}`) })
    ).rejects.toThrow(/at most 100 projects/)
    await expect(owner.getOverviews({ projectIds: [] })).resolves.toEqual([])
  })
})
