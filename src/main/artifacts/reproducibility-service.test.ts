import { describe, expect, it, vi } from 'vitest'

import type { ArtifactVersionProvenance } from '../../shared/artifact-provenance'
import {
  REPRODUCIBILITY_MAX_COMPARE_BYTES,
  type ArtifactReproducibilityCheckRequest
} from '../../shared/reproducibility'
import {
  createArtifactReproducibilityService,
  type ArtifactReproducibilityServiceOptions
} from './reproducibility-service'

const VERSION_SHA = 'a'.repeat(64)
const INPUT_SHA = 'c'.repeat(64)

const provenance = (): ArtifactVersionProvenance => ({
  descriptor: {
    id: 'version-1',
    artifactId: 'artifact-1',
    versionId: 'version-1',
    versionNumber: 1,
    checksum: VERSION_SHA,
    createdAt: '2026-08-06T00:00:00.000Z',
    state: 'finalized',
    projectName: 'project-1',
    sessionId: 'session-1',
    runId: 'artifact-run-1',
    name: 'cos.png',
    size: 8,
    mtimeMs: 1
  },
  contentStatus: { state: 'available' },
  evidence: {
    schema_version: 1,
    project_id: 'project-1',
    app_session_id: 'session-1',
    artifact_id: 'artifact-1',
    version_id: 'version-1',
    version_number: 1,
    filename: 'cos.png',
    content_type: 'image/png',
    size_bytes: 8,
    checksum: VERSION_SHA,
    created_at: '2026-08-06T00:00:00.000Z',
    conversation: {
      root_frame_id: 'root-1',
      agent_frame_id: 'agent-1',
      message_branch_id: 'branch-1',
      runtime_segment_id: 'segment-1',
      prompt_message_id: 'prompt-1'
    },
    is_user_upload: false,
    execution_status: { state: 'available' },
    inputs: [
      {
        ordinal: 0,
        input_file_version_id: 'upload-version-1',
        source_kind: 'upload-version',
        source_file_id: 'upload-1',
        source_version_number: 1,
        source_created_at: '2026-08-05T23:00:00.000Z',
        source_project_id: 'project-1',
        source_session_id: 'session-1',
        filename: 'groups.csv',
        content_type: 'text/csv',
        size_bytes: 20,
        checksum: INPUT_SHA,
        storage_key: 'uploads/project-1/groups.csv',
        strongest_association: 'resolver-accessed'
      }
    ],
    producer: {
      state: 'available',
      notebook_session_id: 'session-1',
      producer_run_id: 'run-2',
      run_index: 2,
      kernel_kind: 'python',
      association_method: 'agent-declared-and-session-validated'
    },
    environment: {
      capture_kind: 'completed-run',
      environment_name: 'python',
      runtime_version: '3.13.5',
      runtime_source: 'managed',
      kernel_kind: 'python',
      platform: 'darwin',
      architecture: 'arm64',
      packages: [
        {
          name: 'pandas',
          version: '2.3.1',
          version_status: 'known',
          ecosystem: 'python',
          evidence_sources: ['python-importlib-metadata'],
          loaded_state: 'loaded'
        }
      ],
      inventory_sources: ['interpreter-native'],
      installed_inventory: {
        captured_at: '2026-08-06T00:00:00.000Z',
        source: 'full-scan',
        validation: 'full-scan'
      },
      captured_at: '2026-08-06T00:00:00.000Z',
      source_manifest_checksum: 'd'.repeat(64),
      complete: true,
      capture_status: 'complete'
    },
    environment_status: { state: 'available' }
  },
  execution: {
    schemaVersion: 2,
    rootFrameId: 'root-1',
    agentFrameId: 'agent-1',
    messageBranchId: 'branch-1',
    terminalPromptMessageId: 'prompt-1',
    producerRunId: 'run-2',
    producerRunIndex: 2,
    createdAt: '2026-08-06T00:00:00.000Z',
    inputFiles: [
      {
        inputFileVersionId: 'upload-version-1',
        sourceKind: 'upload-version',
        sourceFileId: 'upload-1',
        sourceProjectId: 'project-1',
        sourceSessionId: 'session-1',
        filename: 'groups.csv',
        sizeBytes: 20,
        checksum: INPUT_SHA,
        association: 'resolver-accessed',
        availability: { state: 'available' }
      }
    ],
    runs: [
      {
        runId: 'run-2',
        runIndex: 2,
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'segment-1',
        promptMessageId: 'prompt-1',
        kernelKind: 'python',
        environmentName: 'python',
        script: 'import matplotlib.pyplot as plt\nplt.plot([1, 2])\nplt.savefig("cos.png")',
        status: 'completed',
        startedAt: '2026-08-06T00:00:00.000Z',
        completedAt: '2026-08-06T00:00:01.000Z',
        outputs: [{ type: 'text', text: 'saved cos.png' }],
        inputFileVersionKeys: [
          { sourceKind: 'upload-version', inputFileVersionId: 'upload-version-1' }
        ]
      }
    ]
  },
  messages: { state: 'unavailable', reason: 'not-loaded' },
  review: { state: 'unavailable', reason: 'not-loaded' }
})

const request = (
  overrides: Partial<ArtifactReproducibilityCheckRequest> = {}
): ArtifactReproducibilityCheckRequest => ({
  projectId: 'project-1',
  appSessionId: 'session-1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  reexecuted: false,
  reproducedFiles: ['/workspace/rerun/cos.png'],
  allowedImportRoots: ['/workspace'],
  ...overrides
})

const compareTwoFiles = vi.fn(async (path: string) => ({
  state: 'observed' as const,
  path,
  filename: path.split('/').at(-1) ?? path,
  sizeBytes: path.endsWith('groups.csv') ? 20 : 8,
  sha256: path.endsWith('groups.csv') ? INPUT_SHA : VERSION_SHA
}))

const harness = (
  overrides: Partial<ArtifactReproducibilityServiceOptions> = {}
): {
  service: ReturnType<typeof createArtifactReproducibilityService>
  observeFile: ArtifactReproducibilityServiceOptions['observeFile']
} => {
  const defaultObserveFile = vi.fn(async (path: string) => ({
    state: 'observed' as const,
    path,
    filename: path.split('/').at(-1) ?? path,
    sizeBytes: 8,
    sha256: VERSION_SHA
  }))
  const service = createArtifactReproducibilityService({
    getVersionProvenance: async () => provenance(),
    observeFile: defaultObserveFile,
    now: () => new Date('2026-09-13T00:00:00.000Z'),
    ...overrides
  })

  return { service, observeFile: overrides.observeFile ?? defaultObserveFile }
}

describe('createArtifactReproducibilityService', () => {
  it('reports a byte match without re-execution as bytes-match, never reproduced', async () => {
    const { service } = harness()
    const report = await service.check(request())

    expect(report.verdict).toBe('bytes-match')
    expect(report.evidenceKind).toBe('external-bytes')
    expect(report.requiredLabels).toContain('external-bytes-no-reexecution')
    expect(report.counts).toEqual({ compared: 1, identical: 1, mismatched: 0, notCompared: 0 })
    expect(report.checkedAt).toBe('2026-09-13T00:00:00.000Z')
  })

  it('reports reproduction only when the app re-executed the sealed recipe', async () => {
    const { service } = harness()
    const report = await service.check(request({ reexecuted: true }))

    expect(report.verdict).toBe('reproduced')
    expect(report.evidenceKind).toBe('app-reexecution')
    expect(report.requiredLabels).not.toContain('external-bytes-no-reexecution')
  })

  it('compares declared recipe inputs as well as the Version file', async () => {
    const { service, observeFile } = harness({ observeFile: compareTwoFiles })
    const report = await service.check(
      request({
        reexecuted: true,
        reproducedFiles: ['/workspace/rerun/cos.png', '/workspace/rerun/groups.csv']
      })
    )

    expect(observeFile).toHaveBeenCalledTimes(2)
    expect(report.verdict).toBe('reproduced')
    expect(report.comparisons.map((comparison) => comparison.outcome)).toEqual([
      'identical',
      'identical'
    ])
  })

  it('fails the check on a content mismatch', async () => {
    const { service } = harness({
      observeFile: vi.fn(async (path: string) => ({
        state: 'observed' as const,
        path,
        filename: 'cos.png',
        sizeBytes: 8,
        sha256: 'e'.repeat(64)
      }))
    })
    const report = await service.check(request({ reexecuted: true }))

    expect(report.verdict).toBe('not-reproduced')
    expect(report.counts.mismatched).toBe(1)
  })

  it('turns an unreadable reproduction into a per-file not-compared outcome', async () => {
    const { service } = harness({
      observeFile: vi.fn(async (path: string) => ({
        state: 'unreadable' as const,
        path,
        filename: 'cos.png',
        reason: 'not-found' as const
      }))
    })
    const report = await service.check(request({ reexecuted: true }))

    expect(report.comparisons[0].outcome).toBe('not-compared')
    expect(report.comparisons[0].reason).toBe('reproduction-file-missing')
    expect(report.verdict).toBe('inconclusive')
  })

  it('does not credit a file the sealed recipe has no counterpart for', async () => {
    const { service } = harness({
      observeFile: vi.fn(async (path: string) => ({
        state: 'observed' as const,
        path,
        filename: 'unrelated.csv',
        sizeBytes: 8,
        sha256: VERSION_SHA
      }))
    })
    const report = await service.check(request({ reexecuted: true }))

    expect(report.comparisons[0].reason).toBe('no-counterpart-in-recipe')
    expect(report.verdict).toBe('inconclusive')
  })

  it('withholds a verdict when the compared file exceeds the byte bound', async () => {
    const { service } = harness({
      observeFile: vi.fn(async (path: string) => ({
        state: 'observed' as const,
        path,
        filename: 'cos.png',
        sizeBytes: REPRODUCIBILITY_MAX_COMPARE_BYTES + 1,
        sha256: VERSION_SHA
      }))
    })
    const report = await service.check(request({ reexecuted: true }))

    expect(report.verdict).toBe('inconclusive')
    expect(report.requiredLabels).toContain('partial-comparison')
    expect(report.reasons).toContain('comparison-bound-exceeded')
  })

  it('refuses to grade a check when the recipe is not sealed', async () => {
    const value = provenance()
    const { service } = harness({
      getVersionProvenance: async () => ({ ...value, execution: undefined })
    })
    const report = await service.check(request({ reexecuted: true }))

    expect(report.recipe.sealed).toBe(false)
    expect(report.verdict).toBe('not-checkable')
    expect(report.requiredLabels).toContain('recipe-not-sealed')
  })

  it('reports no reproduced files instead of inventing a pass', async () => {
    const { service } = harness()
    const report = await service.check(request({ reproducedFiles: [] }))

    expect(report.comparisons).toEqual([])
    expect(report.verdict).toBe('not-checkable')
    expect(report.reasons).toContain('no-reproduced-files')
  })

  it('rejects an unknown Version instead of grading it', async () => {
    const { service } = harness({ getVersionProvenance: async () => undefined })

    await expect(service.check(request())).rejects.toThrow(
      'Artifact Version not found in this Project and Session.'
    )
  })

  it('bounds how many files one check may compare', async () => {
    const { service } = harness()

    await expect(
      service.check(
        request({ reproducedFiles: Array.from({ length: 201 }, (_, i) => `/w/f${i}.png`) })
      )
    ).rejects.toThrow('At most 200 reproduced files may be compared in one check.')
  })
})
