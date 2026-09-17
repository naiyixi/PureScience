import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

import type { ArtifactVersionProvenance } from '../../shared/artifact-provenance'
import type { NotebookRunSummary } from '../../shared/notebook'
import { createArtifactReplayAdapter } from './replay-composition'

// The composition is the one place where the app's own notebook run record is projected onto the named
// outcomes the verdict is built from. What it drops there, the verdict can never say — which is exactly
// how a re-run that executed outside the graded workspace came to read "the file was never produced".

const provenanceOf = (): ArtifactVersionProvenance =>
  ({
    evidence: {
      filename: 'out.csv',
      checksum: 'sha256:abc',
      size_bytes: 8,
      reproduction_code: 'print("x")',
      producer: {
        state: 'available',
        kernel_kind: 'python',
        environment_manifest_checksum: 'env-abc'
      },
      inputs: []
    }
  }) as unknown as ArtifactVersionProvenance

const request = {
  projectId: 'project-1',
  appSessionId: 'session-1',
  artifactId: 'artifact-1',
  versionId: 'version-1'
}

const harness = (executeNotebook: ReturnType<typeof vi.fn>) =>
  createArtifactReplayAdapter({
    provenance: {
      getVersionCore: vi.fn().mockResolvedValue(provenanceOf()),
      resolveVersionContent: vi.fn().mockResolvedValue({ path: '/tmp/absent', filename: 'out.csv' })
    },
    executeNotebook: executeNotebook as unknown as (input: unknown) => Promise<NotebookRunSummary>,
    appVersion: () => '1.62.0',
    tempRoot: tmpdir()
  })

describe('artifact replay composition', () => {
  it('carries the directory the run happened in through to the verdict', async () => {
    const executeNotebook = vi.fn().mockResolvedValue({
      status: 'completed',
      text: { stdout: '', stderr: '', traceback: '' },
      cwdBefore: '/data/notebooks/project/session/data',
      cwdAfter: '/data/notebooks/project/session/data'
    } as unknown as NotebookRunSummary)

    const outcome = await harness(executeNotebook).replayVersion(request)

    // The run asks for an isolated workspace. Whether the notebook honors it is a separate question,
    // but the request itself must not quietly become the session's own directory.
    const called = executeNotebook.mock.calls[0]?.[0] as { workspaceCwd: string }
    expect(called.workspaceCwd).toMatch(/ps-replay-/)

    // And the directory the run actually happened in must survive the projection: without it the verdict
    // can only say the file was never produced, which is the one thing that was not true.
    expect(outcome.report.verdict).toBe('unverifiable')
    expect(outcome.report.reasons[0]).toContain('/data/notebooks/project/session/data')
    expect(outcome.report.reasons[0]).toContain('instead of the isolated workspace')
    expect(outcome.report.reasons[0]).not.toContain('nothing to compare')
  })

  it('keeps the unqualified sentence when the run reports no directory', async () => {
    const executeNotebook = vi.fn().mockResolvedValue({
      status: 'completed',
      text: { stdout: '', stderr: '', traceback: '' }
    } as unknown as NotebookRunSummary)

    const outcome = await harness(executeNotebook).replayVersion(request)

    expect(outcome.report.verdict).toBe('unverifiable')
    expect(outcome.report.reasons[0]).toContain('nothing to compare')
  })
})
