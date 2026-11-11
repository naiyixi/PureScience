import { describe, expect, it } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  extractSessionFiles,
  isFileProjectionCurrent,
  type ProjectFilesClient
} from './mutation-projection'

type Lineage = { id: string }
type Version = { id: string; artifactId: string; state: string; versionNumber: number }
type Row = {
  source: string
  sourceFileId: string
  sourceVersionId: string | null
  sessionId: string
  storageKey: string
}

/**
 * The projection check used to ask for each lineage's latest finalized Version with a nested `include`,
 * which pulls every scalar column including the provenance JSON (`evidenceJson` alone is 1.2 MB across 31
 * versions on a copy of the real corpus: 16-17 ms p50 versus 0.3-0.5 ms for the four columns the check
 * reads). A slow-save line cannot tell payload cost apart from waiting, so the shape is pinned here: one
 * read for the lineages, one for their versions, no per-lineage round-trip.
 */
const createClient = (
  lineages: Lineage[],
  versions: Version[],
  rows: Row[]
): {
  client: ProjectFilesClient
  calls: string[]
} => {
  const calls: string[] = []
  const client = {
    artifactLineage: {
      findMany: async (): Promise<Lineage[]> => {
        calls.push('artifactLineage.findMany')
        return lineages
      }
    },
    artifactVersion: {
      findMany: async (args: {
        where: { artifactId: { in: string[] }; state: string }
        orderBy: { versionNumber: 'desc' }[] | unknown
      }): Promise<{ id: string; artifactId: string }[]> => {
        calls.push(`artifactVersion.findMany:${args.where.artifactId.in.length}`)
        return versions
          .filter(
            (version) =>
              version.state === args.where.state &&
              args.where.artifactId.in.includes(version.artifactId)
          )
          .sort(
            (left, right) =>
              right.versionNumber - left.versionNumber || right.id.localeCompare(left.id)
          )
          .map((version) => ({ id: version.id, artifactId: version.artifactId }))
      }
    },
    managedFile: {
      findMany: async (): Promise<Row[]> => {
        calls.push('managedFile.findMany')
        return rows
      }
    },
    uploadFile: {
      findMany: async (): Promise<{ id: string }[]> => {
        calls.push('uploadFile.findMany')
        return []
      }
    }
  } as unknown as ProjectFilesClient
  return { client, calls }
}

const row = (sourceFileId: string, sourceVersionId: string): Row => ({
  source: 'artifact',
  sourceFileId,
  sourceVersionId,
  sessionId: 'session-a',
  storageKey: `artifacts/p/s/${sourceFileId}`
})

describe('isFileProjectionCurrent', () => {
  it('reads every lineage in one pass and decides from the latest finalized version of each', async () => {
    const versions: Version[] = [
      // Deliberately out of order, and with a newer unfinalized row that must not win.
      { id: 'b-v2', artifactId: 'lineage-b', state: 'finalized', versionNumber: 2 },
      { id: 'a-v1', artifactId: 'lineage-a', state: 'finalized', versionNumber: 1 },
      { id: 'a-v3-staging', artifactId: 'lineage-a', state: 'staging', versionNumber: 3 },
      { id: 'a-v2', artifactId: 'lineage-a', state: 'finalized', versionNumber: 2 }
    ]
    const { client, calls } = createClient([{ id: 'lineage-a' }, { id: 'lineage-b' }], versions, [
      row('lineage-a', 'a-v2'),
      row('lineage-b', 'b-v2')
    ])

    await expect(isFileProjectionCurrent(client, 'project-a', 'session-a')).resolves.toBe(true)
    // The two leading reads are started together, so only their set is stable; the version read comes after
    // the lineage ids exist, and there is exactly one of it however many lineages there are.
    expect([...calls].sort()).toEqual([
      'artifactLineage.findMany',
      'artifactVersion.findMany:2',
      'managedFile.findMany'
    ])
  })

  it('answers stale when a row still points at an older finalized version', async () => {
    const versions: Version[] = [
      { id: 'a-v1', artifactId: 'lineage-a', state: 'finalized', versionNumber: 1 },
      { id: 'a-v2', artifactId: 'lineage-a', state: 'finalized', versionNumber: 2 }
    ]
    const { client } = createClient([{ id: 'lineage-a' }], versions, [row('lineage-a', 'a-v1')])

    await expect(isFileProjectionCurrent(client, 'project-a', 'session-a')).resolves.toBe(false)
  })

  it('answers stale when a lineage has no finalized version but a row claims one', async () => {
    const versions: Version[] = [
      { id: 'a-v1-staging', artifactId: 'lineage-a', state: 'staging', versionNumber: 1 }
    ]
    const { client } = createClient([{ id: 'lineage-a' }], versions, [row('lineage-a', 'a-v1')])

    await expect(isFileProjectionCurrent(client, 'project-a', 'session-a')).resolves.toBe(false)
  })
})

// The reprojection path reads the same wide rows through `include`, and it needs nearly the same columns,
// so the only thing that keeps it cheap is asking for exactly those: an `Include` drags `evidenceJson` /
// `executionSnapshotJson` per version, which on the real corpus is what turned a 0.5 ms answer into 17-23 ms.
type Recorded = {
  lineage?: { select?: Record<string, unknown>; include?: unknown }
  upload?: { select?: Record<string, unknown>; include?: unknown }
}

const PROVENANCE_ONLY_COLUMNS = [
  'evidenceJson',
  'evidenceStorageKey',
  'evidenceChecksum',
  'evidenceSchemaVersion',
  'executionSnapshotJson',
  'executionSnapshotStorageKey',
  'executionSnapshotChecksum',
  'executionSnapshotSchemaVersion'
]

const createExtractClient = (
  withUpload: boolean
): { client: ProjectFilesClient; recorded: Recorded } => {
  const recorded: Recorded = {}
  const createdAt = new Date('2026-11-11T00:00:00Z')
  const client = {
    artifactLineage: {
      findMany: async (args: unknown): Promise<unknown> => {
        recorded.lineage = args as Recorded['lineage']
        return [
          {
            id: 'lineage-a',
            filename: 'lineage-fallback.csv',
            versions: [
              {
                id: 'version-a',
                checksum: 'sha-a',
                messageId: 'message-a',
                filename: 'result.csv',
                contentType: 'text/csv',
                sizeBytes: BigInt(12),
                createdAt,
                contentStorageKey: 'artifacts/p/s/x/content'
              }
            ]
          }
        ]
      }
    },
    uploadFile: {
      findFirst: async (args: unknown): Promise<unknown> => {
        recorded.upload = args as Recorded['upload']
        if (!withUpload) return null
        return {
          id: 'upload-a',
          versions: [
            {
              id: 'upload-version-a',
              checksum: 'sha-u',
              originalFilename: 'sample.fasta',
              filename: 'stored.fasta',
              contentStorageKey: 'uploads/p/up/v/content',
              contentType: 'text/plain',
              sizeBytes: BigInt(34),
              createdAt
            }
          ]
        }
      }
    }
  } as unknown as ProjectFilesClient
  return { client, recorded }
}

const session = (withUpload: boolean): PersistedChatSession =>
  ({
    id: 'session-a',
    projectId: 'project-a',
    title: 'probe',
    cwd: '/tmp',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messages: withUpload
      ? [
          {
            id: 'message-a',
            role: 'user',
            content: 'here',
            createdAt: 1,
            updatedAt: 1,
            uploads: [
              {
                id: 'upload-a',
                sessionId: 'session-a',
                versionId: 'upload-version-a',
                path: '/tmp/sample.fasta'
              }
            ]
          }
        ]
      : [],
    artifacts: []
  }) as unknown as PersistedChatSession

describe('extractSessionFiles read projection', () => {
  it('asks for the Files tile columns instead of every column on the lineage version', async () => {
    const { client, recorded } = createExtractClient(false)

    await extractSessionFiles(async () => client, '/data', session(false))

    expect(recorded.lineage?.include).toBeUndefined()
    const versions = recorded.lineage?.select?.versions as { select?: Record<string, unknown> }
    expect(versions.select).toMatchObject({
      id: true,
      checksum: true,
      messageId: true,
      filename: true,
      contentType: true,
      sizeBytes: true,
      createdAt: true,
      contentStorageKey: true
    })
    for (const column of PROVENANCE_ONLY_COLUMNS) {
      expect(versions.select).not.toHaveProperty(column)
    }
  })

  it('keeps every projected field populated from that narrow read', async () => {
    const { client } = createExtractClient(false)

    const extraction = await extractSessionFiles(async () => client, '/data', session(false))

    expect(extraction.errors).toEqual([])
    expect(extraction.files).toEqual([
      {
        source: 'artifact',
        sourceFileId: 'lineage-a',
        sourceVersionId: 'version-a',
        checksum: 'sha-a',
        projectId: 'project-a',
        sessionId: 'session-a',
        messageId: 'message-a',
        displayName: 'result.csv',
        storageKey: 'artifacts/p/s/x/content',
        mimeType: 'text/csv',
        sizeBytes: BigInt(12),
        mtimeMs: BigInt(Date.parse('2026-11-11T00:00:00Z')),
        sortAtMs: BigInt(Date.parse('2026-11-11T00:00:00Z'))
      }
    ])
  })

  it('projects the upload version read the same way', async () => {
    const { client, recorded } = createExtractClient(true)

    const extraction = await extractSessionFiles(async () => client, '/data', session(true))

    expect(recorded.upload?.include).toBeUndefined()
    const versions = recorded.upload?.select?.versions as { select?: Record<string, unknown> }
    expect(versions.select).toMatchObject({
      id: true,
      checksum: true,
      originalFilename: true,
      filename: true,
      contentStorageKey: true,
      contentType: true,
      sizeBytes: true,
      createdAt: true
    })
    const uploadFile = extraction.files.find((file) => file.source === 'upload')
    expect(uploadFile).toMatchObject({
      sourceFileId: 'upload-a',
      sourceVersionId: 'upload-version-a',
      checksum: 'sha-u',
      displayName: 'sample.fasta',
      storageKey: 'uploads/p/up/v/content',
      mimeType: 'text/plain',
      sizeBytes: BigInt(34),
      sessionId: 'session-a'
    })
  })
})
