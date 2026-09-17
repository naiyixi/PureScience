import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { ArtifactVersionProvenance } from '../../shared/artifact-provenance'
import type { ReplayVersionRequest, ReplayVersionResult } from '../../shared/artifact-replay'
import type { NotebookRunSummary } from '../../shared/notebook'
import { createArtifactReplayAdapter } from './replay-composition'

// The composition is the one place where the app's own notebook run record is projected onto the named
// outcomes the verdict is built from, and where the directory a re-run may execute in is chosen. What it
// drops, or borrows from the recorded session, the verdict can never recover — which is exactly how a
// re-run that executed in that session's own directory came to read "the file was never produced".

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

type ReplayAdapter = {
  replayVersion: (request: ReplayVersionRequest) => Promise<ReplayVersionResult>
}

const notebookSessionFactory = async (): Promise<
  (projectName: string, sessionId: string) => string
> => {
  const root = await mkdtemp(join(tmpdir(), 'ps-composition-test-'))
  return (projectName, sessionId) => join(root, projectName, sessionId, 'data')
}

const harness = async (
  executeNotebook: ReturnType<typeof vi.fn>,
  notebookDataRoot: (projectName: string, sessionId: string) => string,
  extra: {
    readNotebookBindings?: ReturnType<typeof vi.fn>
    bindNotebookRuntime?: ReturnType<typeof vi.fn>
  } = {}
): Promise<{
  adapter: ReplayAdapter
  shutdownNotebookSession: ReturnType<typeof vi.fn>
  bindNotebookRuntime: ReturnType<typeof vi.fn>
}> => {
  const shutdownNotebookSession = vi.fn().mockResolvedValue(undefined)
  const bindNotebookRuntime = extra.bindNotebookRuntime ?? vi.fn().mockResolvedValue(undefined)
  const adapter = createArtifactReplayAdapter({
    provenance: {
      getVersionCore: vi.fn().mockResolvedValue(provenanceOf()),
      resolveVersionContent: vi.fn().mockResolvedValue({ path: '/tmp/absent', filename: 'out.csv' })
    },
    executeNotebook: executeNotebook as unknown as (input: unknown) => Promise<NotebookRunSummary>,
    appVersion: () => '1.62.0',
    notebookDataRoot,
    shutdownNotebookSession,
    bindNotebookRuntime,
    readNotebookBindings: extra.readNotebookBindings
  })
  return { adapter, shutdownNotebookSession, bindNotebookRuntime }
}

// A notebook that runs where it was asked to: the run's own directory comes back unchanged.
const executingInPlace = (): ReturnType<typeof vi.fn> =>
  vi.fn().mockImplementation(async (input: { workspaceCwd: string }) => ({
    status: 'completed',
    text: { stdout: '', stderr: '', traceback: '' },
    cwdBefore: input.workspaceCwd,
    cwdAfter: input.workspaceCwd
  }))

describe('artifact replay composition', () => {
  it('runs the re-run in its own session, in the directory it is graded in', async () => {
    const notebookDataRoot = await notebookSessionFactory()
    const executeNotebook = executingInPlace()
    const { adapter } = await harness(executeNotebook, notebookDataRoot)

    await adapter.replayVersion(request)

    const called = executeNotebook.mock.calls[0]?.[0] as {
      sessionId: string
      workspaceCwd: string
      projectName: string
    }
    // The recorded session is never the one that executes: a re-run must not write into the directory the
    // user's own session is still working in.
    expect(called.sessionId).not.toBe(request.appSessionId)
    expect(called.sessionId).toMatch(/^replay-[0-9a-f]{16}$/)
    expect(called.projectName).toBe(request.projectId)
    // And it executes in the very directory it is graded in. It has to be a session directory, because the
    // app's kernel is spawned into that directory and cannot be told to run in a temp folder instead.
    expect(called.workspaceCwd).toBe(notebookDataRoot(request.projectId, called.sessionId))
  })

  it('shuts that session down and removes its directory once the verdict is built', async () => {
    const notebookDataRoot = await notebookSessionFactory()
    const executeNotebook = executingInPlace()
    const { adapter, shutdownNotebookSession } = await harness(executeNotebook, notebookDataRoot)

    await adapter.replayVersion(request)

    const called = executeNotebook.mock.calls[0]?.[0] as { sessionId: string; workspaceCwd: string }
    expect(shutdownNotebookSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: request.projectId,
        sessionId: called.sessionId,
        workspaceCwd: called.workspaceCwd
      })
    )
    expect(existsSync(called.workspaceCwd)).toBe(false)
  })

  it('starts the re-run in the runtime the recorded session used', async () => {
    const notebookDataRoot = await notebookSessionFactory()
    const executeNotebook = executingInPlace()
    const readNotebookBindings = vi.fn().mockResolvedValue({
      python: {
        language: 'python',
        runtimeId: '/data/runtime/envs/default-python/bin/python3.12',
        source: 'managed',
        label: 'conda: default-python'
      }
    })
    const { adapter, bindNotebookRuntime } = await harness(executeNotebook, notebookDataRoot, {
      readNotebookBindings
    })

    await adapter.replayVersion(request)

    const called = executeNotebook.mock.calls[0]?.[0] as { sessionId: string; workspaceCwd: string }
    expect(bindNotebookRuntime).toHaveBeenCalledWith({
      projectName: request.projectId,
      sessionId: called.sessionId,
      workspaceCwd: called.workspaceCwd,
      language: 'python',
      runtimeId: '/data/runtime/envs/default-python/bin/python3.12'
    })
    // The binding has to be in place before the first cell runs, or the kernel is already the wrong one.
    expect(bindNotebookRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      executeNotebook.mock.invocationCallOrder[0]!
    )
    // It is read from the RECORDED session, not from the re-run's own.
    expect(readNotebookBindings).toHaveBeenCalledWith({
      projectName: request.projectId,
      sessionId: request.appSessionId
    })
  })

  it('still runs, unbound, when the recorded session left no bindings behind', async () => {
    const notebookDataRoot = await notebookSessionFactory()
    const executeNotebook = executingInPlace()
    const readNotebookBindings = vi.fn().mockResolvedValue(undefined)
    const { adapter, bindNotebookRuntime } = await harness(executeNotebook, notebookDataRoot, {
      readNotebookBindings
    })

    const outcome = await adapter.replayVersion(request)

    expect(bindNotebookRuntime).not.toHaveBeenCalled()
    expect(executeNotebook).toHaveBeenCalledTimes(1)
    // And the verdict must not claim an environment it never pinned.
    expect(outcome.environmentLock).toBe('not-applied')
  })

  it('carries the directory the run happened in through to the verdict', async () => {
    const notebookDataRoot = await notebookSessionFactory()
    // A notebook that ignores the directory it was asked for is what the app did until this change, so the
    // verdict must still be able to say where the code really ran.
    const executeNotebook = vi.fn().mockResolvedValue({
      status: 'completed',
      text: { stdout: '', stderr: '', traceback: '' },
      cwdBefore: '/data/notebooks/project/session/data',
      cwdAfter: '/data/notebooks/project/session/data'
    } as unknown as NotebookRunSummary)
    const { adapter } = await harness(executeNotebook, notebookDataRoot)

    const outcome = await adapter.replayVersion(request)

    expect(outcome.report.verdict).toBe('unverifiable')
    expect(outcome.report.reasons[0]).toContain('/data/notebooks/project/session/data')
    expect(outcome.report.reasons[0]).toContain('instead of the isolated workspace')
    expect(outcome.report.reasons[0]).not.toContain('nothing to compare')
  })

  it('keeps the unqualified sentence when the run reports no directory', async () => {
    const notebookDataRoot = await notebookSessionFactory()
    const executeNotebook = vi.fn().mockResolvedValue({
      status: 'completed',
      text: { stdout: '', stderr: '', traceback: '' }
    } as unknown as NotebookRunSummary)
    const { adapter } = await harness(executeNotebook, notebookDataRoot)

    const outcome = await adapter.replayVersion(request)

    expect(outcome.report.verdict).toBe('unverifiable')
    expect(outcome.report.reasons[0]).toContain('nothing to compare')
  })
})
