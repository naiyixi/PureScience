import { describe, expect, it } from 'vitest'

import type { ArtifactVersionProvenance } from './artifact-provenance'
import {
  buildSealedReproducibilityRecipe,
  compareReproducedFile,
  evaluateArtifactReproduction,
  REPRODUCIBILITY_MAX_COMPARE_BYTES,
  REPRODUCIBILITY_MAX_COMPARED_FILES,
  type ReproducibilityFileComparison,
  type SealedReproducibilityRecipe
} from './reproducibility'

// Fixtures are shaped like the real recorded provenance (see the artifact Provenance repository):
// one notebook-run produced cos.png from a declared upload, inside a fully captured environment.
const provenance = (
  overrides: {
    scriptTruncated?: true
  } = {}
): ArtifactVersionProvenance => ({
  descriptor: {
    id: 'version-1',
    artifactId: 'artifact-1',
    versionId: 'version-1',
    versionNumber: 1,
    checksum: 'a'.repeat(64),
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
    checksum: 'a'.repeat(64),
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
        checksum: 'c'.repeat(64),
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
        sourceVersionNumber: 1,
        sourceCreatedAt: '2026-08-05T23:00:00.000Z',
        sourceProjectId: 'project-1',
        sourceSessionId: 'session-1',
        filename: 'groups.csv',
        contentType: 'text/csv',
        sizeBytes: 20,
        checksum: 'c'.repeat(64),
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
        script: 'import pandas as pd\ndf = pd.read_csv("groups.csv")\nplot(df)',
        ...(overrides.scriptTruncated ? { scriptTruncated: true as const } : {}),
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

const sealedRecipe = (): SealedReproducibilityRecipe =>
  buildSealedReproducibilityRecipe(provenance())

const identicalComparison = (
  overrides: Partial<ReproducibilityFileComparison> = {}
): ReproducibilityFileComparison => ({
  path: '/workspace/rerun/cos.png',
  filename: 'cos.png',
  outcome: 'identical',
  counterpart: 'cos.png',
  expectedSha256: 'a'.repeat(64),
  reproducedSha256: 'a'.repeat(64),
  expectedSizeBytes: 8,
  reproducedSizeBytes: 8,
  ...overrides
})

describe('buildSealedReproducibilityRecipe', () => {
  it('seals a recipe from fully captured provenance', () => {
    const recipe = sealedRecipe()

    expect(recipe.sealed).toBe(true)
    expect(recipe.unsealedReasons).toEqual([])
    expect(recipe.expected).toEqual({ sha256: 'a'.repeat(64), sizeBytes: 8 })
    expect(recipe.identity.filename).toBe('cos.png')
    expect(recipe.inputs).toEqual([
      {
        filename: 'groups.csv',
        sha256: 'c'.repeat(64),
        sizeBytes: 20,
        association: 'resolver-accessed',
        contentAvailable: true
      }
    ])
    expect(recipe.environment?.captureStatus).toBe('complete')
    expect(recipe.environment?.packages).toEqual([
      { name: 'pandas', version: '2.3.1', versionStatus: 'known' }
    ])
    expect(recipe.execution?.runs).toHaveLength(1)
  })

  it('refuses to seal when execution evidence is missing', () => {
    const value = provenance()
    const recipe = buildSealedReproducibilityRecipe({ ...value, execution: undefined })

    expect(recipe.sealed).toBe(false)
    expect(recipe.unsealedReasons).toContain('execution-evidence-missing')
    expect(recipe.execution).toBeNull()
  })

  it('refuses to seal a truncated execution script', () => {
    const recipe = buildSealedReproducibilityRecipe(provenance({ scriptTruncated: true }))

    expect(recipe.sealed).toBe(false)
    expect(recipe.unsealedReasons).toContain('execution-script-truncated')
  })

  it('refuses to seal a partial environment capture', () => {
    const value = provenance()
    const evidence = value.evidence
    if (!evidence.environment) throw new Error('fixture must carry environment evidence')
    const recipe = buildSealedReproducibilityRecipe({
      ...value,
      evidence: {
        ...evidence,
        environment: { ...evidence.environment, capture_status: 'partial', complete: false },
        environment_status: { state: 'partial' }
      }
    })

    expect(recipe.sealed).toBe(false)
    expect(recipe.unsealedReasons).toContain('environment-evidence-incomplete')
  })

  it('refuses to seal when the Version content is unavailable', () => {
    const value = provenance()
    const recipe = buildSealedReproducibilityRecipe({
      ...value,
      contentStatus: { state: 'unavailable', reason: 'checksum-mismatch' }
    })

    expect(recipe.sealed).toBe(false)
    expect(recipe.sealed || recipe.unsealedReasons.includes('input-content-unavailable')).toBe(
      false
    )
    expect(recipe.unsealedReasons).toContain('artifact-content-unavailable')
  })

  it('flags declared inputs whose content is no longer available', () => {
    const value = provenance()
    const execution = value.execution
    if (!execution) throw new Error('fixture must carry execution evidence')
    const recipe = buildSealedReproducibilityRecipe({
      ...value,
      execution: {
        ...execution,
        inputFiles: execution.inputFiles.map((file) => ({
          ...file,
          availability: { state: 'unavailable' as const, reason: 'input-content-missing' as const }
        }))
      }
    })

    expect(recipe.sealed).toBe(false)
    expect(recipe.unsealedReasons).toContain('input-content-unavailable')
    expect(recipe.inputs[0].contentAvailable).toBe(false)
  })
})

describe('compareReproducedFile', () => {
  const counterpart = { filename: 'cos.png', sha256: 'a'.repeat(64), sizeBytes: 8 }
  const observed = {
    state: 'observed' as const,
    path: '/workspace/rerun/cos.png',
    filename: 'cos.png',
    sizeBytes: 8,
    sha256: 'a'.repeat(64)
  }

  it('reports identical bytes as identical', () => {
    expect(compareReproducedFile({ observed, counterpart, alreadyCompared: 0 }).outcome).toBe(
      'identical'
    )
  })

  it('reports a size change before comparing content', () => {
    const comparison = compareReproducedFile({
      observed: { ...observed, sizeBytes: 9 },
      counterpart,
      alreadyCompared: 0
    })

    expect(comparison.outcome).toBe('size-mismatch')
  })

  it('reports equal-size different bytes as a content mismatch', () => {
    const comparison = compareReproducedFile({
      observed: { ...observed, sha256: 'b'.repeat(64) },
      counterpart,
      alreadyCompared: 0
    })

    expect(comparison.outcome).toBe('content-mismatch')
  })

  it('never reports identical when the comparison bound is exceeded', () => {
    const comparison = compareReproducedFile({
      observed: { ...observed, sizeBytes: REPRODUCIBILITY_MAX_COMPARE_BYTES + 1 },
      counterpart,
      alreadyCompared: 0
    })

    expect(comparison.outcome).toBe('not-compared')
    expect(comparison.reason).toBe('comparison-bound-exceeded')
  })

  it('never reports identical when the file count bound is reached', () => {
    const comparison = compareReproducedFile({
      observed,
      counterpart,
      alreadyCompared: REPRODUCIBILITY_MAX_COMPARED_FILES
    })

    expect(comparison.outcome).toBe('not-compared')
    expect(comparison.reason).toBe('comparison-limit-reached')
  })

  it('never reports identical without a counterpart in the recipe', () => {
    const comparison = compareReproducedFile({
      observed,
      counterpart: undefined,
      alreadyCompared: 0
    })

    expect(comparison.outcome).toBe('not-compared')
    expect(comparison.reason).toBe('no-counterpart-in-recipe')
  })

  it('never reports identical when the reproduced file could not be read', () => {
    const comparison = compareReproducedFile({
      observed: {
        state: 'unreadable',
        path: '/workspace/rerun/cos.png',
        filename: 'cos.png',
        reason: 'not-found'
      },
      counterpart,
      alreadyCompared: 0
    })

    expect(comparison.outcome).toBe('not-compared')
    expect(comparison.reason).toBe('reproduction-file-missing')
  })

  it('never reports identical when the reproduction carries no hash', () => {
    const comparison = compareReproducedFile({
      observed: { ...observed, sha256: '' },
      counterpart,
      alreadyCompared: 0
    })

    expect(comparison.outcome).toBe('not-compared')
    expect(comparison.reason).toBe('reproduction-not-hashed')
  })
})

describe('evaluateArtifactReproduction', () => {
  it('never claims reproduction for an unsealed recipe, even with identical bytes', () => {
    const value = provenance()
    const recipe = buildSealedReproducibilityRecipe({ ...value, execution: undefined })
    const evaluation = evaluateArtifactReproduction({
      recipe,
      reexecuted: true,
      comparisons: [identicalComparison()]
    })

    expect(evaluation.verdict).toBe('not-checkable')
    expect(evaluation.verdict).not.toBe('reproduced')
    expect(evaluation.requiredLabels).toContain('recipe-not-sealed')
  })

  it('never claims reproduction without app-owned re-execution', () => {
    const evaluation = evaluateArtifactReproduction({
      recipe: sealedRecipe(),
      reexecuted: false,
      comparisons: [identicalComparison()]
    })

    expect(evaluation.verdict).toBe('bytes-match')
    expect(evaluation.evidenceKind).toBe('external-bytes')
    expect(evaluation.requiredLabels).toContain('external-bytes-no-reexecution')
  })

  it('claims reproduction only when the app re-executed and every file matched', () => {
    const evaluation = evaluateArtifactReproduction({
      recipe: sealedRecipe(),
      reexecuted: true,
      comparisons: [identicalComparison(), identicalComparison({ filename: 'groups.csv' })]
    })

    expect(evaluation.verdict).toBe('reproduced')
    expect(evaluation.evidenceKind).toBe('app-reexecution')
    expect(evaluation.counts).toEqual({ compared: 2, identical: 2, mismatched: 0, notCompared: 0 })
  })

  it('fails the check on a single mismatch', () => {
    const evaluation = evaluateArtifactReproduction({
      recipe: sealedRecipe(),
      reexecuted: true,
      comparisons: [
        identicalComparison(),
        identicalComparison({ filename: 'groups.csv', outcome: 'size-mismatch' })
      ]
    })

    expect(evaluation.verdict).toBe('not-reproduced')
    expect(evaluation.counts.mismatched).toBe(1)
  })

  it('downgrades an incomplete comparison to inconclusive', () => {
    const evaluation = evaluateArtifactReproduction({
      recipe: sealedRecipe(),
      reexecuted: true,
      comparisons: [
        identicalComparison(),
        identicalComparison({
          filename: 'groups.csv',
          outcome: 'not-compared',
          reason: 'comparison-bound-exceeded'
        })
      ]
    })

    expect(evaluation.verdict).toBe('inconclusive')
    expect(evaluation.verdict).not.toBe('reproduced')
    expect(evaluation.requiredLabels).toContain('partial-comparison')
    expect(evaluation.counts.notCompared).toBe(1)
  })

  it('refuses to grade a check that compared nothing', () => {
    const evaluation = evaluateArtifactReproduction({
      recipe: sealedRecipe(),
      reexecuted: true,
      comparisons: []
    })

    expect(evaluation.verdict).toBe('not-checkable')
    expect(evaluation.reasons).toContain('no-reproduced-files')
  })

  it('is deterministic for the same inputs', () => {
    const first = evaluateArtifactReproduction({
      recipe: sealedRecipe(),
      reexecuted: false,
      comparisons: [identicalComparison()]
    })
    const second = evaluateArtifactReproduction({
      recipe: sealedRecipe(),
      reexecuted: false,
      comparisons: [identicalComparison()]
    })

    expect(second).toEqual(first)
  })
})
