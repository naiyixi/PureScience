import { describe, expect, it, vi } from 'vitest'

import { createSessionPackageFileLister, uniquePackagePath } from './files'

type Preview = { content: string; encoding: 'utf8'; size: number; truncated: boolean }

const preview = (content: string, truncated = false): Preview => ({
  content,
  encoding: 'utf8' as const,
  size: content.length,
  truncated
})

const lister = (
  entries: { name?: string; path: string; sessionId?: string }[],
  read: (path: string) => Promise<Preview> = async () => preview('BYTES')
): ReturnType<typeof createSessionPackageFileLister> =>
  createSessionPackageFileLister({
    listProjectFiles: async () => entries,
    readPreview: async ({ path }) => read(path),
    maxFileBytes: 1024
  })

describe('session package file listing', () => {
  it('takes only the files the catalog tags with this session', async () => {
    const listing = await lister([
      { name: 'mine.csv', path: 'a/mine.csv', sessionId: 'session-1' },
      { name: 'theirs.csv', path: 'a/theirs.csv', sessionId: 'session-2' }
    ]).describe({ projectId: 'project-1', sessionId: 'session-1' })

    expect(listing.files.map((file: { path: string }): string => file.path)).toEqual([
      'files/mine.csv'
    ])
    expect(listing.total).toBe(1)
  })

  it('never lets a truncated preview pass as the whole file', async () => {
    const listing = await lister(
      [
        { name: 'ok.png', path: 'a/ok.png', sessionId: 'session-1' },
        { name: 'cut.png', path: 'a/cut.png', sessionId: 'session-1' }
      ],
      async (path: string): Promise<Preview> =>
        path.includes('ok') ? preview('FULL') : preview('HE', true)
    ).describe({ projectId: 'project-1', sessionId: 'session-1' })

    expect(listing.files.map((file: { path: string }): string => file.path)).toEqual([
      'files/ok.png'
    ])
    expect(listing.unreadable).toEqual(['files/cut.png'])
    // Both are counted: a file that could not be read is still a file the session has.
    expect(listing.total).toBe(2)
  })

  it('names a file whose read throws instead of dropping it', async () => {
    const listing = await lister([{ path: 'a/ghost.png', sessionId: 'session-1' }], async () => {
      throw new Error('outside artifact storage')
    }).describe({ projectId: 'project-1', sessionId: 'session-1' })

    expect(listing.files).toEqual([])
    expect(listing.unreadable).toEqual(['files/ghost.png'])
  })

  it('counts without reading, so an essential package can name what it left behind', async () => {
    const readPreview = vi.fn(async () => preview('BYTES'))
    const listing = createSessionPackageFileLister({
      listProjectFiles: async () => [
        { name: 'a.csv', path: 'a/a.csv', sessionId: 'session-1' },
        { name: 'b.csv', path: 'a/b.csv', sessionId: 'session-1' }
      ],
      readPreview,
      maxFileBytes: 1024
    })

    await expect(
      listing.countFiles({ projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toBe(2)
    expect(readPreview).not.toHaveBeenCalled()
  })

  it('gives same-named files from different messages distinct paths', () => {
    const used = new Set<string>()
    expect(uniquePackagePath(used, 'results.csv')).toBe('results.csv')
    expect(uniquePackagePath(used, 'results.csv')).toBe('results.csv~2')
    expect(uniquePackagePath(used, 'results.csv')).toBe('results.csv~3')
    expect(uniquePackagePath(new Set<string>(), 'fig/x.png')).toBe('fig_x.png')
  })

  it('reports a catalog it could not read instead of claiming the session has no files', async () => {
    const listing = createSessionPackageFileLister({
      listProjectFiles: async (): Promise<never> => {
        throw new Error('database unavailable')
      },
      readPreview: async () => preview('BYTES'),
      maxFileBytes: 1024
    }).describe({ projectId: 'project-1', sessionId: 'session-1' })

    const result = await listing
    expect(result.status).toBe('unreadable')
    expect(result.total).toBe(0)
  })
})
