import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_ARTIFACT_AVAILABILITY_PATHS } from '../../shared/artifacts'
import { ArtifactRunRegistry } from './run-registry'
import { createArtifactHandlers } from './ipc'

// A transcript card asking "is this file still there?" used to be a full preview read: for an Artifact Version
// locator that meant a query, the whole file read and its checksum verified — for a yes/no answer, once per
// card. These pin the batched answer: one query for every locator in the batch, a stat per path, and no
// content resolve at all.
const locator = (versionId: string, artifactId = `artifact-${versionId}`): string =>
  `artifact-version:project-1/session-1/${artifactId}/${versionId}`

let root: string

const buildHandlers = (): {
  handlers: ReturnType<typeof createArtifactHandlers>
  resolveVersionPaths: ReturnType<typeof vi.fn>
  resolveVersionContent: ReturnType<typeof vi.fn>
  resolveManagedFilePath: ReturnType<typeof vi.fn>
} => {
  const resolveVersionPaths = vi.fn(async ({ versionIds }: { versionIds: string[] }) => {
    const paths = new Map<string, string>()
    for (const versionId of versionIds) {
      // 'version-present' resolves to a file that exists; 'version-gone' to one that does not.
      paths.set(versionId, join(root, versionId === 'version-present' ? 'present.txt' : 'gone.txt'))
    }
    return paths
  })
  const resolveVersionContent = vi.fn()
  const resolveManagedFilePath = vi.fn(async ({ path }: { path: string }) => {
    if (path.includes('unresolvable')) throw new Error('outside the artifact root')
    if (path === '/managed/missing.txt') return join(root, 'gone.txt')
    return join(root, 'present.txt')
  })
  const repository = {
    resolveManagedFilePath,
    readManagedFilePreview: vi.fn()
  }
  const handlers = createArtifactHandlers(repository as never, new ArtifactRunRegistry(), {
    provenance: { resolveVersionPaths, resolveVersionContent } as never
  })
  return { handlers, resolveVersionPaths, resolveVersionContent, resolveManagedFilePath }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ps-probe-'))
  await writeFile(join(root, 'present.txt'), 'one byte')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('artifacts probeAvailability', () => {
  it('answers for a session batch in one query and stats each path', async () => {
    const { handlers, resolveVersionPaths, resolveVersionContent } = buildHandlers()

    const result = await handlers.probeAvailability({
      items: [
        { path: locator('version-present'), source: 'artifact', projectId: 'project-1' },
        { path: locator('version-gone'), source: 'artifact', projectId: 'project-1' },
        {
          path: locator('version-present', 'artifact-two'),
          source: 'artifact',
          projectId: 'project-1'
        }
      ]
    })

    // One query for the batch, and the expensive content resolve is never touched.
    expect(resolveVersionPaths).toHaveBeenCalledTimes(1)
    expect(resolveVersionPaths).toHaveBeenCalledWith({
      projectId: 'project-1',
      versionIds: ['version-present', 'version-gone']
    })
    expect(resolveVersionContent).not.toHaveBeenCalled()
    expect(result.unavailable).toEqual([locator('version-gone')])
  })

  it('probes managed paths through the file system and reports the ones that cannot be resolved', async () => {
    const { handlers, resolveVersionPaths } = buildHandlers()

    const result = await handlers.probeAvailability({
      items: [
        { path: '/managed/present.txt', source: 'upload' },
        { path: '/managed/missing.txt', source: 'upload' },
        { path: '/unresolvable/outside.txt', source: 'upload' }
      ]
    })

    // No locator in the batch, so no engine query at all.
    expect(resolveVersionPaths).not.toHaveBeenCalled()
    expect(result.unavailable).toEqual(['/managed/missing.txt', '/unresolvable/outside.txt'])
  })

  it('deduplicates paths, ignores malformed items and refuses an oversized batch', async () => {
    const { handlers, resolveVersionPaths } = buildHandlers()

    const deduped = await handlers.probeAvailability({
      items: [
        { path: locator('version-present'), source: 'artifact' },
        { path: locator('version-present'), source: 'artifact' },
        { path: '', source: 'artifact' },
        { path: locator('version-present'), source: 'nonsense' as never }
      ]
    })
    expect(deduped.unavailable).toEqual([])
    expect(resolveVersionPaths).toHaveBeenCalledWith({
      projectId: 'project-1',
      versionIds: ['version-present']
    })

    await expect(
      handlers.probeAvailability({
        items: Array.from({ length: MAX_ARTIFACT_AVAILABILITY_PATHS + 1 }, (_, index) => ({
          path: `/managed/file-${index}.txt`,
          source: 'upload' as const
        }))
      })
    ).rejects.toThrow(new RegExp(`at most ${MAX_ARTIFACT_AVAILABILITY_PATHS}`, 'i'))
  })

  it('answers an empty batch without touching the file system or the engine', async () => {
    const { handlers, resolveVersionPaths, resolveManagedFilePath } = buildHandlers()

    await expect(handlers.probeAvailability({ items: [] })).resolves.toEqual({ unavailable: [] })
    expect(resolveVersionPaths).not.toHaveBeenCalled()
    expect(resolveManagedFilePath).not.toHaveBeenCalled()
  })
})
