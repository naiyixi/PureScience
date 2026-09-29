// Fixtures for the RO-Crate exporter tests. They write the SAME durable provenance layout the main
// process publishes, so the tests exercise the real reader instead of a hand-built object graph.

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ArtifactVersionEvidence } from '../../shared/artifact-provenance'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

export type DurableVersionFixture = {
  storageRoot: string
  projectId: string
  appSessionId: string
  artifactId: string
  versionId: string
  versionNumber?: number
  filename: string
  body: string
  contentType?: string
  createdAt?: string
  agentName?: string
  kernelKind?: 'python' | 'r'
  /** Writes it into `.staging/versions/` — the layout a never-published Version lives in. */
  staged?: boolean
  /** Rewrites the bytes after the record is written, so the copy no longer hashes to the checksum. */
  corruptBytes?: string
  /** Drops `content` entirely, leaving a record whose bytes are gone. */
  omitContent?: boolean
}

export const durableVersionPath = (fixture: DurableVersionFixture): string => {
  const versionsRoot = fixture.staged
    ? join(
        fixture.storageRoot,
        'artifacts',
        fixture.projectId,
        fixture.appSessionId,
        '.provenance',
        '.staging',
        'versions'
      )
    : join(
        fixture.storageRoot,
        'artifacts',
        fixture.projectId,
        fixture.appSessionId,
        '.provenance',
        fixture.artifactId,
        'versions'
      )
  return join(versionsRoot, fixture.versionId)
}

/** Writes one published (or staged) Artifact Version in the app's own durable format. */
export const writeDurableVersion = async (fixture: DurableVersionFixture): Promise<string> => {
  const directory = durableVersionPath(fixture)
  await mkdir(directory, { recursive: true })
  const evidence: ArtifactVersionEvidence = {
    schema_version: 1,
    project_id: fixture.projectId,
    app_session_id: fixture.appSessionId,
    artifact_id: fixture.artifactId,
    version_id: fixture.versionId,
    version_number: fixture.versionNumber ?? 1,
    filename: fixture.filename,
    content_type: fixture.contentType ?? 'text/plain',
    size_bytes: fixture.body.length,
    checksum: sha256(fixture.body),
    created_at: fixture.createdAt ?? '2026-09-05T06:31:00.000Z',
    ...(fixture.agentName ? { agent_name: fixture.agentName } : {}),
    conversation: {
      root_frame_id: 'root-frame-1',
      agent_frame_id: 'agent-frame-1',
      message_branch_id: 'branch-1',
      runtime_segment_id: 'segment-1',
      prompt_message_id: 'message-1'
    },
    is_user_upload: false,
    execution_status: { state: 'available' },
    inputs: [],
    producer: {
      state: 'available',
      notebook_session_id: fixture.appSessionId,
      producer_run_id: 'run-1',
      run_index: 0,
      kernel_kind: fixture.kernelKind ?? 'python',
      association_method: 'agent-declared-and-session-validated'
    },
    environment_status: { state: 'unavailable', reason: 'environment-not-supported' }
  }

  await writeFile(join(directory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  if (!fixture.omitContent) {
    await writeFile(join(directory, 'content'), fixture.corruptBytes ?? fixture.body)
  }
  return directory
}

/** Writes raw bytes at an arbitrary path (used to plant a payload the crate must not describe). */
export const writeRawFile = async (path: string, body: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
}
