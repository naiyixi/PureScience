import { describe, expect, it, vi } from 'vitest'

import { ProjectFilesQueryOwner } from './query-owner'

// The Home page's per-project chips derive a file extension and nothing else, yet each read cost two engine
// round-trips — the page query and the origin query. Measured on a real corpus, that fan-out (one read per
// visible project) put 51 slow reads and ~10 s of engine work behind a startup, while a canary query showed
// the engine queue is the shared cost. Callers that do not render origin data can now skip that query, and
// this pins both halves: skipped when asked, unchanged when not.
const row = {
  seq: 2,
  source: 'artifact',
  sourceFileId: 'artifact-1',
  sourceVersionId: 'version-1',
  checksum: null,
  projectId: 'project-1',
  sessionId: 'session-1',
  messageId: null,
  displayName: 'figure.png',
  storageKey: 'artifacts/figure.png',
  mimeType: 'image/png',
  sizeBytes: BigInt(1024),
  mtimeMs: BigInt(1),
  sortAtMs: BigInt(2),
  createdAt: new Date(0),
  updatedAt: new Date(0),
  deletedAt: null,
  deleteOperationId: null
}

const buildOwner = (): {
  owner: ProjectFilesQueryOwner
  findOrigins: ReturnType<typeof vi.fn>
} => {
  const findOrigins = vi.fn(async () => [{ projectId: 'project-1', sessionId: 'session-1' }])
  const client = {
    managedFile: {
      findMany: vi.fn(async () => [row]),
      count: vi.fn(async () => 1)
    },
    fileOriginSession: { findMany: findOrigins }
  }
  const owner = new ProjectFilesQueryOwner(
    () => Promise.resolve(client as never),
    '/tmp/does-not-matter',
    () => true
  )
  return { owner, findOrigins }
}

describe('ProjectFilesQueryOwner.listFiles origin query', () => {
  it('skips the origin query when the caller does not render origin data', async () => {
    const { owner, findOrigins } = buildOwner()
    const page = await owner.listFiles({
      projectId: 'project-1',
      collection: { kind: 'all' },
      limit: 30,
      omitOrigins: true
    })

    expect(findOrigins).not.toHaveBeenCalled()
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ name: 'figure.png', source: 'artifact' })
  })

  it('still reads origin data for callers that render Session attribution', async () => {
    const { owner, findOrigins } = buildOwner()
    await owner.listFiles({ projectId: 'project-1', collection: { kind: 'all' }, limit: 30 })
    expect(findOrigins).toHaveBeenCalledTimes(1)
  })
})
